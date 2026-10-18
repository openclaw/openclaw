// Twitch tests cover client manager registry plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
} from "./client-manager-registry.js";
import { twitchOutbound } from "./outbound.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchTestConfig } from "./test-fixtures.js";
import type { ChannelLogSink, TwitchAccountConfig } from "./types.js";

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function StaticAuthProvider() {},
  RefreshingAuthProvider: function RefreshingAuthProvider() {},
}));

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    private ready: (() => void) | undefined;
    onAuthenticationSuccess(handler: () => void) {
      this.ready = handler;
      return { unbind() {} };
    }
    onAuthenticationFailure = vi.fn(() => ({ unbind() {} }));
    onDisconnect = vi.fn(() => ({ unbind() {} }));
    onMessage = vi.fn(() => ({ unbind() {} }));
    connect = () => this.ready?.();
    quit = vi.fn();
    say = vi.fn(async (_channel: string, _message: string) => {});
  },
  LogLevel: { WARNING: 2 },
}));

function makeLogger(): ChannelLogSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const account = {
  ...BASE_TWITCH_TEST_ACCOUNT,
  accessToken: "oauth:test-token",
  enabled: true,
} satisfies TwitchAccountConfig;

async function attachFakeTransport(manager: ReturnType<typeof getOrCreateClientManager>) {
  const transport = await manager.getClient(account, makeTwitchTestConfig(account), "default");
  manager.onMessage(vi.fn());
  return {
    quit: vi.spyOn(transport, "quit"),
    say: vi.spyOn(transport, "say"),
  };
}

describe("client manager registry", () => {
  afterEach(async () => {
    await removeClientManager("default");
  });

  it.each(["resolves", "rejects"] as const)(
    "retires managers immediately and preserves replacements when cleanup %s",
    async (outcome) => {
      const logger = makeLogger();
      const firstManager = getOrCreateClientManager("default", logger);
      const transport = await attachFakeTransport(firstManager);
      const cleanup = createDeferred<void>();
      const disconnect = firstManager.disconnectAll.bind(firstManager);
      const disconnectAll = vi.spyOn(firstManager, "disconnectAll").mockImplementation(async () => {
        await disconnect();
        await cleanup.promise;
      });
      const removal = removeClientManager("default");

      try {
        expect(disconnectAll).toHaveBeenCalledOnce();
        expect(transport.quit).toHaveBeenCalledOnce();
        expect(getClientManager("default")).toBeUndefined();

        const replacement = getOrCreateClientManager("default", makeLogger());
        expect(replacement).not.toBe(firstManager);

        if (outcome === "rejects") {
          const disconnectError = new Error("disconnect failed");
          const rejected = expect(removal).rejects.toBe(disconnectError);
          cleanup.reject(disconnectError);
          await rejected;
        } else {
          cleanup.resolve();
          await expect(removal).resolves.toBeUndefined();
        }

        expect(getClientManager("default")).toBe(replacement);
      } finally {
        cleanup.resolve();
        await removal.catch(() => undefined);
      }
    },
  );

  it("keeps outbound delivery off a retired manager and sends through its replacement", async () => {
    const logger = makeLogger();
    const firstManager = getOrCreateClientManager("default", logger);
    const first = await attachFakeTransport(firstManager);
    const cleanup = createDeferred<void>();
    const disconnect = firstManager.disconnectAll.bind(firstManager);
    vi.spyOn(firstManager, "disconnectAll").mockImplementation(async () => {
      await disconnect();
      await cleanup.promise;
    });
    const reconnect = vi.spyOn(firstManager, "getClient");
    const config = makeTwitchTestConfig(account);
    const removal = removeClientManager("default");

    try {
      await expect(
        twitchOutbound.sendText!({
          to: "#testchannel",
          text: "while retiring",
          cfg: config,
          accountId: "default",
        }),
      ).rejects.toThrow(
        "Client manager not found for account: default. Please start the Twitch gateway first.",
      );
      expect(reconnect).not.toHaveBeenCalled();
      expect(first.say).not.toHaveBeenCalled();

      const replacement = getOrCreateClientManager("default", makeLogger());
      const transport = await attachFakeTransport(replacement);
      const afterRestart = await twitchOutbound.sendText!({
        to: "#testchannel",
        text: "after restart",
        cfg: config,
        accountId: "default",
      });

      expect(afterRestart.messageId).toEqual(expect.any(String));
      expect(afterRestart.receipt?.platformMessageIds).toEqual([afterRestart.messageId]);
      expect(transport.say).toHaveBeenCalledWith("testchannel", "after restart");

      cleanup.resolve();
      await expect(removal).resolves.toBeUndefined();
      expect(getClientManager("default")).toBe(replacement);
    } finally {
      cleanup.resolve();
      await removal.catch(() => undefined);
    }
  });
});
