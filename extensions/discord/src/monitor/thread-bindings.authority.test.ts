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
import { discordOutbound } from "../outbound-adapter.js";
import { getDiscordRuntime } from "../runtime.js";
import * as discordSend from "../send.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import {
  autoBindSpawnedDiscordSubagent,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKeyAsync,
  unbindThreadBindingsBySessionKeyAsync,
} from "./thread-bindings.lifecycle.js";
import { createThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import {
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

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

function holdNext<T>(value: T) {
  const paused = createDeferred<void>();
  const release = createDeferred<void>();
  const respond = async () => {
    paused.resolve();
    await release.promise;
    return value;
  };
  return { paused: paused.promise, release: () => release.resolve(), respond };
}

const parentChannel = { id: PARENT, type: ChannelType.GuildText };
const spawnChild = () =>
  autoBindSpawnedDiscordSubagent({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    accountId: "default",
    channel: "discord",
    to: `channel:${PARENT}`,
    childSessionKey: "agent:main:subagent:replaced",
    agentId: "main",
  });

it("refuses direct native creates after a replacement registers during the parent lookup", async () => {
  // The first lookup resolves the spawn target; createThreadDiscord reads the parent again.
  const held = holdNext(parentChannel);
  fixture.get.mockResolvedValueOnce(parentChannel).mockImplementationOnce(held.respond);
  const binding = spawnChild();
  await held.paused;
  const replacement = await createManager();
  held.release();
  await expect(binding).resolves.toBeNull();
  expect(fixture.post).not.toHaveBeenCalled();
  expect(replacement.listBindings()).toEqual([]);
  await manager.stop();
});

it("settles a thread Discord accepted before a replacement registered, without a new webhook", async () => {
  const held = holdNext({ id: CHILD });
  fixture.get.mockResolvedValueOnce(parentChannel).mockResolvedValueOnce(parentChannel);
  fixture.post.mockImplementationOnce(held.respond);
  const binding = spawnChild();
  await held.paused;
  const replacement = await createManager();
  held.release();
  // The accepted thread is published; the follow-up webhook is refused after the handover.
  await expect(binding).resolves.toMatchObject({ threadId: CHILD, webhookId: undefined });
  expect(fixture.post.mock.calls.map(([route]) => route)).toEqual([`/channels/${PARENT}/threads`]);
  expect(replacement.getByThreadId(CHILD)).toMatchObject({
    targetSessionKey: "agent:main:subagent:replaced",
    webhookId: undefined,
  });
  const conversation = { channel: "discord", accountId: "default", conversationId: CHILD };
  await expect(
    getSessionBindingService().resolveByConversationAsync(conversation),
  ).resolves.toMatchObject({ targetSessionKey: "agent:main:subagent:replaced" });
  // Without a webhook, bound replies use the bot send path.
  const sent = {
    messageId: "reply-1",
    channelId: CHILD,
    receipt: createDiscordSendReceipt({
      platformMessageIds: ["reply-1"],
      channelId: CHILD,
      kind: "text",
    }),
  };
  fixture.bot.mockResolvedValueOnce(sent);
  await discordOutbound.sendText?.({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    to: `channel:${PARENT}`,
    text: "bound reply",
    accountId: "default",
    threadId: CHILD,
  });
  // The retired manager's intro stays suppressed; only the reply reaches the thread.
  expect(fixture.webhook).not.toHaveBeenCalled();
  expect(fixture.bot).toHaveBeenCalledExactlyOnceWith(
    `channel:${CHILD}`,
    "bound reply",
    expect.objectContaining({ accountId: "default" }),
  );
  await manager.stop();
});

it.each(["channel-lookup", "webhook-create"] as const)(
  "settles only a webhook create accepted before a replacement registered (%s)",
  async (replaceAt) => {
    const accepted = replaceAt === "webhook-create";
    const held = holdNext(accepted ? webhook : threadChannel);
    if (accepted) {
      fixture.post.mockImplementationOnce(held.respond);
    } else {
      fixture.get.mockImplementationOnce(held.respond);
    }
    const binding = manager.bindTarget({
      threadId: THREAD,
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:settled",
      agentId: "main",
    });
    await held.paused;
    const replacement = await createManager();
    held.release();
    if (accepted) {
      await expect(binding).resolves.toMatchObject({ webhookId: webhook.id });
      expect(replacement.getByThreadId(THREAD)).toMatchObject({
        targetSessionKey: "agent:main:subagent:settled",
        webhookId: webhook.id,
      });
    } else {
      await expect(binding).rejects.toThrow("Discord thread binding manager was retired");
      expect(replacement.getByThreadId(THREAD)).toBeUndefined();
    }
    expect(fixture.post.mock.calls.map(([route]) => route)).toEqual(
      accepted ? [`/channels/${PARENT}/webhooks`] : [],
    );
    await manager.stop();
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

it.each(["unbind", "idle", "max-age"] as const)(
  "orders session %s behind an accepted create across two replacements",
  async (mutation) => {
    const held = holdNext(webhook);
    fixture.post.mockImplementationOnce(held.respond);
    const target = { accountId: "default", targetSessionKey: "agent:main:subagent:joined" };
    const binding = manager.bindTarget({
      threadId: THREAD,
      targetKind: "subagent",
      targetSessionKey: target.targetSessionKey,
      agentId: "main",
    });
    await held.paused;
    const middle = await createManager();
    const replacement = await createManager();
    const mutated = vi.fn((records: ThreadBindingRecord[]) => records);
    const updating = (
      mutation === "unbind"
        ? unbindThreadBindingsBySessionKeyAsync({ ...target, sendFarewell: false })
        : mutation === "idle"
          ? setThreadBindingIdleTimeoutBySessionKeyAsync({ ...target, idleTimeoutMs: 12_345 })
          : setThreadBindingMaxAgeBySessionKeyAsync({ ...target, maxAgeMs: 23_456 })
    ).then(mutated);
    const stopped = vi.fn<() => void>();
    const stopping = replacement.stop().then(stopped);
    try {
      // A full turn lets an incorrectly detached queue finish before the accepted create.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(mutated).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      held.release();
      await Promise.allSettled([binding, updating, stopping]);
      await Promise.all([manager.stop(), middle.stop()]);
    }
    await expect(binding).resolves.toMatchObject({ targetSessionKey: target.targetSessionKey });
    await expect(updating).resolves.toHaveLength(1);
    if (mutation === "unbind") {
      expect(replacement.getByThreadId(THREAD)).toBeUndefined();
    } else {
      expect(replacement.getByThreadId(THREAD)).toMatchObject(
        mutation === "idle" ? { idleTimeoutMs: 12_345 } : { maxAgeMs: 23_456 },
      );
    }
  },
);

it.each(["before", "after"] as const)(
  "does not join a predecessor stop begun %s replacement while its sweep is pending",
  async (order) => {
    await manager.stop();
    vi.useFakeTimers();
    const held = holdNext(threadChannel);
    let stopping: Promise<void> | undefined;
    try {
      manager = await createManager({ enableSweeper: true });
      await manager.bindTarget({
        threadId: THREAD,
        channelId: PARENT,
        targetKind: "subagent",
        targetSessionKey: sessionKey,
        webhookId: webhook.id,
        webhookToken: webhook.token,
      });
      fixture.get.mockImplementationOnce(held.respond);
      await vi.advanceTimersByTimeAsync(THREAD_BINDINGS_SWEEP_INTERVAL_MS);
      await held.paused;
      const stopped = vi.fn<() => void>();
      if (order === "before") {
        stopping = manager.stop().then(stopped);
      }
      const replacement = await createManager();
      if (order === "after") {
        stopping = manager.stop().then(stopped);
      }
      const at = Date.now() + 1000;
      await expect(replacement.touchThread({ threadId: THREAD, at })).resolves.toMatchObject({
        lastActivityAt: at,
      });
      await replacement.stop();
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      held.release();
      await stopping;
      await manager.stop();
      vi.useRealTimers();
    }
  },
);
