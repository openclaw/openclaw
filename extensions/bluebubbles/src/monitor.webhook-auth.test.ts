import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { fetchBlueBubblesHistory } from "./history.js";
import {
  handleBlueBubblesWebhookRequest,
  registerBlueBubblesWebhookTarget,
  resolveBlueBubblesMessageId,
  _resetBlueBubblesShortIdState,
} from "./monitor.js";
import { setBlueBubblesRuntime } from "./runtime.js";

// Mock dependencies
vi.mock("./send.js", () => ({
  resolveChatGuidForTarget: vi.fn().mockResolvedValue("iMessage;-;+15551234567"),
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
}));

vi.mock("./chat.js", () => ({
  markBlueBubblesChatRead: vi.fn().mockResolvedValue(undefined),
  sendBlueBubblesTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./attachments.js", () => ({
  downloadBlueBubblesAttachment: vi.fn().mockResolvedValue({
    buffer: Buffer.from("test"),
    contentType: "image/jpeg",
  }),
}));

vi.mock("./reactions.js", async () => {
  const actual = await vi.importActual<typeof import("./reactions.js")>("./reactions.js");
  return {
    ...actual,
    sendBlueBubblesReaction: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./history.js", () => ({
  fetchBlueBubblesHistory: vi.fn().mockResolvedValue({ entries: [], resolved: true }),
}));

// Mock runtime
const mockEnqueueSystemEvent = vi.fn();
const mockBuildPairingReply = vi.fn(() => "Pairing code: TESTCODE");
const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "TESTCODE", created: true });
const mockResolveAgentRoute = vi.fn(() => ({
  agentId: "main",
  channel: "bluebubbles",
  accountId: "default",
  sessionKey: "agent:main:bluebubbles:dm:+15551234567",
  mainSessionKey: "agent:main:main",
  matchedBy: "default",
}));
const mockBuildMentionRegexes = vi.fn(() => [/\bbert\b/i]);
const mockMatchesMentionPatterns = vi.fn((text: string, regexes: RegExp[]) =>
  regexes.some((r) => r.test(text)),
);
const mockMatchesMentionWithExplicit = vi.fn(
  (params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) => {
    if (params.explicitWasMentioned) {
      return true;
    }
    return params.mentionRegexes.some((regex) => regex.test(params.text));
  },
);
const mockResolveRequireMention = vi.fn(() => false);
const mockResolveGroupPolicy = vi.fn(() => "open" as const);
type DispatchReplyParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn(
  async (_params: DispatchReplyParams) => EMPTY_DISPATCH_RESULT,
);
const mockHasControlCommand = vi.fn(() => false);
const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: Buffer.byteLength("test"),
  contentType: "image/jpeg",
});
const mockResolveStorePath = vi.fn(() => "/tmp/sessions.json");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({}));
const mockFormatAgentEnvelope = vi.fn((opts: { body: string }) => opts.body);
const mockFormatInboundEnvelope = vi.fn((opts: { body: string }) => opts.body);
const mockChunkMarkdownText = vi.fn((text: string) => [text]);
const mockChunkByNewline = vi.fn((text: string) => (text ? [text] : []));
const mockChunkTextWithMode = vi.fn((text: string) => (text ? [text] : []));
const mockChunkMarkdownTextWithMode = vi.fn((text: string) => (text ? [text] : []));
const mockResolveChunkMode = vi.fn(() => "length" as const);
const mockFetchBlueBubblesHistory = vi.mocked(fetchBlueBubblesHistory);

function createMockRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    system: {
      enqueueSystemEvent: mockEnqueueSystemEvent,
    },
    channel: {
      text: {
        chunkMarkdownText: mockChunkMarkdownText,
        chunkByNewline: mockChunkByNewline,
        chunkMarkdownTextWithMode: mockChunkMarkdownTextWithMode,
        chunkTextWithMode: mockChunkTextWithMode,
        resolveChunkMode:
          mockResolveChunkMode as unknown as PluginRuntime["channel"]["text"]["resolveChunkMode"],
        hasControlCommand: mockHasControlCommand,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher:
          mockDispatchReplyWithBufferedBlockDispatcher as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        formatAgentEnvelope: mockFormatAgentEnvelope,
        formatInboundEnvelope: mockFormatInboundEnvelope,
        resolveEnvelopeFormatOptions:
          mockResolveEnvelopeFormatOptions as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
      },
      routing: {
        resolveAgentRoute:
          mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      pairing: {
        buildPairingReply: mockBuildPairingReply,
        readAllowFromStore: mockReadAllowFromStore,
        upsertPairingRequest: mockUpsertPairingRequest,
      },
      media: {
        saveMediaBuffer:
          mockSaveMediaBuffer as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      session: {
        resolveStorePath: mockResolveStorePath,
        readSessionUpdatedAt: mockReadSessionUpdatedAt,
      },
      mentions: {
        buildMentionRegexes: mockBuildMentionRegexes,
        matchesMentionPatterns: mockMatchesMentionPatterns,
        matchesMentionWithExplicit: mockMatchesMentionWithExplicit,
      },
      groups: {
        resolveGroupPolicy:
          mockResolveGroupPolicy as unknown as PluginRuntime["channel"]["groups"]["resolveGroupPolicy"],
        resolveRequireMention: mockResolveRequireMention,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
      },
    },
  });
}

function createMockAccount(
  overrides: Partial<ResolvedBlueBubblesAccount["config"]> = {},
): ResolvedBlueBubblesAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ...overrides,
    },
  };
}

function createMockRequest(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  if (headers.host === undefined) {
    headers.host = "localhost";
  }
  const parsedUrl = new URL(url, "http://localhost");
  const hasAuthQuery = parsedUrl.searchParams.has("guid") || parsedUrl.searchParams.has("password");
  const hasAuthHeader =
    headers["x-guid"] !== undefined ||
    headers["x-password"] !== undefined ||
    headers["x-bluebubbles-guid"] !== undefined ||
    headers.authorization !== undefined;
  if (!hasAuthQuery && !hasAuthHeader) {
    parsedUrl.searchParams.set("password", "test-password");
  }

  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  req.headers = headers;
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };

  // Emit body data after a microtask
  // oxlint-disable-next-line no-floating-promises
  Promise.resolve().then(() => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    req.emit("data", Buffer.from(bodyStr));
    req.emit("end");
  });

  return req;
}

function createMockResponse(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      res.body = data ?? "";
    }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

const flushAsync = async () => {
  for (let i = 0; i < 2; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function getFirstDispatchCall(): DispatchReplyParams {
  const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
  if (!callArgs) {
    throw new Error("expected dispatch call arguments");
  }
  return callArgs;
}

describe("BlueBubbles webhook monitor", () => {
  let unregister: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset short ID state between tests for predictable behavior
    _resetBlueBubblesShortIdState();
    mockFetchBlueBubblesHistory.mockResolvedValue({ entries: [], resolved: true });
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "TESTCODE", created: true });
    mockResolveRequireMention.mockReturnValue(false);
    mockHasControlCommand.mockReturnValue(false);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);
    mockBuildMentionRegexes.mockReturnValue([/\bbert\b/i]);

    setBlueBubblesRuntime(createMockRuntime());
  });

  afterEach(() => {
    unregister?.();
  });

  describe("webhook parsing + auth handling", () => {
    it("rejects non-POST requests", async () => {
      const account = createMockAccount();
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const req = createMockRequest("GET", "/bluebubbles-webhook", {});
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("accepts POST requests with valid JSON payload", async () => {
      const account = createMockAccount();
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
    });

    it("rejects requests with invalid JSON", async () => {
      const account = createMockAccount();
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const req = createMockRequest("POST", "/bluebubbles-webhook", "invalid json {{");
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    });

    it("accepts URL-encoded payload wrappers", async () => {
      const account = createMockAccount();
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };
      const encodedBody = new URLSearchParams({
        payload: JSON.stringify(payload),
      }).toString();

      const req = createMockRequest("POST", "/bluebubbles-webhook", encodedBody);
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
    });

    it("returns 408 when request body times out (Slow-Loris protection)", async () => {
      vi.useFakeTimers();
      try {
        const account = createMockAccount();
        const config: OpenClawConfig = {};
        const core = createMockRuntime();
        setBlueBubblesRuntime(core);

        unregister = registerBlueBubblesWebhookTarget({
          account,
          config,
          runtime: { log: vi.fn(), error: vi.fn() },
          core,
          path: "/bluebubbles-webhook",
        });

        // Create a request that never sends data or ends (simulates slow-loris)
        const req = new EventEmitter() as IncomingMessage;
        req.method = "POST";
        req.url = "/bluebubbles-webhook?password=test-password";
        req.headers = {};
        (req as unknown as { socket: { remoteAddress: string } }).socket = {
          remoteAddress: "127.0.0.1",
        };
        req.destroy = vi.fn();

        const res = createMockResponse();

        const handledPromise = handleBlueBubblesWebhookRequest(req, res);

        // Advance past the 30s timeout
        await vi.advanceTimersByTimeAsync(31_000);

        const handled = await handledPromise;
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(408);
        expect(req.destroy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects unauthorized requests before reading the body", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const req = new EventEmitter() as IncomingMessage;
      req.method = "POST";
      req.url = "/bluebubbles-webhook?password=wrong-token";
      req.headers = {};
      const onSpy = vi.spyOn(req, "on");
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "127.0.0.1",
      };

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    });

    it("authenticates via password query parameter", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      // Mock non-localhost request
      const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "192.168.1.100",
      };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("authenticates via x-password header", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const req = createMockRequest(
        "POST",
        "/bluebubbles-webhook",
        {
          type: "new-message",
          data: {
            text: "hello",
            handle: { address: "+15551234567" },
            isGroup: false,
            isFromMe: false,
            guid: "msg-1",
          },
        },
        { "x-password": "secret-token" },
      );
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "192.168.1.100",
      };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("rejects unauthorized requests with wrong password", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const req = createMockRequest("POST", "/bluebubbles-webhook?password=wrong-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "192.168.1.100",
      };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("rejects ambiguous routing when multiple targets match the same password", async () => {
      const accountA = createMockAccount({ password: "secret-token" });
      const accountB = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const sinkA = vi.fn();
      const sinkB = vi.fn();

      const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "192.168.1.100",
      };

      const unregisterA = registerBlueBubblesWebhookTarget({
        account: accountA,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
        statusSink: sinkA,
      });
      const unregisterB = registerBlueBubblesWebhookTarget({
        account: accountB,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
        statusSink: sinkB,
      });
      unregister = () => {
        unregisterA();
        unregisterB();
      };

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).not.toHaveBeenCalled();
    });

    it("ignores targets without passwords when a password-authenticated target matches", async () => {
      const accountStrict = createMockAccount({ password: "secret-token" });
      const accountWithoutPassword = createMockAccount({ password: undefined });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const sinkStrict = vi.fn();
      const sinkWithoutPassword = vi.fn();

      const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: "192.168.1.100",
      };

      const unregisterStrict = registerBlueBubblesWebhookTarget({
        account: accountStrict,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
        statusSink: sinkStrict,
      });
      const unregisterNoPassword = registerBlueBubblesWebhookTarget({
        account: accountWithoutPassword,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
        statusSink: sinkWithoutPassword,
      });
      unregister = () => {
        unregisterStrict();
        unregisterNoPassword();
      };

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(sinkStrict).toHaveBeenCalledTimes(1);
      expect(sinkWithoutPassword).not.toHaveBeenCalled();
    });

    it("requires authentication for loopback requests when password is configured", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);
      for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        const req = createMockRequest("POST", "/bluebubbles-webhook", {
          type: "new-message",
          data: {
            text: "hello",
            handle: { address: "+15551234567" },
            isGroup: false,
            isFromMe: false,
            guid: "msg-1",
          },
        });
        (req as unknown as { socket: { remoteAddress: string } }).socket = {
          remoteAddress,
        };

        const loopbackUnregister = registerBlueBubblesWebhookTarget({
          account,
          config,
          runtime: { log: vi.fn(), error: vi.fn() },
          core,
          path: "/bluebubbles-webhook",
        });

        const res = createMockResponse();
        const handled = await handleBlueBubblesWebhookRequest(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);

        loopbackUnregister();
      }
    });

    it("rejects targets without passwords for loopback and proxied-looking requests", async () => {
      const account = createMockAccount({ password: undefined });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const headerVariants: Record<string, string>[] = [
        { host: "localhost" },
        { host: "localhost", "x-forwarded-for": "203.0.113.10" },
        { host: "localhost", forwarded: "for=203.0.113.10;proto=https;host=example.com" },
      ];
      for (const headers of headerVariants) {
        const req = createMockRequest(
          "POST",
          "/bluebubbles-webhook",
          {
            type: "new-message",
            data: {
              text: "hello",
              handle: { address: "+15551234567" },
              isGroup: false,
              isFromMe: false,
              guid: "msg-1",
            },
          },
          headers,
        );
        (req as unknown as { socket: { remoteAddress: string } }).socket = {
          remoteAddress: "127.0.0.1",
        };
        const res = createMockResponse();
        const handled = await handleBlueBubblesWebhookRequest(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
      }
    });

    it("ignores unregistered webhook paths", async () => {
      const req = createMockRequest("POST", "/unregistered-path", {});
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(false);
    });

    it("parses chatId when provided as a string (webhook variant)", async () => {
      const { resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(resolveChatGuidForTarget).mockClear();

      const account = createMockAccount({ groupPolicy: "open" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatId: "123",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(resolveChatGuidForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "chat_id", chatId: 123 },
        }),
      );
    });

    it("extracts chatGuid from nested chat object fields (webhook variant)", async () => {
      const { sendMessageBlueBubbles, resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockClear();
      vi.mocked(resolveChatGuidForTarget).mockClear();

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });

      const account = createMockAccount({ groupPolicy: "open" });
      const config: OpenClawConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chat: { chatGuid: "iMessage;+;chat123456" },
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(resolveChatGuidForTarget).not.toHaveBeenCalled();
      expect(sendMessageBlueBubbles).toHaveBeenCalledWith(
        "chat_guid:iMessage;+;chat123456",
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
