// WhatsApp plugin verifies retry identity at the real Baileys relay boundary.
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BinaryNode, WASocket } from "baileys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppAttachedSocketSession } from "./inbound/socket-session.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

type MessagesSocketModule = typeof import("baileys/lib/Socket/messages-send.js");

const PROOF_SOCKET_FACTORY = "openclaw.test.baileys-proof-socket-factory";

const transport = vi.hoisted(() => ({
  attempts: [] as BinaryNode[],
  sendNode: vi.fn(async (node: BinaryNode) => {
    transport.attempts.push(node);
    if (transport.attempts.length === 1) {
      throw new Error("operation timed out after socket write");
    }
  }),
}));

function createBaileysSocketBase() {
  const creds = {
    me: { id: "123:1@s.whatsapp.net", lid: "123@lid" },
  };
  const keys = {
    transaction: async (work: () => Promise<unknown>) => await work(),
    get: async (type: string, ids: string[]) =>
      type === "tctoken"
        ? Object.fromEntries(
            ids.map((id) => [
              id,
              { token: Buffer.alloc(0), senderTimestamp: Math.floor(Date.now() / 1000) },
            ]),
          )
        : {},
    set: async () => undefined,
  };
  const signalRepository = {
    lidMapping: {
      getLIDForPN: async () => undefined,
      getPNForLID: async () => undefined,
      getLIDsForPNs: async () => [],
      storeLIDPNMappings: async () => undefined,
    },
  };
  return {
    authState: { creds, keys },
    ev: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    fetchAccountReachoutTimelock: async () => ({ isActive: false }),
    fetchPrivacySettings: async () => ({ readreceipts: "all" }),
    groupMetadata: async () => ({ participants: [] }),
    groupToggleEphemeral: async () => undefined,
    messageMutex: { mutex: async (work: () => Promise<unknown>) => await work() },
    query: async () => undefined,
    readMessages: async () => undefined,
    registerSocketEndHandler: vi.fn(),
    sendNode: transport.sendNode,
    sendPresenceUpdate: async () => undefined,
    serverProps: { privacyTokenOn1to1: false, lidTrustedTokenIssueToLid: false },
    signalRepository,
    updateMediaMessage: async () => undefined,
    upsertMessage: async () => undefined,
    user: creds.me,
    executeUSyncQuery: async () => undefined,
  };
}

async function loadMessagesSocketWithInjectedTransport(): Promise<{
  makeMessagesSocket: MessagesSocketModule["makeMessagesSocket"];
  cleanup: () => void;
}> {
  const require = createRequire(import.meta.url);
  const moduleUrl = `${pathToFileURL(require.resolve("baileys/lib/Socket/messages-send.js")).href}?openclaw-transport-proof`;
  const replacementUrl = "openclaw-test:baileys-newsletter-socket";
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "./newsletter.js" && context.parentURL === moduleUrl) {
        return { url: replacementUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === replacementUrl) {
        return {
          format: "module",
          source: `export const makeNewsletterSocket = () => globalThis[Symbol.for("${PROOF_SOCKET_FACTORY}")]();`,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  Reflect.set(globalThis, Symbol.for(PROOF_SOCKET_FACTORY), createBaileysSocketBase);
  const cleanup = () => {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, Symbol.for(PROOF_SOCKET_FACTORY));
  };
  try {
    const loaded = (await import(moduleUrl)) as MessagesSocketModule;
    return { makeMessagesSocket: loaded.makeMessagesSocket, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function createLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return logger;
}

describe("WhatsApp retry identity at the Baileys transport boundary", () => {
  beforeEach(() => {
    transport.attempts.length = 0;
    transport.sendNode.mockClear();
  });

  it("reuses one relay id after an ambiguous transport write", async () => {
    const logger = createLogger();
    const loaded = await loadMessagesSocketWithInjectedTransport();
    let sock: WASocket;
    try {
      sock = loaded.makeMessagesSocket({
        logger,
        linkPreviewImageThumbnailWidth: 192,
        generateHighQualityLinkPreview: false,
        options: {},
        patchMessageBeforeSending: (message: unknown) => message,
        enableRecentMessageCache: false,
        maxMsgRetryCount: 5,
      } as never) as WASocket;
    } finally {
      loaded.cleanup();
    }
    const session = await createWhatsAppAttachedSocketSession({
      sock,
      socketRef: { current: sock },
      accountId: "default",
      authDir: join(tmpdir(), "openclaw-baileys-transport-proof"),
      socketTiming: DEFAULT_WHATSAPP_SOCKET_TIMING,
      shouldRetryDisconnect: () => true,
      disconnectRetryPolicy: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
        maxAttempts: 2,
      },
      logVerbose: () => undefined,
      logConnectionError: () => undefined,
    });

    const recovered = await session.sendTrackedMessage("999@s.whatsapp.net", { text: "pong" });
    const next = await session.sendTrackedMessage("999@s.whatsapp.net", { text: "next" });

    const relayIds = transport.attempts.map((node) => node.attrs.id);
    expect(relayIds).toHaveLength(3);
    expect(relayIds[0]).toBe(relayIds[1]);
    expect(relayIds[2]).not.toBe(relayIds[0]);
    expect(recovered?.key.id).toBe(relayIds[0]);
    expect(next?.key.id).toBe(relayIds[2]);
  });
});
