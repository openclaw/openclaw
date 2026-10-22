import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollVote } from "./test-support/approval.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

let iMessageApprovalPollTargets: typeof import("./approval-polls.js").iMessageApprovalPollTargets;
let maybeResolveIMessageApprovalPollVote: typeof import("./approval-polls.js").maybeResolveIMessageApprovalPollVote;
let listTargets: typeof import("./approval-reaction-poll-targets.js").listPendingIMessageApprovalReactionPollTargets;
let registerTarget: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTarget;
let lookupTarget: typeof import("./approval-reactions.js").resolveIMessageApprovalReactionTargetWithPersistence;
let unregisterTarget: typeof import("./approval-reactions.js").unregisterIMessageApprovalReactionTarget;
let getOptionalIMessageRuntime: typeof import("./runtime.js").getOptionalIMessageRuntime;

async function loadTargets(preservePersistentState = false) {
  await loadFreshIMessageReplyCacheForTest({
    preservePersistentState,
    reuseDatabase: preservePersistentState,
  });
  ({ iMessageApprovalPollTargets, maybeResolveIMessageApprovalPollVote } =
    await import("./approval-polls.js"));
  ({ listPendingIMessageApprovalReactionPollTargets: listTargets } =
    await import("./approval-reaction-poll-targets.js"));
  ({
    registerIMessageApprovalReactionTarget: registerTarget,
    resolveIMessageApprovalReactionTargetWithPersistence: lookupTarget,
    unregisterIMessageApprovalReactionTarget: unregisterTarget,
  } = await import("./approval-reactions.js"));
  ({ getOptionalIMessageRuntime } = await import("./runtime.js"));
}

const gatewayMocks = vi.hoisted(() => ({ resolve: vi.fn() }));

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gatewayMocks.resolve,
}));
function requireState() {
  const state = getOptionalIMessageRuntime()?.state;
  if (!state) {
    throw new Error("Expected synthetic iMessage state runtime");
  }
  return state;
}

describe("iMessage approval reaction persistence", () => {
  beforeEach(async () => {
    await loadTargets();
    gatewayMocks.resolve.mockReset().mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user" },
    });
  });

  it("joins both system-agent target indexes before completion and restores them after reset", async () => {
    const approvalKind = "system-agent";
    const pollGate = createDeferred<void>();
    const reactionGate = createDeferred<void>();
    const deletionGate = createDeferred<void>();
    const writes: Record<"poll" | "reaction", Promise<void>[]> = { poll: [], reaction: [] };
    const deletions: Promise<boolean>[] = [];
    const observeStores = () => {
      const state = requireState();
      const openStore = state.openKeyedStoreV2.bind(state);
      return vi
        .spyOn(state, "openKeyedStoreV2")
        .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
          const store = openStore<T>(options);
          const register = store.register.bind(store);
          const remove = store.delete.bind(store);
          const isPollStore = options.namespace === "imessage.approval-reaction-poll-targets";
          vi.spyOn(store, "register").mockImplementation((...args) => {
            const write = (isPollStore ? pollGate : reactionGate).promise.then(() =>
              register(...args),
            );
            writes[isPollStore ? "poll" : "reaction"].push(write);
            return write;
          });
          vi.spyOn(store, "delete").mockImplementation((...args) => {
            const deletion = remove(...args).then((removed) =>
              deletionGate.promise.then(() => removed),
            );
            deletions.push(deletion);
            return deletion;
          });
          return store;
        });
    };
    const openSpies = [observeStores()];
    const identity = {
      accountId: "restart-account",
      conversation: { chatId: 42, chatGuid: "iMessage;+;restart" },
      messageId: "restart-message",
      approvalId: "exec-restart",
      approvalKind,
      allowedDecisions: ["allow-once", "deny"] as const,
    } satisfies Parameters<typeof registerTarget>[0];
    const resolveTarget = () => lookupTarget({ ...identity, reactionKey: "👍" });
    const listAccountTargets = () => listTargets({ accountId: identity.accountId });
    const resolution = { approvalId: "exec-restart", approvalKind, decision: "allow-once" };
    const registered = vi.fn();
    const registration = registerTarget(identity).then(registered);
    try {
      expect(await resolveTarget()).toEqual(resolution);
      expect(registered).not.toHaveBeenCalled();
      pollGate.resolve();
      await Promise.all(writes.poll);
      expect(registered).not.toHaveBeenCalled();
      reactionGate.resolve();
      await registration;
      expect(registered).toHaveBeenCalledOnce();
      await loadTargets(true);
      openSpies.push(observeStores());

      expect(await listAccountTargets()).toEqual([
        expect.objectContaining({
          approvalId: "exec-restart",
          approvalKind,
          messageId: "restart-message",
          conversation: expect.objectContaining(identity.conversation),
        }),
      ]);
      expect(await resolveTarget()).toEqual(resolution);
      const deleted = vi.fn();
      const deletion = unregisterTarget(identity).then(deleted);
      expect(await listAccountTargets()).toEqual([]);
      expect(deleted).not.toHaveBeenCalled();
      deletionGate.resolve();
      await deletion;
      await loadTargets(true);
      expect(await resolveTarget()).toBeNull();
    } finally {
      pollGate.resolve();
      reactionGate.resolve();
      deletionGate.resolve();
      await Promise.allSettled([...writes.poll, ...writes.reaction, ...deletions]);
      await registration;
      openSpies.forEach((spy) => spy.mockRestore());
    }
  });

  it("resolves a persisted system-agent poll after memory reset without resolving late votes again", async () => {
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
    await loadTargets(true);

    const vote = () =>
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId,
        message: pollVote(
          pollGuid,
          [{ option_id: optionId, participant: approver, event_type: "selected" }],
          { sender: approver, chat_guid: chatGuid, is_group: true },
        ),
      });
    await expect(vote()).resolves.toBe(true);
    expect(gatewayMocks.resolve).toHaveBeenCalledExactlyOnceWith({
      cfg,
      approvalId,
      approvalKind: "system-agent",
      decision: "allow-once",
      channel: "imessage",
      accountId,
      senderId: approver,
      gatewayUrl: undefined,
    });

    await loadTargets(true);
    await expect(vote()).resolves.toBe(true);
    expect(gatewayMocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("persists new poll targets after a transient store-open failure", async () => {
    const state = requireState();
    const openStore = state.openKeyedStoreV2.bind(state);
    let failPollStore = true;
    const openSpy = vi
      .spyOn(state, "openKeyedStoreV2")
      .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
        if (options.namespace === "imessage.approval-reaction-poll-targets" && failPollStore) {
          failPollStore = false;
          throw new Error("storage temporarily unavailable");
        }
        return openStore<T>(options);
      });
    const target = {
      accountId: "recovered-account",
      conversation: { chatId: 42 },
      messageId: "recovered-message",
      approvalId: "exec-recovered",
      approvalKind: "exec" as const,
      allowedDecisions: ["allow-once", "deny"] as const,
    };
    try {
      await registerTarget(target);
      await registerTarget(target);
      await loadTargets(true);
      expect(await listTargets(target)).toEqual([
        expect.objectContaining({ approvalId: target.approvalId, messageId: target.messageId }),
      ]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.each([
    { name: "decision", approvalKind: "exec", allowedDecisions: ["allow-once", "invalid"] },
    { name: "kind", approvalKind: "unknown", allowedDecisions: ["allow-once"] },
  ])(
    "rejects persisted targets containing an invalid approval $name",
    async ({ approvalKind, allowedDecisions }) => {
      const store = requireState().openKeyedStoreV2({
        namespace: "imessage.approval-reactions",
        maxEntries: 1000,
        defaultTtlMs: 24 * 60 * 60 * 1000,
      });
      await store.register(
        "default:handle:+15551230000:corrupt-message",
        { version: 1, target: { approvalId: "exec-corrupt", approvalKind, allowedDecisions } },
        { ttlMs: 60_000 },
      );

      await expect(
        lookupTarget({
          accountId: "default",
          conversation: { handle: "+15551230000" },
          messageId: "corrupt-message",
          reactionKey: "👍",
        }),
      ).resolves.toBeNull();
    },
  );
});
