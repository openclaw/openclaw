// Feishu tests cover monitor.webhook e2e plugin behavior.
import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import {
  buildWebhookConfig,
  getFreePort,
  waitUntilServerReady,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";
import type { FeishuMessageContext } from "./types.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const mockDownloadMessageResourceFeishu = vi.hoisted(() => vi.fn());
const mockTranscribeFirstAudio = vi.hoisted(() => vi.fn());
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const mockCreateFeishuReplyDispatcher = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createEventDispatcher: createEventDispatcherMock,
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("./media.js", () => ({
  saveMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: mockTranscribeFirstAudio,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { httpServers } from "./monitor.state.js";
import { setFeishuRuntime } from "./runtime.js";

beforeAll(async () => {
  await import("./monitor.account.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  createEventDispatcherMock.mockImplementation(() => createWebhookEventDispatcher());
  mockCreateFeishuReplyDispatcher.mockReset().mockReturnValue({
    dispatcher: {
      sendToolResult: vi.fn(),
      sendBlockReply: vi.fn(),
      sendFinalReply: vi.fn(),
      waitForIdle: vi.fn(),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    ensureNoVisibleReplyFallback: vi.fn(),
  });
  mockDownloadMessageResourceFeishu.mockReset();
  mockTranscribeFirstAudio.mockReset();
  setFeishuRuntime({
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
        }),
      },
      commands: {
        isControlCommandMessage: () => false,
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  } as unknown as PluginRuntime);
});

function signFeishuPayload(params: {
  encryptKey: string;
  rawBody: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? "1711111111";
  const nonce = params.nonce ?? "nonce-test";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + params.encryptKey + params.rawBody)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

async function postSignedPayload(url: string, payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return await fetch(url, {
    method: "POST",
    headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
    body: rawBody,
  });
}

type ObservedInboundContext = Record<string, unknown> & {
  BodyForAgent?: string;
  CommandBody?: string;
  MediaPaths?: string[];
  MediaTranscribedIndexes?: number[];
  MediaTypes?: string[];
  RawBody?: string;
  Transcript?: string;
};

type FeishuWebhookHandler = (event: unknown) => Promise<void> | void;

function createWebhookEventDispatcher() {
  const handlers = new Map<string, FeishuWebhookHandler>();
  return {
    register: (registered: Record<string, FeishuWebhookHandler>) => {
      for (const [eventType, handler] of Object.entries(registered)) {
        handlers.set(eventType, handler);
      }
    },
    invoke: async (payload: Record<string, unknown>) => {
      const eventType = (payload.header as { event_type?: string } | undefined)?.event_type;
      const handler = eventType ? handlers.get(eventType) : undefined;
      if (!handler) {
        return `no ${eventType ?? "unknown"} event handle`;
      }
      await handler(payload.event);
      return {};
    },
  };
}

function createWebhookProofRuntime(params: {
  cfg: ClawdbotConfig;
  observedContexts: ObservedInboundContext[];
}): PluginRuntime {
  const recordInboundSession = vi.fn(async ({ ctx }: { ctx: ObservedInboundContext }) => {
    params.observedContexts.push(ctx);
  });
  return {
    config: { current: vi.fn(() => params.cfg) },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          channel: "feishu",
          accountId: "webhook-audio-proof",
          sessionKey: "agent:main:feishu:direct:ou_audio_sender",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "binding.peer",
        })),
      },
      session: {
        readSessionUpdatedAt: vi.fn(),
        resolveStorePath: vi.fn(() => "/tmp/feishu-webhook-proof-sessions.json"),
        recordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn((envelope: { body: string }) => envelope.body),
        finalizeInboundContext: vi.fn((ctx: ObservedInboundContext) => ctx),
        dispatchReplyFromConfig: vi
          .fn()
          .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
        withReplyDispatcher: vi.fn(async ({ run, onSettled }) => {
          try {
            return await run();
          } finally {
            await onSettled?.();
          }
        }),
        settleReplyDispatcher: vi.fn(async ({ onSettled }) => {
          await onSettled?.();
        }),
        resolveHumanDelayConfig: vi.fn(() => undefined),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
      },
      text: {
        resolveTextChunkLimit: vi.fn(() => 4000),
        resolveChunkMode: vi.fn(() => "hard"),
        resolveMarkdownTableMode: vi.fn(() => "preserve"),
        chunkTextWithMode: vi.fn((text: string) => [text]),
        chunkText: vi.fn((text: string) => [text]),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      media: {
        saveMediaBuffer: vi.fn(async (buffer, contentType) => ({
          id: "inbound-voice.ogg",
          path: "/tmp/inbound-voice.ogg",
          size: Buffer.isBuffer(buffer) ? buffer.byteLength : 0,
          contentType,
        })),
      },
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 0),
        createInboundDebouncer: vi.fn((options) => ({
          enqueue: async (event: unknown) => {
            await options.onFlush([event as never]);
          },
          flushKey: vi.fn(),
          cancelKey: vi.fn(() => false),
        })),
      },
      inbound: {
        run: vi.fn(async ({ raw, adapter }) => {
          const input = await adapter.ingest(raw as FeishuMessageContext);
          const turn = await adapter.resolveTurn(input, {
            kind: "message",
            canStartAgentTurn: true,
          });
          await turn.recordInboundSession({
            storePath: turn.storePath,
            sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            dispatched: true,
            dispatchResult: await turn.runDispatch(),
          };
        }),
      },
    },
    media: {
      detectMime: vi.fn(async () => "application/octet-stream"),
    },
  } as unknown as PluginRuntime;
}

afterEach(async () => {
  await stopFeishuMonitor();
});

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

describe("Feishu webhook signed-request e2e", () => {
  it("waits for HTTP close before resolving webhook abort cleanup", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const accountId = "abort-delayed-close";
    const path = "/hook-e2e-abort-delayed-close";
    const port = await getFreePort();
    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildWebhookConfig({
        accountId,
        path,
        port,
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      accountId,
    });
    await waitUntilServerReady(`http://127.0.0.1:${port}${path}`);

    const server = httpServers.get(accountId);
    expect(server).toBeDefined();
    if (!server) {
      throw new Error("expected webhook server to be tracked");
    }

    const originalClose = server.close.bind(server);
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeSpy = vi.fn((callback?: (err?: Error) => void) => {
      void closeGate.then(() => {
        originalClose(callback);
      });
      return server;
    });
    server.close = closeSpy as unknown as Server["close"];

    let monitorSettled = false;
    const observedMonitorPromise = monitorPromise.finally(() => {
      monitorSettled = true;
    });

    try {
      abortController.abort();
      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });
      expect(monitorSettled).toBe(false);
      expect(httpServers.get(accountId)).toBe(server);

      releaseClose?.();
      await observedMonitorPromise;

      expect(httpServers.has(accountId)).toBe(false);
    } finally {
      releaseClose?.();
    }
  });

  it("rejects webhook monitor when abort cleanup close fails", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const accountId = "abort-close-fails";
    const path = "/hook-e2e-abort-close-fails";
    const port = await getFreePort();
    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildWebhookConfig({
        accountId,
        path,
        port,
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      accountId,
    });
    await waitUntilServerReady(`http://127.0.0.1:${port}${path}`);

    const server = httpServers.get(accountId);
    expect(server).toBeDefined();
    if (!server) {
      throw new Error("expected webhook server to be tracked");
    }

    const originalClose = server.close.bind(server);
    server.close = vi.fn((callback?: (err?: Error) => void) => {
      originalClose(() => {
        callback?.(new Error("close failed"));
      });
      return server;
    }) as unknown as Server["close"];

    abortController.abort();
    await expect(monitorPromise).rejects.toThrow("close failed");
    expect(httpServers.has(accountId)).toBe(false);
  });

  it("rejects invalid signatures with 401 instead of empty 200", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-signature",
        path: "/hook-e2e-invalid-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const rawBody = JSON.stringify(payload);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...signFeishuPayload({ encryptKey: "wrong_key", rawBody }),
          },
          body: rawBody,
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects missing signature headers with 401", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "missing-signature",
        path: "/hook-e2e-missing-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "url_verification", challenge: "challenge-token" }),
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("rejects malformed short signatures with 401", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "short-signature",
        path: "/hook-e2e-short-signature",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const headers = signFeishuPayload({
          encryptKey: "encrypt_key",
          rawBody: JSON.stringify(payload),
        });
        headers["x-lark-signature"] = headers["x-lark-signature"].slice(0, 12);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 401 for unsigned invalid json before parsing", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "invalid-json",
        path: "/hook-e2e-invalid-json",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        });

        expect(response.status).toBe(401);
        expect(await response.text()).toBe("Invalid signature");
      },
    );
  });

  it("returns 400 for signed invalid json after signature validation", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-invalid-json",
        path: "/hook-e2e-signed-invalid-json",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const rawBody = "{not-json";
        const response = await fetch(url, {
          method: "POST",
          headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
          body: rawBody,
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid JSON");
      },
    );
  });

  it("accepts signed plaintext url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-challenge",
        path: "/hook-e2e-signed-challenge",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ challenge: "challenge-token" });
      },
    );
  });

  it("accepts signed non-challenge events and reaches the dispatcher", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "signed-dispatch",
        path: "/hook-e2e-signed-dispatch",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          schema: "2.0",
          header: { event_type: "unknown.event" },
          event: {},
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("no unknown.event event handle");
      },
    );
  });

  it("routes uppercase audio MIME webhook events through audio preflight", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    mockDownloadMessageResourceFeishu.mockResolvedValue({
      buffer: Buffer.from("voice"),
      contentType: "AUDIO/OGG",
      fileName: "voice.ogg",
    });
    mockTranscribeFirstAudio.mockResolvedValue("live webhook transcript");

    const accountId = "webhook-audio-proof";
    const cfg = buildWebhookConfig({
      accountId,
      path: "/hook-e2e-audio-uppercase-mime",
      port: await getFreePort(),
      verificationToken: "verify_token",
      encryptKey: "encrypt_key",
    });
    const feishuAccount = cfg.channels?.feishu?.accounts?.[accountId] as Record<string, unknown>;
    feishuAccount.dmPolicy = "open";
    feishuAccount.allowFrom = ["*"];
    feishuAccount.resolveSenderNames = false;
    const observedContexts: ObservedInboundContext[] = [];
    setFeishuRuntime(createWebhookProofRuntime({ cfg, observedContexts }));

    const abortController = new AbortController();
    const runtimeError = vi.fn();
    const monitorPromise = monitorFeishuProvider({
      config: cfg,
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      abortSignal: abortController.signal,
      accountId,
    });
    const url = `http://127.0.0.1:${String(feishuAccount.webhookPort)}${String(feishuAccount.webhookPath)}`;

    try {
      await waitUntilServerReady(url);
      const response = await postSignedPayload(url, {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          sender: {
            sender_id: { open_id: "ou_audio_sender" },
            sender_type: "user",
          },
          message: {
            message_id: "msg-webhook-audio-uppercase-mime",
            chat_id: "oc_audio_dm",
            chat_type: "p2p",
            message_type: "audio",
            content: JSON.stringify({ file_key: "file_audio_payload", duration: 1200 }),
          },
        },
      });

      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        if (runtimeError.mock.calls.length > 0) {
          throw new Error(JSON.stringify(runtimeError.mock.calls));
        }
        expect(observedContexts).toHaveLength(1);
      });
      expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          fileKey: "file_audio_payload",
          messageId: "msg-webhook-audio-uppercase-mime",
          type: "file",
        }),
      );
      expect(mockTranscribeFirstAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            ChatType: "direct",
            MediaPaths: ["/tmp/inbound-voice.ogg"],
            MediaTypes: ["AUDIO/OGG"],
          }),
        }),
      );
      expect(observedContexts[0]).toEqual(
        expect.objectContaining({
          CommandBody: "live webhook transcript",
          MediaPaths: ["/tmp/inbound-voice.ogg"],
          MediaTranscribedIndexes: [0],
          MediaTypes: ["AUDIO/OGG"],
          RawBody: "live webhook transcript",
          Transcript: "live webhook transcript",
        }),
      );
    } finally {
      abortController.abort();
      await monitorPromise.catch(() => undefined);
    }
  });

  it("does not emit unhandled-event warning for bot_p2p_chat_entered_v1", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "p2p-chat-entered",
        path: "/hook-e2e-p2p-chat-entered",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          schema: "2.0",
          header: { event_type: "im.chat.access_event.bot_p2p_chat_entered_v1" },
          event: {},
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).not.toContain("no im.chat.access_event.bot_p2p_chat_entered_v1 event handle");
      },
    );
  });

  it("accepts signed encrypted url_verification challenges end-to-end", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    await withRunningWebhookMonitor(
      {
        accountId: "encrypted-challenge",
        path: "/hook-e2e-encrypted-challenge",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          encrypt: encryptFeishuPayload("encrypt_key", {
            type: "url_verification",
            challenge: "encrypted-challenge-token",
          }),
        };
        const response = await postSignedPayload(url, payload);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          challenge: "encrypted-challenge-token",
        });
      },
    );
  });
});
