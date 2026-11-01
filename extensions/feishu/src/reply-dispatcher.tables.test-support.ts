// Shared harness for the Feishu reply dispatcher table suites: mocked transports, a
// streaming-card stand-in, and the real table-mode resolver behind a registered plugin.
import {
  convertMarkdownTables,
  type MarkdownTableMode,
  resolveMarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, type Mock, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

export type StreamingSessionStub = {
  active: boolean;
  credentials: unknown;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updated: ReturnType<typeof Promise.withResolvers<void>>;
  closeWithResult: Mock<FeishuStreamingSession["closeWithResult"]>;
  discard: Mock<FeishuStreamingSession["discard"]>;
  discardStarted: ReturnType<typeof Promise.withResolvers<void>>;
  isActive: ReturnType<typeof vi.fn>;
};
export type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;

const mocks = vi.hoisted(() => ({
  resolveFeishuAccount: vi.fn(),
  getFeishuRuntime: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  sendMessageFeishu: vi.fn(),
  sendStructuredCardFeishu: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMediaFeishu: vi.fn(),
  createFeishuClient: vi.fn(),
  resolveReceiveIdType: vi.fn(),
  addTypingIndicator: vi.fn(async () => ({ messageId: "om_msg" })),
  removeTypingIndicator: vi.fn(async () => {}),
  streamingInstances: [] as StreamingSessionStub[],
  shouldSuppressFeishuTextForVoiceMedia: (params: {
    mediaUrl?: string;
    audioAsVoice?: boolean;
    ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
  }) =>
    params.ttsSupplement
      ? params.ttsSupplement.visibleTextAlreadyDelivered === true
      : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
  resolvePinnedHostnameWithPolicy: vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
}));

vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveFeishuAccount: mocks.resolveFeishuAccount,
  resolveFeishuRuntimeAccount: mocks.resolveFeishuAccount,
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: mocks.getFeishuRuntime,
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getGlobalHookRunner: mocks.getGlobalHookRunner };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageFeishu: mocks.sendMessageFeishu,
  sendStructuredCardFeishu: mocks.sendStructuredCardFeishu,
  sendCardFeishu: mocks.sendCardFeishu,
}));
vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  sendMediaFeishu: mocks.sendMediaFeishu,
  shouldSuppressFeishuTextForVoiceMedia: mocks.shouldSuppressFeishuTextForVoiceMedia,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolvePinnedHostnameWithPolicy: mocks.resolvePinnedHostnameWithPolicy };
});
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: mocks.createFeishuClient,
}));
vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveReceiveIdType: mocks.resolveReceiveIdType,
}));
vi.mock("./typing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./typing.js")>()),
  addTypingIndicator: mocks.addTypingIndicator,
  removeTypingIndicator: mocks.removeTypingIndicator,
}));
vi.mock("./streaming-card.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./streaming-card.js")>()),
  FeishuStreamingSession: class {
    active = false;
    credentials: unknown;
    start = vi.fn(async () => {
      this.active = true;
    });
    updated = Promise.withResolvers<void>();
    update = vi.fn(async () => {
      this.updated.resolve();
    });
    closeWithResult = vi.fn<FeishuStreamingSession["closeWithResult"]>(async (text, _options) => {
      this.active = false;
      return createFeishuReplyDeliveryResult({
        results: [{ messageId: "om_stream" }],
        visibleReplySent: Boolean(text?.trim()),
        ...(text?.trim() ? { content: text } : {}),
        kind: "card",
      });
    });
    discardStarted = Promise.withResolvers<void>();
    discard = vi.fn<FeishuStreamingSession["discard"]>(async () => {
      this.discardStarted.resolve();
      this.active = false;
      return { visibleReplySent: false };
    });
    isActive = vi.fn(() => this.active);

    constructor(_client: unknown, credentials: unknown) {
      this.credentials = credentials;
      mocks.streamingInstances.push(this);
    }
  },
}));

import { createFeishuReplyDeliveryResult } from "./reply-delivery-result.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

export const {
  resolveFeishuAccount: resolveFeishuAccountMock,
  getFeishuRuntime: getFeishuRuntimeMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  sendMediaFeishu: sendMediaFeishuMock,
  createFeishuClient: createFeishuClientMock,
  streamingInstances,
} = mocks;

export const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
export const pipelessTableMarkdown = "Name | Role\n--- | ---\nAda | Lead";
export const codeText = convertMarkdownTables(tableMarkdown, "code");
export const bulletsCard = "**Ada**\n• Role: Lead";
export const outgrowingTable = [
  "| name | detail |",
  "| --- | --- |",
  ...Array.from({ length: 40 }, (_entry, index) => `| row${index} | d |`),
  `| wide | ${"w".repeat(220)} |`,
].join("\n");

export function installTableDispatcherHarness() {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingStartBackoffUntilByAccount.clear();
    mocks.streamingInstances.length = 0;
    mocks.sendMessageFeishu.mockReset();
    mocks.sendMediaFeishu.mockReset().mockResolvedValue(undefined);
    mocks.sendStructuredCardFeishu.mockReset().mockResolvedValue(undefined);
    mocks.sendCardFeishu.mockReset().mockResolvedValue({ messageId: "om_card" });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveFeishuAccount.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: { renderMode: "auto", streaming: { mode: "partial" }, httpTimeoutMs: 45_000 },
    });
    mocks.resolveReceiveIdType.mockReturnValue("chat_id");
    mocks.createFeishuClient.mockReturnValue({});
    mocks.getFeishuRuntime.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode,
          convertMarkdownTables,
          chunkTextWithMode: vi.fn((text) => [text]),
          chunkMarkdownTextWithMode: vi.fn((text) => [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
    // Feishu declares block as its plugin default; the harness does not load the runtime setup.
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            id: "feishu",
            meta: { id: "feishu" },
            messaging: { defaultMarkdownTableMode: "block" },
          },
        },
      ]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterAll(() => {
    for (const specifier of [
      "./accounts.js",
      "./runtime.js",
      "./send.js",
      "./media.js",
      "./client.js",
      "./targets.js",
      "./typing.js",
      "./streaming-card.js",
      "openclaw/plugin-sdk/ssrf-runtime",
      "openclaw/plugin-sdk/plugin-runtime",
    ]) {
      vi.doUnmock(specifier);
    }
    vi.resetModules();
  });
}

type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];
type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;

export function createReplyAccount(
  renderMode: "auto" | "card",
  streamingMode: "off" | "partial",
  domain: "feishu" | "lark" = "feishu",
) {
  return {
    accountId: "main",
    appId: "app_id",
    appSecret: "app_secret",
    domain,
    config: { renderMode, streaming: { mode: streamingMode } },
  };
}

export function toTypingDispatcherOptions(result: ReplyDispatcherPlan) {
  return { ...result.dispatcherOptions, ...result.delivery };
}

export function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
  const result = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: "agent",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    chatId: "oc_chat",
    sendTarget: "oc_chat",
    ...overrides,
  });
  return { result, options: toTypingDispatcherOptions(result) };
}

export function tableCfg(tables?: MarkdownTableMode): ClawdbotConfig {
  return tables ? { channels: { feishu: { markdown: { tables } } } } : {};
}

export function createBlockTableHarness(
  cfg: ClawdbotConfig = tableCfg("off"),
  allowReasoningPreview = false,
) {
  mocks.resolveFeishuAccount.mockReturnValue({
    ...createReplyAccount("auto", "partial"),
    config: { renderMode: "auto", streaming: { mode: "partial", block: { enabled: true } } },
  });
  return createDispatcherHarness({ accountId: "main", cfg, allowReasoningPreview });
}

export async function deliverFinal(
  tables: MarkdownTableMode | undefined,
  streaming: "off" | "partial",
  text = tableMarkdown,
) {
  mocks.resolveFeishuAccount.mockReturnValue(createReplyAccount("auto", streaming));
  const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg(tables) });
  const delivery = await options.deliver({ text }, { kind: "final" });
  await options.onIdle?.();
  await delivery?.finalization;
}

export function requireStreamingInstance(instanceIndex = 0): StreamingSessionStub {
  const instance = mocks.streamingInstances[instanceIndex];
  if (!instance) {
    throw new Error(`Expected streaming instance ${instanceIndex}`);
  }
  return instance;
}

export function streamingUpdateTexts(instanceIndex = 0): string[] {
  return requireStreamingInstance(instanceIndex).update.mock.calls.map((call: unknown[]) =>
    typeof call[0] === "string" ? call[0] : "",
  );
}

export async function useRealMarkdownChunker(limit?: number) {
  const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
    "openclaw/plugin-sdk/reply-chunking",
  );
  const text = mocks.getFeishuRuntime().channel.text;
  text.chunkMarkdownTextWithMode.mockImplementation(chunking.chunkMarkdownTextWithMode);
  if (limit !== undefined) {
    text.resolveTextChunkLimit.mockReturnValue(limit);
  }
}
