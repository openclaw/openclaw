import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi, type Mock } from "vitest";
import { discordPlugin } from "../channel.js";
import * as discordSend from "../send.js";
import {
  unbindThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKeyAsync,
} from "./thread-bindings.lifecycle.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingManager, ThreadBindingRecord } from "./thread-bindings.types.js";

type BindingStoreMocks = {
  openKeyedStore: Mock<
    (
      options: OpenKeyedStoreOptions,
    ) => Pick<PluginStateKeyedStore<ThreadBindingRecord>, "entries" | "register" | "delete">
  >;
  openSyncKeyedStore: Mock<
    (
      options: OpenKeyedStoreOptions,
    ) => Pick<
      PluginStateSyncKeyedStore<ThreadBindingRecord>,
      "entries" | "register" | "delete" | "update"
    >
  >;
};

export function registerThreadBindingCompatibilityTests({
  stores,
  persistedBinding,
  persistentManager,
}: {
  stores: BindingStoreMocks;
  persistedBinding: (targetSessionKey?: string) => PluginStateEntry<ThreadBindingRecord>;
  persistentManager: () => Promise<ThreadBindingManager>;
}) {
  it.each([
    "committed-intro-unbind",
    "committed-intro-touch",
    "stopping-unbind",
    "queued-unbind",
    "queued-age",
  ] as const)("settles real SQLite compatibility at %s", async (boundary) => {
    await withOpenClawTestState({ label: "discord-binding-commit-order" }, async () => {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const introOperation = boundary.startsWith("committed-intro-");
      const webhookSend = introOperation
        ? vi
            .spyOn(discordSend, "sendWebhookMessageDiscord")
            .mockRejectedValue(new Error("Synthetic transport boundary"))
        : undefined;
      const botSend = introOperation
        ? vi
            .spyOn(discordSend, "sendMessageDiscord")
            .mockRejectedValue(new Error("Unexpected bot intro"))
        : undefined;
      const queuedOperation = boundary.startsWith("queued-");
      stores.openKeyedStore.mockImplementation((options) => {
        const store = createPluginStateKeyedStoreForTests<ThreadBindingRecord>("discord", options);
        return {
          ...store,
          register: async (...args: Parameters<typeof store.register>) => {
            if (boundary === "stopping-unbind") {
              entered.resolve();
              await finish.promise;
            }
            await store.register(...args);
            if (queuedOperation || introOperation) {
              entered.resolve();
              await finish.promise;
            }
          },
        };
      });
      stores.openSyncKeyedStore.mockImplementation((options) =>
        createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", options),
      );
      const saved = persistedBinding();
      const bindingTarget = introOperation
        ? saved.value.targetSessionKey
        : "agent:main:subagent:replacement";
      const store = createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", {
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      store.register(saved.key, saved.value);
      const manager = await persistentManager();
      const notify = vi.spyOn(manager, "notifyUnbound").mockImplementation(() => {});
      const mutation = manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: bindingTarget,
        ...(introOperation ? { introText: "Binding ready" } : {}),
        agentId: "main",
        webhookId: "synthetic-webhook",
        webhookToken: "synthetic-token",
      });
      const outcome = expect(mutation).resolves.toMatchObject({
        targetSessionKey: bindingTarget,
      });
      let stopping: Promise<void> | undefined;
      let followup: Promise<unknown[]> | undefined;
      let followupFailure: unknown;
      try {
        await entered.promise;
        expect(store.lookup(saved.key)?.targetSessionKey).toBe(
          boundary === "stopping-unbind" ? saved.value.targetSessionKey : bindingTarget,
        );
        if (boundary === "committed-intro-unbind") {
          expect(
            unbindThreadBindingsBySessionKey({
              targetSessionKey: saved.value.targetSessionKey,
              sendFarewell: false,
            }),
          ).toHaveLength(1);
          expect(store.lookup(saved.key)).toBeUndefined();
          expect(manager.getByThreadId("thread-1")).toBeUndefined();
        } else if (boundary === "stopping-unbind") {
          stopping = manager.stop();
          expect(() =>
            unbindThreadBindingsBySessionKey({ targetSessionKey: saved.value.targetSessionKey }),
          ).toThrow("manager is stopping");
          expect(store.lookup(saved.key)).toEqual(saved.value);
          expect(notify).not.toHaveBeenCalled();
        } else if (queuedOperation) {
          const params = { targetSessionKey: bindingTarget, accountId: "work" };
          followup =
            boundary === "queued-unbind"
              ? unbindThreadBindingsBySessionKeyAsync({ ...params, sendFarewell: false })
              : discordPlugin.conversationBindings!.setMaxAgeBySessionKeyAsync!({
                  ...params,
                  maxAgeMs: 1000,
                });
          followup = followup.catch((error: unknown) => {
            followupFailure = error;
            return [];
          });
        } else {
          const at = Date.now() + 1;
          getSessionBindingService().touch(saved.key, at, {
            channel: "discord",
            accountId: "work",
          });
          expect(store.lookup(saved.key)?.lastActivityAt).toBe(at);
          expect(manager.getByThreadId("thread-1")?.lastActivityAt).toBe(at);
          expect(notify).not.toHaveBeenCalled();
        }
        if (queuedOperation) {
          let stopped = false;
          stopping = manager.stop().then(() => {
            stopped = true;
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(stopped).toBe(false);
        }
        finish.resolve();
        await outcome;
        await stopping;
        if (followup) {
          const changed = await followup;
          expect(followupFailure).toBeUndefined();
          expect(changed).toHaveLength(1);
          if (boundary === "queued-age") {
            expect(store.lookup(saved.key)?.maxAgeMs).toBe(1000);
            expect(manager.getByThreadId("thread-1")?.maxAgeMs).toBe(1000);
          }
        }
        const expectedTarget =
          boundary === "committed-intro-unbind" || boundary === "queued-unbind"
            ? undefined
            : bindingTarget;
        expect(store.lookup(saved.key)?.targetSessionKey).toBe(expectedTarget);
        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(expectedTarget);
        expect(notify).toHaveBeenCalledTimes(
          boundary === "committed-intro-unbind" || boundary === "queued-unbind" ? 1 : 0,
        );
        if (introOperation) {
          expect(webhookSend).toHaveBeenCalledTimes(boundary === "committed-intro-touch" ? 1 : 0);
          expect(botSend).not.toHaveBeenCalled();
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([outcome, stopping]);
        await manager.stop();
        await resetThreadBindingsForTests();
        resetPluginStateStoreForTests();
        webhookSend?.mockRestore();
        botSend?.mockRestore();
      }
    });
  });
}
