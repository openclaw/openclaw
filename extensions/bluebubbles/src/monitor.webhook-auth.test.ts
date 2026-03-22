import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBlueBubblesMonitorTestRuntime,
  EMPTY_DISPATCH_RESULT,
  resetBlueBubblesMonitorTestState,
  type DispatchReplyParams,
} from "../../../test/helpers/extensions/bluebubbles-monitor.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { fetchBlueBubblesHistory } from "./history.js";
import { handleBlueBubblesWebhookRequest, resolveBlueBubblesMessageId } from "./monitor.js";
import {
  LOOPBACK_REMOTE_ADDRESSES_FOR_TEST,
  createMockAccount,
  createHangingWebhookRequestForTest,
  createMockResponse,
  createLoopbackWebhookRequestParamsForTest,
  createNewMessagePayloadForTest,
  createPasswordQueryRequestParamsForTest,
  createProtectedWebhookAccountForTest,
  createRemoteWebhookRequestParamsForTest,
  dispatchWebhookPayloadForTest,
  expectWebhookRequestStatusForTest,
  expectWebhookStatusForTest,
  setupWebhookTargetForTest,
  setupWebhookTargetsForTest,
} from "./monitor.webhook.test-helpers.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";

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
const TEST_WEBHOOK_PASSWORD = "secret-token";

function createMockRuntime(): PluginRuntime {
  return createBlueBubblesMonitorTestRuntime({
    enqueueSystemEvent: mockEnqueueSystemEvent,
    chunkMarkdownText: mockChunkMarkdownText,
    chunkByNewline: mockChunkByNewline,
    chunkMarkdownTextWithMode: mockChunkMarkdownTextWithMode,
    chunkTextWithMode: mockChunkTextWithMode,
    resolveChunkMode: mockResolveChunkMode,
    hasControlCommand: mockHasControlCommand,
    dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher,
    formatAgentEnvelope: mockFormatAgentEnvelope,
    formatInboundEnvelope: mockFormatInboundEnvelope,
    resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions,
    resolveAgentRoute: mockResolveAgentRoute,
    buildPairingReply: mockBuildPairingReply,
    readAllowFromStore: mockReadAllowFromStore,
    upsertPairingRequest: mockUpsertPairingRequest,
    saveMediaBuffer: mockSaveMediaBuffer,
    resolveStorePath: mockResolveStorePath,
    readSessionUpdatedAt: mockReadSessionUpdatedAt,
    buildMentionRegexes: mockBuildMentionRegexes,
    matchesMentionPatterns: mockMatchesMentionPatterns,
    matchesMentionWithExplicit: mockMatchesMentionWithExplicit,
    resolveGroupPolicy: mockResolveGroupPolicy,
    resolveRequireMention: mockResolveRequireMention,
    resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
  });
}

describe("BlueBubbles webhook monitor", () => {
  let unregister: () => void;

  beforeEach(() => {
    resetBlueBubblesMonitorTestState({
      createRuntime: createMockRuntime,
      fetchHistoryMock: mockFetchBlueBubblesHistory,
      readAllowFromStoreMock: mockReadAllowFromStore,
      upsertPairingRequestMock: mockUpsertPairingRequest,
      resolveRequireMentionMock: mockResolveRequireMention,
      hasControlCommandMock: mockHasControlCommand,
      resolveCommandAuthorizedFromAuthorizersMock: mockResolveCommandAuthorizedFromAuthorizers,
      buildMentionRegexesMock: mockBuildMentionRegexes,
    });
  });

  afterEach(() => {
    unregister?.();
  });

  function setupWebhookTarget(params?: {
    account?: ResolvedBlueBubblesAccount;
    config?: OpenClawConfig;
    core?: PluginRuntime;
    statusSink?: (event: unknown) => void;
  }) {
    const registration = setupWebhookTargetForTest({
      createCore: createMockRuntime,
      core: params?.core,
      account: params?.account,
      config: params?.config,
      statusSink: params?.statusSink,
    });
    unregister = registration.unregister;
    return {
      account: registration.account,
      config: registration.config,
      core: registration.core,
    };
  }

  function setupProtectedWebhookTarget(password = TEST_WEBHOOK_PASSWORD) {
    const account = createProtectedWebhookAccountForTest(password);
    setupWebhookTarget({ account });
    return account;
  }

  function registerWebhookTargets(
    params: Array<{
      account: ResolvedBlueBubblesAccount;
      statusSink?: (event: unknown) => void;
    }>,
  ) {
    const registration = setupWebhookTargetsForTest({
      createCore: createMockRuntime,
      accounts: params,
    });
    unregister = registration.unregister;
  }

  describe("webhook parsing + auth handling", () => {
    it("rejects non-POST requests", async () => {
      setupWebhookTarget();
      await expectWebhookRequestStatusForTest({ method: "GET" }, 405);
    });

    it("accepts POST requests with valid JSON payload", async () => {
      setupWebhookTarget();
      const payload = createNewMessagePayloadForTest({ date: Date.now() });
      await expectWebhookRequestStatusForTest({ body: payload }, 200, "ok");
    });

    it("rejects requests with invalid JSON", async () => {
      setupWebhookTarget();
      await expectWebhookRequestStatusForTest({ body: "invalid json {{" }, 400);
    });

    it("accepts URL-encoded payload wrappers", async () => {
      setupWebhookTarget();
      const payload = createNewMessagePayloadForTest({ date: Date.now() });
      const encodedBody = new URLSearchParams({
        payload: JSON.stringify(payload),
      }).toString();
      await expectWebhookRequestStatusForTest({ body: encodedBody }, 200, "ok");
    });

    it("returns 408 when request body times out (Slow-Loris protection)", async () => {
      vi.useFakeTimers();
      try {
        setupWebhookTarget();

        // Create a request that never sends data or ends (simulates slow-loris)
        const { req, destroyMock } = createHangingWebhookRequestForTest();

        const res = createMockResponse();

        const handledPromise = handleBlueBubblesWebhookRequest(req, res);

        // Advance past the 30s timeout
        await vi.advanceTimersByTimeAsync(31_000);

        const handled = await handledPromise;
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(408);
        expect(destroyMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects unauthorized requests before reading the body", async () => {
      setupProtectedWebhookTarget();
      const { req } = createHangingWebhookRequestForTest(
        "/bluebubbles-webhook?password=wrong-token",
      );
      const onSpy = vi.spyOn(req, "on");
      await expectWebhookStatusForTest(req, 401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    });

    it("authenticates via password query parameter", async () => {
      setupProtectedWebhookTarget();
      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          body: createNewMessagePayloadForTest(),
          password: TEST_WEBHOOK_PASSWORD,
        }),
        200,
      );
    });

    it("authenticates via x-password header", async () => {
      setupProtectedWebhookTarget();
      await expectWebhookRequestStatusForTest(
        createRemoteWebhookRequestParamsForTest({
          body: createNewMessagePayloadForTest(),
          overrides: {
            headers: { "x-password": TEST_WEBHOOK_PASSWORD }, // pragma: allowlist secret
          },
        }),
        200,
      );
    });

    it("rejects unauthorized requests with wrong password", async () => {
      setupProtectedWebhookTarget();
      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          body: createNewMessagePayloadForTest(),
          password: "wrong-token",
        }),
        401,
      );
    });

    it("rejects ambiguous routing when multiple targets match the same password", async () => {
      const accountA = createProtectedWebhookAccountForTest(TEST_WEBHOOK_PASSWORD);
      const accountB = createProtectedWebhookAccountForTest(TEST_WEBHOOK_PASSWORD);
      const sinkA = vi.fn();
      const sinkB = vi.fn();
      registerWebhookTargets([
        { account: accountA, statusSink: sinkA },
        { account: accountB, statusSink: sinkB },
      ]);

      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          body: createNewMessagePayloadForTest(),
          password: TEST_WEBHOOK_PASSWORD,
        }),
        401,
      );
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).not.toHaveBeenCalled();
    });

    it("ignores targets without passwords when a password-authenticated target matches", async () => {
      const accountStrict = createProtectedWebhookAccountForTest(TEST_WEBHOOK_PASSWORD);
      const accountWithoutPassword = createMockAccount({ password: undefined });
      const sinkStrict = vi.fn();
      const sinkWithoutPassword = vi.fn();
      registerWebhookTargets([
        { account: accountStrict, statusSink: sinkStrict },
        { account: accountWithoutPassword, statusSink: sinkWithoutPassword },
      ]);

      await expectWebhookRequestStatusForTest(
        createPasswordQueryRequestParamsForTest({
          body: createNewMessagePayloadForTest(),
          password: TEST_WEBHOOK_PASSWORD,
        }),
        200,
      );
      expect(sinkStrict).toHaveBeenCalledTimes(1);
      expect(sinkWithoutPassword).not.toHaveBeenCalled();
    });

    it("requires authentication for loopback requests when password is configured", async () => {
      setupProtectedWebhookTarget();
      for (const remoteAddress of LOOPBACK_REMOTE_ADDRESSES_FOR_TEST) {
        await expectWebhookRequestStatusForTest(
          createLoopbackWebhookRequestParamsForTest(remoteAddress, {
            body: createNewMessagePayloadForTest(),
          }),
          401,
        );
      }
    });

    it("rejects targets without passwords for loopback and proxied-looking requests", async () => {
      const account = createMockAccount({ password: undefined });
      setupWebhookTarget({ account });

      const headerVariants: Record<string, string>[] = [
        { host: "localhost" },
        { host: "localhost", "x-forwarded-for": "203.0.113.10" },
        { host: "localhost", forwarded: "for=203.0.113.10;proto=https;host=example.com" },
      ];
      for (const headers of headerVariants) {
        await expectWebhookRequestStatusForTest(
          createLoopbackWebhookRequestParamsForTest("127.0.0.1", {
            body: createNewMessagePayloadForTest(),
            overrides: { headers },
          }),
          401,
        );
      }
    });

    it("ignores unregistered webhook paths", async () => {
      const { handled } = await dispatchWebhookPayloadForTest({
        url: "/unregistered-path",
      });

      expect(handled).toBe(false);
    });

    it("parses chatId when provided as a string (webhook variant)", async () => {
      const { resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(resolveChatGuidForTarget).mockClear();

      setupWebhookTarget({ account: createMockAccount({ groupPolicy: "open" }) });
      const payload = createNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chatId: "123",
        date: Date.now(),
      });

      await dispatchWebhookPayloadForTest({ body: payload });

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

      setupWebhookTarget({ account: createMockAccount({ groupPolicy: "open" }) });
      const payload = createNewMessagePayloadForTest({
        text: "hello from group",
        isGroup: true,
        chat: { chatGuid: "iMessage;+;chat123456" },
        date: Date.now(),
      });

      await dispatchWebhookPayloadForTest({ body: payload });

      expect(resolveChatGuidForTarget).not.toHaveBeenCalled();
      expect(sendMessageBlueBubbles).toHaveBeenCalledWith(
        "chat_guid:iMessage;+;chat123456",
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
