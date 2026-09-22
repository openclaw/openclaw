import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPendingIMessageApprovalReactionPollTargets } from "./approval-reaction-poll-targets.js";
import {
  clearIMessageApprovalReactionTargetsForTest,
  registerIMessageApprovalReactionTarget,
  resolveIMessageApprovalReactionTargetWithPersistence,
  unregisterIMessageApprovalReactionTarget,
} from "./approval-reactions.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

describe("iMessage approval reaction persistence", () => {
  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
  });

  it("joins both persistent target indexes before completion and restores them after reset", async () => {
    installIMessageStateRuntimeForTest();
    clearIMessageApprovalReactionTargetsForTest();
    const state = getOptionalIMessageRuntime()?.state;
    if (!state) {
      throw new Error("Expected synthetic iMessage state runtime");
    }
    const openStore = state.openKeyedStore.bind(state);
    const pollGate = createDeferred<void>();
    const reactionGate = createDeferred<void>();
    const deletionGate = createDeferred<void>();
    const writes: Promise<void>[] = [];
    const deletions: Promise<boolean>[] = [];
    const pollWrites: Promise<void>[] = [];
    const openSpy = vi
      .spyOn(state, "openKeyedStore")
      .mockImplementation(<T>(options: OpenKeyedStoreOptions) => {
        const store = openStore<T>(options);
        const register = store.register.bind(store);
        const remove = store.delete.bind(store);
        const isPollStore = options.namespace === "imessage.approval-reaction-poll-targets";
        vi.spyOn(store, "register").mockImplementation((...args) => {
          const write = (async () => {
            await (isPollStore ? pollGate.promise : reactionGate.promise);
            await register(...args);
          })();
          writes.push(write);
          if (isPollStore) {
            pollWrites.push(write);
          }
          return write;
        });
        vi.spyOn(store, "delete").mockImplementation((...args) => {
          const deletion = (async () => {
            const removed = await remove(...args);
            await deletionGate.promise;
            return removed;
          })();
          deletions.push(deletion);
          return deletion;
        });
        return store;
      });
    const identity = {
      accountId: "restart-account",
      conversation: { chatId: 42, chatGuid: "iMessage;+;restart" },
      messageId: "restart-message",
    };
    let registered = false;
    const registration = Promise.resolve(
      registerIMessageApprovalReactionTarget({
        ...identity,
        approvalId: "exec-restart",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      }),
    ).then(() => {
      registered = true;
    });
    try {
      expect(
        await resolveIMessageApprovalReactionTargetWithPersistence({
          ...identity,
          reactionKey: "👍",
        }),
      ).toEqual({
        approvalId: "exec-restart",
        approvalKind: "exec",
        decision: "allow-once",
      });
      expect(registered).toBe(false);
      pollGate.resolve();
      await Promise.all(pollWrites);
      expect(registered).toBe(false);
      reactionGate.resolve();
      await registration;
      expect(registered).toBe(true);

      clearIMessageApprovalReactionTargetsForTest();

      expect(
        await listPendingIMessageApprovalReactionPollTargets({ accountId: "restart-account" }),
      ).toEqual([
        expect.objectContaining({
          approvalId: "exec-restart",
          messageId: "restart-message",
          conversation: expect.objectContaining({ chatId: 42, chatGuid: "iMessage;+;restart" }),
        }),
      ]);
      expect(
        await resolveIMessageApprovalReactionTargetWithPersistence({
          ...identity,
          reactionKey: "👍",
        }),
      ).not.toBeNull();

      let deleted = false;
      const deletion = Promise.resolve(unregisterIMessageApprovalReactionTarget(identity)).then(
        () => {
          deleted = true;
        },
      );
      expect(
        await listPendingIMessageApprovalReactionPollTargets({ accountId: "restart-account" }),
      ).toEqual([]);
      expect(deleted).toBe(false);
      deletionGate.resolve();
      await deletion;
      clearIMessageApprovalReactionTargetsForTest();
      expect(
        await resolveIMessageApprovalReactionTargetWithPersistence({
          ...identity,
          reactionKey: "👍",
        }),
      ).toBeNull();
    } finally {
      pollGate.resolve();
      reactionGate.resolve();
      deletionGate.resolve();
      await Promise.allSettled([...writes, ...deletions]);
      await registration;
      openSpy.mockRestore();
    }
  });

  it("rejects persisted targets containing an invalid approval decision", async () => {
    installIMessageStateRuntimeForTest();
    clearIMessageApprovalReactionTargetsForTest();
    const store = getOptionalIMessageRuntime()?.state.openKeyedStore({
      namespace: "imessage.approval-reactions",
      maxEntries: 1000,
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
    if (!store) {
      throw new Error("Expected iMessage approval reaction state store");
    }
    await store.register(
      "default:handle:+15551230000:corrupt-message",
      {
        version: 1,
        target: {
          approvalId: "exec-corrupt",
          approvalKind: "exec",
          allowedDecisions: ["allow-once", "invalid"],
        },
      },
      { ttlMs: 60_000 },
    );

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "corrupt-message",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });
});
