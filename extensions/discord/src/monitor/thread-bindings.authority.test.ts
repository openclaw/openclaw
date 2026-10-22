import { ChannelType } from "discord-api-types/v10";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as discordRest from "../internal/rest.js";
import { getDiscordRuntime } from "../runtime.js";
import * as discordSend from "../send.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { unbindThreadBindingsBySessionKeyAsync } from "./thread-bindings.lifecycle.js";
import { createThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const THREAD = "111111111111111111";
const PARENT = "222222222222222222";
const CHILD = "333333333333333333";
const threadChannel = { id: THREAD, type: ChannelType.PublicThread, parent_id: PARENT };
const webhook = { id: "wh-created", token: "tok-created" };
const sessionKey = "agent:main:session-binding";

function createRestFixture() {
  const rest = new discordRest.RequestClient("synthetic-token", {
    fetch: async () => {
      throw new Error("Unexpected Discord network request");
    },
  });
  vi.spyOn(discordRest, "RequestClient").mockImplementation(function () {
    return rest;
  });
  return {
    get: vi.spyOn(rest, "get").mockResolvedValue(threadChannel),
    post: vi.spyOn(rest, "post").mockResolvedValue(webhook),
    bot: vi
      .spyOn(discordSend, "sendMessageDiscord")
      .mockRejectedValue(new Error("Unexpected binding notice")),
    webhook: vi
      .spyOn(discordSend, "sendWebhookMessageDiscord")
      .mockRejectedValue(new Error("Unexpected binding notice")),
  };
}

function createManager(overrides: Partial<Parameters<typeof createThreadBindingManager>[0]> = {}) {
  return createThreadBindingManager({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    token: "synthetic-token",
    accountId: "default",
    persist: false,
    enableSweeper: false,
    ...overrides,
  });
}

installDiscordIngressTestRuntime();
let fixture: ReturnType<typeof createRestFixture>;
let manager: Awaited<ReturnType<typeof createManager>>;

beforeEach(async () => {
  await resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  getDiscordRuntime().state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreV2ForTests<T>("discord", options, { assertCurrent() {} });
  getDiscordRuntime().state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("discord", options);
  fixture = createRestFixture();
  manager = await createManager();
});

afterEach(async () => {
  await resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["channel-lookup", "webhook-create", "child-create"] as const)(
  "preserves admission and native-create settlement after revocation during %s",
  async (revokeAt) => {
    let current = true;
    const child = revokeAt === "child-create";
    const revoke = async () => {
      current = false;
      return revokeAt === "channel-lookup" ? threadChannel : child ? { id: CHILD } : webhook;
    };
    if (revokeAt === "channel-lookup") {
      fixture.get.mockImplementationOnce(revoke);
    } else {
      fixture.post.mockImplementationOnce(revoke);
      if (child) {
        fixture.get.mockResolvedValueOnce({ id: PARENT, type: ChannelType.GuildText });
      }
    }
    const binding = getSessionBindingService().bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: child ? `channel:${PARENT}` : THREAD,
        ...(child ? { parentConversationId: `channel:${PARENT}` } : {}),
      },
      placement: child ? "child" : "current",
      ...(child ? { metadata: { introText: "Binding ready" } } : {}),
      assertCurrent() {
        if (!current) {
          throw new Error("Command owner was revoked");
        }
      },
    });
    if (revokeAt === "channel-lookup") {
      await expect(binding).rejects.toThrow("Command owner was revoked");
      expect(manager.getByThreadId(THREAD)).toBeUndefined();
    } else {
      await expect(binding).resolves.toMatchObject({ targetSessionKey: sessionKey });
      expect(manager.getByThreadId(child ? CHILD : THREAD)).toMatchObject({
        targetSessionKey: sessionKey,
        ...(child ? {} : { webhookId: webhook.id }),
      });
    }
    expect(fixture.post).toHaveBeenCalledTimes(revokeAt === "channel-lookup" ? 0 : 1);
    if (child) {
      expect(fixture.post.mock.calls[0]?.[0]).toBe(`/channels/${PARENT}/threads`);
      expect([fixture.bot.mock.calls, fixture.webhook.mock.calls]).toEqual([[], []]);
    }
  },
);

it("drains native create without blocking another account's mutations or shutdown", async () => {
  const independent = await createManager({ accountId: "independent", token: undefined });
  const independentThread = "444444444444444444";
  const target = {
    threadId: THREAD,
    channelId: PARENT,
    targetKind: "subagent" as const,
    targetSessionKey: "agent:main:subagent:drained",
    agentId: "main",
  };
  await independent.bindTarget({
    ...target,
    threadId: independentThread,
    targetSessionKey: "agent:main:subagent:independent",
    webhookId: "synthetic-independent-webhook",
    webhookToken: "synthetic-independent-token",
  });
  const entered = createDeferred<void>();
  const created = createDeferred<void>();
  fixture.post.mockImplementationOnce(async () => {
    entered.resolve();
    await created.promise;
    return webhook;
  });
  const binding = manager.bindTarget(target);
  await entered.promise;
  const unbound = vi.fn((removed: ThreadBindingRecord[]) => removed);
  const stopped = vi.fn<() => void>();
  const touched = vi.fn<() => void>();
  const touchFailed = vi.fn<(error: unknown) => void>();
  const independentStopped = vi.fn<() => void>();
  const unbinding = unbindThreadBindingsBySessionKeyAsync({
    accountId: "default",
    targetSessionKey: target.targetSessionKey,
    sendFarewell: false,
  }).then(unbound);
  const stopping = manager.stop().then(stopped);
  const touchAt = Date.now() + 1000;
  const touching = independent
    .touchThread({ threadId: independentThread, at: touchAt, persist: false })
    .then(touched, touchFailed);
  const independentStopping = independent.stop().then(independentStopped);
  try {
    // One full turn drains the independent memory-only mutation.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect([stopped.mock.calls, unbound.mock.calls, touchFailed.mock.calls]).toEqual([[], [], []]);
    await expect(manager.touchThread({ threadId: THREAD })).rejects.toThrow("stopping");
    expect(touched).toHaveBeenCalledOnce();
    expect(independentStopped).toHaveBeenCalledOnce();
    expect(independent.getByThreadId(independentThread)?.lastActivityAt).toBe(touchAt);
    expect(manager.getByThreadId(THREAD)).toBeUndefined();
  } finally {
    created.resolve();
    await Promise.allSettled([binding, unbinding, stopping, touching, independentStopping]);
  }
  await expect(binding).resolves.toMatchObject({ targetSessionKey: target.targetSessionKey });
  await expect(unbinding).resolves.toHaveLength(1);
  expect(manager.getByThreadId(THREAD)).toBeUndefined();
  expect(fixture.post).toHaveBeenCalledOnce();
});
