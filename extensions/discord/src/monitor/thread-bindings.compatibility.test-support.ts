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
      "entries" | "register" | "delete" | "update" | "deleteIf"
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
    "before-write",
    "committed-write",
    "committed-intro-unbind",
    "committed-intro-touch",
    "committed-delete-touch",
    "committed-delete-unbind",
    "missing-delete-unbind",
    "missing-delete-touch",
    "missing-delete-idle",
    "missing-delete-sibling-touch",
    "stopping-unbind",
    "queued-unbind",
    "queued-idle",
    "queued-age",
  ] as const)("settles real SQLite compatibility at %s", async (boundary) => {
    await withOpenClawTestState({ label: "discord-binding-commit-order" }, async () => {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const deleting = boundary.includes("delete");
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
      const queuedOperation = boundary.startsWith("queued-") ? boundary.slice(7) : undefined;
      let deletingMissing = false;
      stores.openKeyedStore.mockImplementation((options) => {
        const store = createPluginStateKeyedStoreForTests<ThreadBindingRecord>("discord", options);
        return {
          ...store,
          entries: async () => {
            if (deletingMissing) {
              entered.resolve();
              await finish.promise;
            }
            return await store.entries();
          },
          register: async (...args: Parameters<typeof store.register>) => {
            if (boundary === "before-write" || boundary === "stopping-unbind") {
              entered.resolve();
              await finish.promise;
            }
            await store.register(...args);
            if (boundary === "committed-write" || queuedOperation || introOperation) {
              entered.resolve();
              await finish.promise;
            }
          },
          delete: async (...args: Parameters<typeof store.delete>) => {
            const removed = await store.delete(...args);
            entered.resolve();
            await finish.promise;
            return removed;
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
      const sibling = boundary.startsWith("missing-delete-")
        ? persistedBinding("agent:main:subagent:sibling")
        : undefined;
      if (sibling) {
        sibling.key = "work:thread-sibling";
        sibling.value.threadId = "thread-sibling";
        store.register(sibling.key, sibling.value);
      }
      const siblingBefore = sibling ? store.lookup(sibling.key) : undefined;
      const manager = await persistentManager();
      if (boundary.startsWith("missing-delete-")) {
        store.delete(saved.key);
        deletingMissing = true;
      }
      const notify = vi.spyOn(manager, "notifyUnbound").mockImplementation(() => {});
      const mutation = deleting
        ? manager.unbindThread({ threadId: "thread-1" })
        : manager.bindTarget({
            threadId: "thread-1",
            channelId: "parent-1",
            targetKind: "subagent",
            targetSessionKey: bindingTarget,
            ...(introOperation ? { introText: "Binding ready" } : {}),
            agentId: "main",
            webhookId: "synthetic-webhook",
            webhookToken: "synthetic-token",
          });
      const outcome =
        boundary === "before-write" || boundary === "missing-delete-sibling-touch"
          ? expect(mutation).rejects.toThrow("changed during persistence")
          : expect(mutation).resolves.toMatchObject({
              targetSessionKey: deleting ? saved.value.targetSessionKey : bindingTarget,
            });
      let stopping: Promise<void> | undefined;
      let followup: Promise<unknown[]> | undefined;
      let followupFailure: unknown;
      try {
        await entered.promise;
        expect(store.lookup(saved.key)?.targetSessionKey).toBe(
          deleting
            ? undefined
            : boundary === "before-write" || boundary === "stopping-unbind"
              ? saved.value.targetSessionKey
              : bindingTarget,
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
        } else if (boundary === "missing-delete-sibling-touch" && sibling) {
          getSessionBindingService().touch(sibling.key, 200, {
            channel: "discord",
            accountId: "work",
          });
          expect(store.lookup(saved.key)).toBeUndefined();
          expect(manager.getByThreadId("thread-1")).toMatchObject(saved.value);
          expect(store.lookup(sibling.key)?.lastActivityAt).toBe(200);
          expect(notify).not.toHaveBeenCalled();
        } else if (queuedOperation) {
          const params = { targetSessionKey: bindingTarget, accountId: "work" };
          followup =
            queuedOperation === "unbind"
              ? unbindThreadBindingsBySessionKeyAsync({ ...params, sendFarewell: false })
              : queuedOperation === "idle"
                ? discordPlugin.conversationBindings!.setIdleTimeoutBySessionKeyAsync!({
                    ...params,
                    idleTimeoutMs: 500,
                  })
                : discordPlugin.conversationBindings!.setMaxAgeBySessionKeyAsync!({
                    ...params,
                    maxAgeMs: 1000,
                  });
          followup = followup.catch((error: unknown) => {
            followupFailure = error;
            return [];
          });
        } else if (boundary.endsWith("delete-unbind")) {
          const removed = unbindThreadBindingsBySessionKey({
            targetSessionKey: saved.value.targetSessionKey,
          });
          expect(removed).toEqual([]);
          expect(notify).not.toHaveBeenCalled();
        } else if (boundary === "missing-delete-idle") {
          const updated = discordPlugin.conversationBindings!.setIdleTimeoutBySessionKey!({
            targetSessionKey: saved.value.targetSessionKey,
            accountId: "work",
            idleTimeoutMs: 500,
          });
          expect(updated).toEqual([]);
          expect(store.lookup(saved.key)).toBeUndefined();
          expect(manager.getByThreadId("thread-1")).toMatchObject(saved.value);
          expect(notify).not.toHaveBeenCalled();
        } else {
          const at = Date.now() + 1;
          getSessionBindingService().touch(saved.key, at, {
            channel: "discord",
            accountId: "work",
          });
          expect(store.lookup(saved.key)?.lastActivityAt).toBe(deleting ? undefined : at);
          expect(manager.getByThreadId("thread-1")?.lastActivityAt).toBe(
            deleting ? saved.value.lastActivityAt : at,
          );
          expect(notify).not.toHaveBeenCalled();
        }
        if (boundary === "committed-write" || queuedOperation) {
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
          if (queuedOperation !== "unbind") {
            const field = queuedOperation === "idle" ? "idleTimeoutMs" : "maxAgeMs";
            const expected = queuedOperation === "idle" ? 500 : 1000;
            expect(store.lookup(saved.key)?.[field]).toBe(expected);
            expect(manager.getByThreadId("thread-1")?.[field]).toBe(expected);
          }
        }
        const expectedTarget =
          deleting || queuedOperation === "unbind" || boundary === "committed-intro-unbind"
            ? undefined
            : boundary === "before-write"
              ? saved.value.targetSessionKey
              : bindingTarget;
        expect(store.lookup(saved.key)?.targetSessionKey).toBe(expectedTarget);
        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
          boundary === "missing-delete-sibling-touch"
            ? saved.value.targetSessionKey
            : expectedTarget,
        );
        expect(notify).toHaveBeenCalledTimes(
          (deleting && boundary !== "missing-delete-sibling-touch") ||
            queuedOperation === "unbind" ||
            boundary === "committed-intro-unbind"
            ? 1
            : 0,
        );
        if (introOperation) {
          expect(webhookSend).toHaveBeenCalledTimes(boundary === "committed-intro-touch" ? 1 : 0);
          expect(botSend).not.toHaveBeenCalled();
        }
        if (sibling) {
          expect(store.lookup(sibling.key)).toEqual(
            boundary === "missing-delete-sibling-touch"
              ? { ...siblingBefore, lastActivityAt: 200 }
              : siblingBefore,
          );
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
