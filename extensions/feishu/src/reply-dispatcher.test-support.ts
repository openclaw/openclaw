import { afterAll, vi, type Mock } from "vitest";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import type { FeishuStreamingSession } from "./streaming-card.js";
import type { FeishuConfig } from "./types.js";

type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];
type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;
export type TypingDispatcherOptions = ReplyDispatcherPlan["dispatcherOptions"] &
  ReplyDispatcherPlan["delivery"];

export type StreamingSessionStub = {
  active: boolean;
  credentials: unknown;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  closeWithResult: Mock<FeishuStreamingSession["closeWithResult"]>;
  discard: Mock<FeishuStreamingSession["discard"]>;
  isActive: ReturnType<typeof vi.fn>;
};
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted((): StreamingSessionStub[] => []);
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
);
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
}));
vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock };
});
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", async () => {
  const { mergeStreamingText } = await import("./card-test-helpers.js");
  class FeishuStreamingFinalizationError extends Error {
    result: { visibleReplySent: boolean; content?: string; messageId?: string };
    constructor(
      cause: unknown,
      result: { visibleReplySent: boolean; content?: string; messageId?: string },
    ) {
      super(cause instanceof Error ? cause.message : String(cause), { cause });
      this.result = result;
    }
  }
  return {
    mergeStreamingText,
    FeishuStreamingFinalizationError,
    FeishuStreamingSession: class {
      active = false;
      credentials: unknown;
      start = vi.fn(async () => {
        this.active = true;
      });
      update = vi.fn(async () => {});
      closeWithResult = vi.fn<FeishuStreamingSession["closeWithResult"]>(async (text, _options) => {
        this.active = false;
        return {
          visibleReplySent: Boolean(text?.trim()),
          ...(text?.trim() ? { content: text } : {}),
          messageId: "om_stream",
        };
      });
      discard = vi.fn<FeishuStreamingSession["discard"]>(async () => {
        this.active = false;
        return { visibleReplySent: false };
      });
      isActive = vi.fn(() => this.active);
      constructor(_client: unknown, credentials: unknown) {
        this.credentials = credentials;
        streamingInstances.push(this);
      }
    },
  };
});

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./targets.js");
  vi.doUnmock("./typing.js");
  vi.doUnmock("./streaming-card.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/plugin-runtime");
  vi.resetModules();
});
export function createReplyAccount(
  renderMode: "auto" | "card",
  streamingMode: "off" | "partial",
  domain: "feishu" | "lark",
  overrides: Partial<FeishuConfig> = {},
) {
  return {
    accountId: "main",
    appId: "app_id",
    appSecret: "app_secret",
    domain,
    config: { renderMode, streaming: { mode: streamingMode }, ...overrides },
  };
}

export function useNonStreamingAutoAccount() {
  resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
}
export function resetFeishuReplyDispatcherHarness() {
  vi.clearAllMocks();
  streamingStartBackoffUntilByAccount.clear();
  streamingInstances.length = 0;
  sendMediaFeishuMock.mockReset().mockResolvedValue(undefined);
  sendStructuredCardFeishuMock.mockReset().mockResolvedValue(undefined);
  sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "om_card" });
  getGlobalHookRunnerMock.mockReturnValue(null);
  resolveFeishuAccountMock.mockReturnValue(
    createReplyAccount("auto", "partial", "feishu", { httpTimeoutMs: 45_000 }),
  );
  resolveReceiveIdTypeMock.mockReturnValue("chat_id");
  createFeishuClientMock.mockReturnValue({});
  getFeishuRuntimeMock.mockReturnValue({
    channel: {
      text: {
        resolveTextChunkLimit: vi.fn(() => 4000),
        resolveChunkMode: vi.fn(() => "line"),
        resolveMarkdownTableMode: vi.fn(() => "preserve"),
        convertMarkdownTables: vi.fn((text) => text),
        chunkTextWithMode: vi.fn((text) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text) => [text]),
      },
      reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
    },
  });
}

function createRuntimeLogger() {
  return { log: vi.fn(), error: vi.fn() } as never;
}

export function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
  const result = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: "agent",
    runtime: createRuntimeLogger(),
    chatId: "oc_chat",
    sendTarget: "oc_chat",
    ...overrides,
  });
  return { result, options: toTypingDispatcherOptions(result) };
}

export function toTypingDispatcherOptions(result: ReplyDispatcherPlan): TypingDispatcherOptions {
  return { ...result.dispatcherOptions, ...result.delivery };
}

export {
  resolveFeishuAccountMock,
  getFeishuRuntimeMock,
  getGlobalHookRunnerMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  sendCardFeishuMock,
  sendMediaFeishuMock,
  createFeishuClientMock,
  resolveReceiveIdTypeMock,
  addTypingIndicatorMock,
  removeTypingIndicatorMock,
  streamingInstances,
  shouldSuppressFeishuTextForVoiceMediaMock,
  resolvePinnedHostnameWithPolicyMock,
};
