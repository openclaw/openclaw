/**
 * Venice E2EE stream wrapper.
 *
 * Encrypts outgoing messages (system prompt + all conversation turns) and
 * decrypts incoming `text_delta` / `text_end` events so the agent runtime
 * sees plaintext while the wire traffic is fully encrypted.
 *
 * Protocol: ECDH (secp256k1) key exchange → HKDF-SHA256 → AES-256-GCM.
 * Each response chunk uses a per-chunk server ephemeral key.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  streamSimple,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
} from "@mariozechner/pi-ai";
import { createVeniceE2EE, encryptMessage, decryptChunk, type E2EESession } from "venice-e2ee";

// ── Module-level session cache ──────────────────────────────────────────────

interface E2EEInstance {
  createSession: (modelId: string) => Promise<E2EESession>;
  clearSession: () => void;
}

const _e2eeCache = new Map<string, E2EEInstance>();

function getE2EE(apiKey: string): E2EEInstance {
  let instance = _e2eeCache.get(apiKey);
  if (!instance) {
    instance = createVeniceE2EE({ apiKey });
    _e2eeCache.set(apiKey, instance);
  }
  return instance;
}

// ── Public wrapper ──────────────────────────────────────────────────────────

export function isVeniceE2EEModel(modelId: string): boolean {
  return modelId.startsWith("e2ee-");
}

/**
 * Wraps a base StreamFn with Venice E2EE encryption/decryption.
 *
 * - Encrypts `context.systemPrompt` and all message text blocks before the
 *   request leaves the process.
 * - Adds `X-Venice-TEE-*` headers and `venice_parameters.enable_e2ee`.
 * - Decrypts every `text_delta` / `text_end` event in the response stream
 *   using per-chunk ECDH key derivation.
 */
export function createVeniceE2EEStreamWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;

  return async (model, context, options) => {
    const apiKey = options?.apiKey;
    if (!apiKey) {
      return underlying(model, context, options);
    }

    // ── Establish E2EE session (fetches TEE attestation, derives keys) ───
    const e2ee = getE2EE(apiKey);
    let session: E2EESession;
    try {
      session = await e2ee.createSession(model.id);
    } catch (err) {
      throw new Error(
        `Venice E2EE setup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to send plaintext to an E2EE model.`,
        { cause: err },
      );
    }

    // ── Encrypt context ─────────────────────────────────────────────────
    const encryptedContext = await encryptContext(context, session);

    // ── Call underlying with E2EE headers ────────────────────────────────
    const originalOnPayload = options?.onPayload;
    const sourceStream = await underlying(model, encryptedContext, {
      ...options,
      headers: {
        ...options?.headers,
        "X-Venice-TEE-Client-Pub-Key": session.pubKeyHex,
        "X-Venice-TEE-Model-Pub-Key": session.modelPubKeyHex,
        "X-Venice-TEE-Signing-Algo": "ecdsa",
      },
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          p.venice_parameters = {
            ...(p.venice_parameters && typeof p.venice_parameters === "object"
              ? (p.venice_parameters as Record<string, unknown>)
              : {}),
            enable_e2ee: true,
          };
        }
        return originalOnPayload?.(payload, model);
      },
    });

    // ── Wrap response stream: decrypt text deltas ───────────────────────
    const resultStream = createAssistantMessageEventStream();
    const decryptedAccum = new Map<number, string>();

    void (async () => {
      try {
        for await (const event of sourceStream) {
          resultStream.push(await decryptEvent(event, session, decryptedAccum));
        }
      } finally {
        resultStream.end();
      }
    })();

    return resultStream;
  };
}

// ── Encrypt outgoing context ────────────────────────────────────────────────

async function encryptContext(context: Context, session: E2EESession): Promise<Context> {
  const encryptedSystemPrompt = context.systemPrompt
    ? await encryptMessage(session.aesKey, session.publicKey, context.systemPrompt)
    : undefined;

  const encryptedMessages = await Promise.all(
    context.messages.map(async (msg) => {
      if (!("content" in msg) || !Array.isArray(msg.content)) {
        return msg;
      }
      return {
        ...msg,
        content: await Promise.all(
          (msg.content as Array<{ type: string; text?: string }>).map(async (block) => {
            if (block.type !== "text" || typeof block.text !== "string") {
              return block;
            }
            return {
              ...block,
              text: await encryptMessage(session.aesKey, session.publicKey, block.text),
            };
          }),
        ),
      };
    }),
  );

  return {
    ...context,
    systemPrompt: encryptedSystemPrompt,
    messages: encryptedMessages as Context["messages"],
  };
}

// ── Decrypt incoming events ─────────────────────────────────────────────────

async function decryptEvent(
  event: AssistantMessageEvent,
  session: E2EESession,
  accum: Map<number, string>,
): Promise<AssistantMessageEvent> {
  if (event.type === "text_delta") {
    const decrypted = await decryptChunk(session.privateKey, event.delta);
    const accumulated = (accum.get(event.contentIndex) || "") + decrypted;
    accum.set(event.contentIndex, accumulated);
    return {
      ...event,
      delta: decrypted,
      partial: patchPartialText(event.partial, event.contentIndex, accumulated),
    };
  }

  if (event.type === "text_end") {
    const accumulated = accum.get(event.contentIndex) || event.content;
    return {
      ...event,
      content: accumulated,
      partial: patchPartialText(event.partial, event.contentIndex, accumulated),
    };
  }

  if (event.type === "done") {
    return { ...event, message: patchAllPartialText(event.message, accum) };
  }

  if (event.type === "error") {
    return { ...event, error: patchAllPartialText(event.error, accum) };
  }

  return event;
}

function patchPartialText(
  partial: AssistantMessage,
  contentIndex: number,
  decryptedText: string,
): AssistantMessage {
  const content = [...partial.content];
  const block = content[contentIndex];
  if (block && block.type === "text") {
    content[contentIndex] = { ...block, text: decryptedText };
  }
  return { ...partial, content };
}

function patchAllPartialText(
  message: AssistantMessage,
  accum: Map<number, string>,
): AssistantMessage {
  const content = message.content.map((block, i) => {
    if (block.type === "text" && accum.has(i)) {
      return { ...block, text: accum.get(i)! };
    }
    return block;
  });
  return { ...message, content };
}
