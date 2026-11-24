import { join } from "node:path";
import type { ChatClientOptions } from "@twurple/chat";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getClientManager, removeClientManager } from "./client-manager-registry.js";
import { monitorTwitchProvider } from "./monitor.js";
import { setTwitchRuntime } from "./runtime.js";
import type { TwitchChatMessage } from "./types.js";

const mocks = vi.hoisted(() => ({
  createIngress: vi.fn<typeof import("./twitch-ingress.js").createTwitchIngress>(),
  constructed: vi.fn<(options: ChatClientOptions) => void>(),
  say: vi.fn(async () => undefined),
}));

// mock-isolation: The real registry and manager run against a fake chat socket.
vi.mock("./twitch-ingress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twitch-ingress.js")>()),
  createTwitchIngress: mocks.createIngress,
}));
vi.mock("./token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token.js")>()),
  resolveTwitchToken: vi.fn(() => ({ token: "oauth:mock-token" })),
}));
vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function MockStaticAuthProvider() {},
}));
vi.mock("@twurple/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@twurple/chat")>()),
  ChatClient: class {
    private ready: Array<() => void> = [];
    constructor(options: ChatClientOptions) {
      mocks.constructed(options);
    }
    onMessage = vi.fn(() => ({ unbind: () => {} }));
    onAuthenticationSuccess = vi.fn((handler: () => void) => {
      this.ready.push(handler);
      return { unbind: () => {} };
    });
    onAuthenticationFailure = vi.fn(() => ({ unbind: () => {} }));
    onDisconnect = vi.fn(() => ({ unbind: () => {} }));
    connect = vi.fn(() => {
      for (const handler of this.ready) {
        handler();
      }
    });
    say = mocks.say;
    quit = vi.fn();
  },
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "twitch-stop-");

describe("Twitch monitor stop", () => {
  it("does not reconnect a stopped account when a reply finishes late", async () => {
    const accountId = "stopped-account";
    const core = createPluginRuntimeMock();
    setTwitchRuntime(core);
    vi.mocked(core.channel.routing.resolveAgentRoute).mockReturnValue({
      agentId: "main",
      channel: "twitch",
      accountId,
      sessionKey: "agent:main:twitch:group:testchannel",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    const replyGate = createDeferred<void>();
    const replyResult = createDeferred<unknown>();
    vi.mocked(core.channel.inbound.run).mockImplementation(async (input) => {
      const normalized = await input.adapter.ingest(input.raw);
      if (!normalized) {
        throw new Error("Expected a normalized message");
      }
      const turn = await input.adapter.resolveTurn(
        normalized,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      if (!("delivery" in turn)) {
        throw new Error("Expected a reply delivery turn");
      }
      // The agent is still writing its reply when the account stops.
      await replyGate.promise;
      replyResult.resolve(await turn.delivery.deliver({ text: "late reply" }, { kind: "final" }));
      return { admission: { kind: "handled", reason: "stop fixture" }, dispatched: false };
    });
    const pending: Promise<void>[] = [];
    mocks.createIngress.mockImplementation((options) => ({
      accept: async (message: TwitchChatMessage) => {
        const delivery = options.deliver(message, {
          admission: "exclusive",
          abortSignal: new AbortController().signal,
          onAdopted: async () => {},
          onDeferred: () => {},
          onAbandoned: async () => {},
        });
        pending.push(delivery);
        await delivery;
      },
      start: () => {},
      // The real ingress also waits for admitted reply lanes before it stops.
      stop: async () => {
        await Promise.allSettled(pending);
      },
    }));
    const error = vi.fn();
    const abort = new AbortController();
    const monitor = await monitorTwitchProvider({
      account: {
        username: "testbot",
        clientId: "test-client-id",
        channel: "testchannel",
        accessToken: "oauth:test-token",
      },
      accountId,
      channelRuntime: core.channel,
      config: { session: { store: join(sessionDirs.make(), "sessions.json") } },
      runtime: { error, log: vi.fn() },
      abortSignal: abort.signal,
    });
    const manager = getClientManager(accountId) as unknown as {
      messageHandler?: { handler: (message: TwitchChatMessage) => void };
    };
    manager.messageHandler?.handler({
      id: "message-1",
      username: "viewer",
      userId: "viewer-1",
      message: "@testbot hello",
      channel: "testchannel",
      chatType: "group",
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // Gateway stop order: abort the account task, then run plugin stopAccount.
    abort.abort();
    await removeClientManager(accountId);
    replyGate.resolve();
    await expect(replyResult.promise).resolves.toEqual({ visibleReplySent: false });
    await monitor.stop();

    expect(getClientManager(accountId)).toBeUndefined();
    expect(mocks.constructed).toHaveBeenCalledOnce();
    expect(mocks.say).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      `Failed to send reply: Error: Client manager not found for account: ${accountId}. Please start the Twitch gateway first.`,
    );
  });
});
