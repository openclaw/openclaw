import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLineBotMock, registerPluginHttpRouteMock, unregisterHttpMock } = vi.hoisted(() => ({
  createLineBotMock: vi.fn(() => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn(),
  })),
  registerPluginHttpRouteMock: vi.fn(),
  unregisterHttpMock: vi.fn(),
}));

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
    waitForAbortSignal: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  normalizePluginHttpPath: (_path: string | undefined, fallback: string) => fallback,
  registerPluginHttpRoute: registerPluginHttpRouteMock,
}));

vi.mock("./webhook-node.js", () => ({
  createLineNodeWebhookHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./auto-reply-delivery.js", () => ({
  deliverLineAutoReply: vi.fn(),
}));

vi.mock("./markdown-to-line.js", () => ({
  processLineMessage: vi.fn(),
}));

vi.mock("./reply-chunks.js", () => ({
  sendLineReplyChunks: vi.fn(),
}));

vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  createQuickReplyItems: vi.fn(),
  createTextMessageWithQuickReplies: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessageLine: vi.fn(),
  pushMessagesLine: vi.fn(),
  pushTextMessageWithQuickReplies: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(),
}));

vi.mock("./template-messages.js", () => ({
  buildTemplateMessageFromPayload: vi.fn(),
}));

describe("monitorLineProvider lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules();
    createLineBotMock.mockReset();
    createLineBotMock.mockReturnValue({
      account: { accountId: "default" },
      handleWebhook: vi.fn(),
    });
    unregisterHttpMock.mockReset();
    registerPluginHttpRouteMock.mockReset().mockReturnValue(unregisterHttpMock);
    ({ monitorLineProvider } = await import("./monitor.js"));
  });

  it("waits for abort before resolving", async () => {
    const abort = new AbortController();
    let resolved = false;

    const task = monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    await vi.waitFor(() => expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1));
    expect(registerPluginHttpRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: "plugin" }),
    );
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("rejects startup when channel secret is missing", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: "token",
        channelSecret: "   ",
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      }),
    ).rejects.toThrow("LINE webhook mode requires a non-empty channel secret.");
  });

  it("rejects startup when channel access token is missing", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: "   ",
        channelSecret: "secret",
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      }),
    ).rejects.toThrow("LINE webhook mode requires a non-empty channel access token.");
  });
});
