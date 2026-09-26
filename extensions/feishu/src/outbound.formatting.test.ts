// Feishu tests cover the per-delivery formatting a formatted send has to honor.
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuClientCredentials } from "./client.js";

const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
);
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./media.js", () => ({
  sendMediaFeishu: vi.fn(),
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: () => false,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.resetModules();
});

describe("feishu outbound delivery formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  // Longer than a 1,000-character delivery limit and shorter than both the 4,000-character
  // account default and a 2,000-character account setting, so only a honored delivery limit
  // cuts it at all.
  const body = Array.from(
    { length: 60 },
    (_entry, index) => `Line ${index} of the answer ${"y".repeat(30)}`,
  ).join("\n");

  function sentLengths(mock: ReturnType<typeof vi.fn>, key: "text" | "content"): number[] {
    return mock.mock.calls.map((call) => String(call[0]?.[key] ?? "").length);
  }

  function commentLengths(): number[] {
    return deliverCommentThreadTextMock.mock.calls.map(
      (call) => String(call[1]?.content ?? "").length,
    );
  }

  it("cuts the fanout to the delivery limit instead of the account default", async () => {
    expect(body.length).toBeGreaterThan(2000);
    expect(body.length).toBeLessThan(4000);

    await feishuOutbound.sendFormattedText?.({
      cfg: {} as ClawdbotConfig,
      to: "chat_1",
      text: body,
      accountId: "main",
      formatting: { textLimit: 1000 },
    } as never);

    const lengths = sentLengths(sendMessageFeishuMock, "text");
    expect(lengths).toHaveLength(4);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1000);
  });

  // The delivery limit takes precedence over the account setting the way core's planner
  // reads it, rather than standing in as the value used when nothing is configured.
  it("lets the delivery limit override a configured account limit", async () => {
    await feishuOutbound.sendFormattedText?.({
      cfg: { channels: { feishu: { textChunkLimit: 2000 } } } as ClawdbotConfig,
      to: "chat_1",
      text: body,
      accountId: "main",
      formatting: { textLimit: 1000 },
    } as never);

    const lengths = sentLengths(sendMessageFeishuMock, "text");
    expect(lengths).toHaveLength(4);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1000);
  });

  it("keeps the account limit when the delivery carries no formatting", async () => {
    await feishuOutbound.sendFormattedText?.({
      cfg: { channels: { feishu: { textChunkLimit: 2000 } } } as ClawdbotConfig,
      to: "chat_1",
      text: body,
      accountId: "main",
    } as never);

    const lengths = sentLengths(sendMessageFeishuMock, "text");
    expect(lengths).toHaveLength(2);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(2000);
  });

  it("cuts comment thread replies to the delivery limit too", async () => {
    await feishuOutbound.sendFormattedText?.({
      cfg: {} as ClawdbotConfig,
      to: "comment:docx:doc_token_1:comment_1",
      text: body,
      accountId: "main",
      formatting: { textLimit: 1000 },
    } as never);

    const lengths = commentLengths();
    expect(lengths).toHaveLength(4);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1000);
  });
});
