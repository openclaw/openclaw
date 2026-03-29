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

// ── Attestation reporting ───────────────────────────────────────────────────

function formatAttestationBanner(session: E2EESession): string {
  const a = session.attestation;
  const check = (ok: boolean | null | undefined) =>
    ok === true ? "pass" : ok === false ? "FAIL" : "n/a";

  const lines = [
    "--- Venice E2EE attestation ---",
    `Model:              ${session.modelId}`,
    `Nonce binding:      ${check(a?.nonceVerified)}`,
    `Signing key bound:  ${check(a?.signingKeyBound)}`,
    `Debug mode:         ${a?.debugMode ? "ON (UNTRUSTED)" : "off"}`,
    `Server TDX valid:   ${check(a?.serverTdxValid)}`,
  ];

  if (a?.dcap) {
    lines.push(`DCAP TCB status:    ${a.dcap.status}`);
    if (a.dcap.advisoryIds.length > 0) {
      lines.push(`DCAP advisories:    ${a.dcap.advisoryIds.join(", ")}`);
    }
  }

  lines.push(
    `Client pub key:     ${session.pubKeyHex.slice(0, 16)}...${session.pubKeyHex.slice(-8)}`,
    `Model pub key:      ${session.modelPubKeyHex.slice(0, 16)}...${session.modelPubKeyHex.slice(-8)}`,
    `Session created:    ${new Date(session.created).toISOString()}`,
    `Encryption:         ECDH secp256k1 + HKDF-SHA256 + AES-256-GCM`,
  );

  if (a?.errors && a.errors.length > 0) {
    lines.push(`Errors:             ${a.errors.join("; ")}`);
  }

  lines.push("-------------------------------");
  return lines.join("\n");
}

function logAttestation(session: E2EESession): void {
  const a = session.attestation;
  if (!a) {
    console.warn(
      "[venice-e2ee] E2EE session established without attestation data (verification disabled?)",
    );
    return;
  }

  const summary = [
    `model=${session.modelId}`,
    `nonce=${a.nonceVerified ? "ok" : "FAIL"}`,
    `sigKey=${a.signingKeyBound ? "ok" : "FAIL"}`,
    `debug=${a.debugMode ? "ON" : "off"}`,
    `serverTDX=${a.serverTdxValid === true ? "ok" : a.serverTdxValid === false ? "FAIL" : "n/a"}`,
  ];
  if (a.dcap) {
    summary.push(`dcap=${a.dcap.status}`);
  }

  console.log(`[venice-e2ee] E2EE session established (${summary.join(", ")})`);

  if (a.errors.length > 0) {
    for (const err of a.errors) {
      console.error(`[venice-e2ee] attestation error: ${err}`);
    }
  }
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
 * - Logs attestation details and injects a verification banner into the
 *   response so the user can verify E2EE is active.
 */
export function createVeniceE2EEStreamWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;

  return async (model, context, options) => {
    const apiKey = options?.apiKey;
    if (!apiKey) {
      throw new Error(
        "Venice E2EE requires an API key. Refusing to send plaintext to an E2EE model.",
      );
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

    // ── Log attestation results ──────────────────────────────────────────
    logAttestation(session);

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

    // ── Wrap response stream: inject banner + decrypt text deltas ────────
    const resultStream = createAssistantMessageEventStream();
    const decryptedAccum = new Map<number, string>();
    const banner = formatAttestationBanner(session);

    void (async () => {
      let bannerInjected = false;
      try {
        for await (const event of sourceStream) {
          // Inject attestation banner before the first text content
          if (!bannerInjected && event.type === "text_delta") {
            bannerInjected = true;
            const bannerDelta = banner + "\n\n";
            const decrypted = await decryptChunk(session.privateKey, event.delta);
            const fullAccum = bannerDelta + decrypted;
            decryptedAccum.set(event.contentIndex, fullAccum);
            resultStream.push({
              ...event,
              delta: bannerDelta,
              partial: patchPartialText(event.partial, event.contentIndex, bannerDelta),
            });
            resultStream.push({
              ...event,
              delta: decrypted,
              partial: patchPartialText(event.partial, event.contentIndex, fullAccum),
            });
            continue;
          }
          resultStream.push(await decryptEvent(event, session, decryptedAccum));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resultStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [{ type: "text", text: `E2EE decryption failed: ${message}` }],
          },
        } as AssistantMessageEvent);
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
