import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  iMessageApprovalPollTargets,
  maybeResolveIMessageApprovalPollVote,
} from "./approval-polls.js";
import { listPendingIMessageApprovalReactionPollTargets } from "./approval-reaction-poll-targets.js";
import {
  clearIMessageApprovalReactionTargetsForTest,
  registerIMessageApprovalReactionTarget,
  resolveIMessageApprovalReactionTargetWithPersistence,
  unregisterIMessageApprovalReactionTarget,
} from "./approval-reactions.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const gatewayMocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gatewayMocks.resolveApprovalOverGateway,
}));

describe("iMessage approval reaction persistence", () => {
  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    iMessageApprovalPollTargets.clearForTest();
    gatewayMocks.resolveApprovalOverGateway.mockReset().mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user" },
    });
  });

  it.each(["exec", "system-agent"] as const)(
    "joins both %s target indexes before completion and restores them after reset",
    async (approvalKind) => {
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
        .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
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
          approvalKind,
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
          approvalKind,
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
            approvalKind,
            messageId: "restart-message",
            conversation: expect.objectContaining({ chatId: 42, chatGuid: "iMessage;+;restart" }),
          }),
        ]);
        expect(
          await resolveIMessageApprovalReactionTargetWithPersistence({
            ...identity,
            reactionKey: "👍",
          }),
        ).toEqual({ approvalId: "exec-restart", approvalKind, decision: "allow-once" });

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
    },
  );

  it("resolves a persisted system-agent poll after memory reset without resolving late votes again", async () => {
    installIMessageStateRuntimeForTest();
    const accountId = "poll-restart";
    const approver = "+15551230000";
    const chatGuid = "iMessage;+;system-agent-poll-restart";
    const pollGuid = "system-agent-poll-restart-guid";
    const approvalId = "system-agent:poll-restart";
    const optionId = "system-agent-poll-allow-once";
    const cfg = { channels: { imessage: { allowFrom: [approver] } } };
    await expect(
      iMessageApprovalPollTargets.register({
        accountId,
        conversation: { chatGuid },
        pollGuid,
        approvalId,
        approvalKind: "system-agent",
        optionDecisions: [[optionId, "allow-once"]],
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toBe(true);
    iMessageApprovalPollTargets.clearForTest();

    const vote = () =>
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId,
        message: {
          sender: approver,
          chat_guid: chatGuid,
          is_group: true,
          poll: {
            kind: "vote",
            original_guid: pollGuid,
            votes: [{ option_id: optionId, participant: approver, event_type: "selected" }],
          },
        },
      });
    await expect(vote()).resolves.toBe(true);
    expect(gatewayMocks.resolveApprovalOverGateway).toHaveBeenCalledExactlyOnceWith({
      cfg,
      approvalId,
      approvalKind: "system-agent",
      decision: "allow-once",
      channel: "imessage",
      accountId,
      senderId: approver,
      gatewayUrl: undefined,
    });

    iMessageApprovalPollTargets.clearForTest();
    await expect(vote()).resolves.toBe(true);
    expect(gatewayMocks.resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "decision", approvalKind: "exec", allowedDecisions: ["allow-once", "invalid"] },
    { name: "kind", approvalKind: "unknown", allowedDecisions: ["allow-once"] },
  ])("rejects persisted targets containing an invalid approval $name", async (invalid) => {
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
          approvalKind: invalid.approvalKind,
          allowedDecisions: invalid.allowedDecisions,
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
