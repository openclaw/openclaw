import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_TWITCH_TEST_ACCOUNT } from "./test-fixtures.js";
import type { TwitchChatMessage } from "./types.js";

const mocks = vi.hoisted(() => ({
  checkAccess: vi.fn(async () => ({ allowed: true })),
  getClient: vi.fn(async () => ({})),
  getRuntime: vi.fn(),
  onMessage: vi.fn(),
  runInbound: vi.fn(),
  sendMessage: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("./access-control.js", () => ({
  checkTwitchAccessControl: mocks.checkAccess,
}));

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({
    getClient: mocks.getClient,
    onMessage: mocks.onMessage,
    sendMessage: mocks.sendMessage,
  }),
}));

vi.mock("./runtime.js", () => ({
  getTwitchRuntime: mocks.getRuntime,
}));

import { monitorTwitchProvider } from "./monitor.js";

type InboundRunInput = {
  raw: TwitchChatMessage;
  adapter: {
    ingest: (message: TwitchChatMessage) => unknown;
    resolveTurn: (input: unknown) => Promise<{
      delivery: {
        deliver: (payload: { text: string }) => Promise<unknown>;
      };
    }>;
  };
};

describe("monitorTwitchProvider", () => {
  let replyText: string;

  beforeEach(() => {
    vi.clearAllMocks();
    replyText = "**Hello** Twitch";
    mocks.getClient.mockResolvedValue({});
    mocks.sendMessage.mockResolvedValue({ ok: true, messageId: "message-id" });
    mocks.runInbound.mockImplementation(async (input: InboundRunInput) => {
      const ingested = input.adapter.ingest(input.raw);
      const turn = await input.adapter.resolveTurn(ingested);
      await turn.delivery.deliver({ text: replyText });
    });
    mocks.getRuntime.mockReturnValue({
      logging: {
        getChildLogger: () => ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
        shouldLogVerbose: () => false,
      },
      channel: {
        inbound: {
          run: mocks.runInbound,
          buildContext: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:twitch:group:testchannel",
          })),
        },
        reply: {
          formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          recordInboundSession: vi.fn(),
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "off"),
        },
      },
    });
  });

  async function deliverMonitorReply() {
    let onMessage: ((message: TwitchChatMessage) => void) | undefined;
    mocks.onMessage.mockImplementation(
      (_account: unknown, handler: (message: TwitchChatMessage) => void) => {
        onMessage = handler;
        return mocks.unregister;
      },
    );
    const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };
    const monitor = await monitorTwitchProvider({
      account,
      accountId: "default",
      config: {},
      runtime: {},
      abortSignal: new AbortController().signal,
    });

    onMessage?.({
      username: "viewer",
      userId: "viewer-1",
      message: "hello bot",
      channel: "testchannel",
    });

    await vi.waitFor(() => {
      expect(mocks.runInbound).toHaveBeenCalledOnce();
    });
    await mocks.runInbound.mock.results[0]?.value;

    return { account, monitor };
  }

  it("delivers fallback replies through the monitor boundary", async () => {
    const { account, monitor } = await deliverMonitorReply();

    await vi.waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        account,
        "testchannel",
        "Hello Twitch",
        {},
        "default",
      );
    });

    monitor.stop();
    expect(mocks.unregister).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "tool-trace lines",
      input: "Done.\n🛠️ git status",
      expected: "Done.",
    },
    {
      name: "tool-call XML",
      input: '<tool_call>{"name":"exec"}</tool_call>Stream is live.',
      expected: "Stream is live.",
    },
    {
      name: "ordinary Markdown",
      input: "**Hello** Twitch",
      expected: "Hello Twitch",
    },
  ])("sanitizes $name before monitor delivery", async ({ input, expected }) => {
    replyText = input;
    const { account, monitor } = await deliverMonitorReply();

    expect(mocks.sendMessage).toHaveBeenCalledWith(account, "testchannel", expected, {}, "default");

    monitor.stop();
  });

  it("does not send trace-only monitor replies", async () => {
    replyText = "🛠️ git status";
    const { monitor } = await deliverMonitorReply();

    expect(mocks.sendMessage).not.toHaveBeenCalled();

    monitor.stop();
  });
});
