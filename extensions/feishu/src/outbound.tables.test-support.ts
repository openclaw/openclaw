// Shared harness for the Feishu outbound table suites: mocked transports and the registered plugin.
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import type { FeishuClientCredentials } from "./client.js";

const mocks = vi.hoisted(() => ({
  sendMediaFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendStructuredCardFeishu: vi.fn(),
  createFeishuClient: vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
  deliverCommentThreadText: vi.fn(),
  cleanupAmbientCommentTypingReaction: vi.fn(async () => false),
  cardTemplates: new Set(
    "blue green red orange purple indigo wathet turquoise yellow grey carmine violet lime".split(
      " ",
    ),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePinnedHostnameWithPolicy: vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
}));
vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  sendMediaFeishu: mocks.sendMediaFeishu,
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: (params: {
    mediaUrl?: string;
    audioAsVoice?: boolean;
    ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
  }) =>
    params.ttsSupplement
      ? params.ttsSupplement.visibleTextAlreadyDelivered === true
      : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: mocks.sendCardFeishu,
  sendMessageFeishu: mocks.sendMessageFeishu,
  sendStructuredCardFeishu: mocks.sendStructuredCardFeishu,
  resolveFeishuCardTemplate: (template?: string) =>
    mocks.cardTemplates.has(template ?? "") ? template : undefined,
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: () => ({ channel: { text: { chunkMarkdownText: (text: string) => [text] } } }),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: mocks.createFeishuClient,
}));
vi.mock("./drive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./drive.js")>()),
  deliverCommentThreadText: mocks.deliverCommentThreadText,
}));
vi.mock("./comment-reaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comment-reaction.js")>()),
  cleanupAmbientCommentTypingReaction: mocks.cleanupAmbientCommentTypingReaction,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";

export const {
  sendMediaFeishu: sendMediaFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  createFeishuClient: createFeishuClientMock,
  deliverCommentThreadText: deliverCommentThreadTextMock,
} = mocks;

export const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";

export function requireFeishuSendText() {
  const sendText = feishuOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected Feishu outbound sendText");
  }
  return sendText;
}

export function resetOutboundMocks() {
  vi.clearAllMocks();
  mocks.sendMessageFeishu.mockResolvedValue({ messageId: "text_msg" });
  mocks.sendCardFeishu.mockResolvedValue({ messageId: "native_card_msg" });
  mocks.sendStructuredCardFeishu.mockResolvedValue({ messageId: "card_msg" });
  mocks.sendMediaFeishu.mockResolvedValue({ messageId: "media_msg" });
  mocks.deliverCommentThreadText.mockResolvedValue({
    delivery_mode: "reply_comment",
    reply_id: "reply_msg",
  });
  mocks.cleanupAmbientCommentTypingReaction.mockResolvedValue(false);
}

export function installOutboundHarness() {
  beforeEach(() => {
    resetOutboundMocks();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterAll(() => {
    for (const specifier of [
      "./media.js",
      "./send.js",
      "./runtime.js",
      "./client.js",
      "./drive.js",
      "./comment-reaction.js",
      "openclaw/plugin-sdk/ssrf-runtime",
    ]) {
      vi.doUnmock(specifier);
    }
    vi.resetModules();
  });
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, index = 0, argIndex = 0) {
  const calls = mock.mock.calls as unknown as Array<Array<Record<string, any>>>;
  return calls[index]?.[argIndex];
}
