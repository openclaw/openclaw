// Covers explicit card rendering for completed blocks when preview streaming is off.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: getFeishuRuntimeMock,
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: vi.fn(() => ({})),
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

function makeTableText(count: number): string {
  return Array.from({ length: count }, (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`).join(
    "\n\n",
  );
}

function createCardBlockDispatcher() {
  resolveFeishuAccountMock.mockReturnValue({
    accountId: "main",
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
    config: { renderMode: "card", streaming: { mode: "off", block: { enabled: true } } },
  });
  const result = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: "agent",
    runtime: { log: vi.fn(), error: vi.fn() } as never,
    chatId: "oc_chat",
    sendTarget: "oc_chat",
  });
  return { ...result.dispatcherOptions, ...result.delivery };
}

describe("Feishu non-streaming block card rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "om_post", chatId: "oc_chat" });
    sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "om_card", chatId: "oc_chat" });
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text: string) => text),
          chunkTextWithMode: vi.fn((text: string) => [text]),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  });

  it("sends explicit-card blocks as static cards and keeps the table-limit post fallback", async () => {
    const options = createCardBlockDispatcher();
    await options.deliver({ text: "First paragraph." }, { kind: "block" });
    await options.deliver({ text: makeTableText(6) }, { kind: "block" });
    await options.onIdle?.();

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendStructuredCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      text: "First paragraph.",
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });
});
