import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { scopeCodexRunBindingStore } from "./session-binding-scope.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetPluginStateStoreForTests());
const currentAuthority = () => undefined;

const identity = {
  kind: "session" as const,
  agentId: "main",
  sessionId: "parent-session",
  sessionKey: "agent:main:submission-test",
};
const binding = {
  threadId: "parent-thread",
  cwd: "/workspace",
  appServerRuntimeFingerprint: "runtime-one",
};
const receipt: CodexNativeSubagentSubmission = {
  parentTurnId: "parent-turn",
  callId: "call-one",
  childThreadId: "child-thread",
  submissionId: "child-turn-b",
  predecessorRunId: "codex-thread:child-thread:turn:child-turn-a",
  predecessorNativeTurnId: "child-turn-a",
};

function openState(root: string) {
  return createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });
}

async function fixture(initialReceipt?: CodexNativeSubagentSubmission) {
  const root = tempDirs.make("codex-native-submission-");
  const state = openState(root);
  const store = createCodexAppServerBindingStore(state);
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    lifecycleRevision: "revision-one",
    binding,
  });
  if (!owner) {
    throw new Error("The fixture binding must have a history owner.");
  }
  await store.mutate(identity, { kind: "set", binding });
  if (initialReceipt) {
    await store.mutate(
      identity,
      { kind: "record-native-subagent-submission", owner, receipt: initialReceipt },
      currentAuthority,
    );
  }
  return { root, state, store, owner };
}

describe("native subagent submission receipts in the binding store", () => {
  it("persists concurrent receipts across reopen and consumes only the exact submission", async () => {
    const { root, state, store, owner } = await fixture();
    const logicalIdentity = { ...identity, sessionId: "logical-parent-session" };
    const logicalOwner = { ...owner, sessionId: logicalIdentity.sessionId };
    const scope = (bindingStore: CodexAppServerBindingStore) =>
      scopeCodexRunBindingStore({ bindingStore, logicalIdentity, physicalIdentity: identity });
    const peer = scope(createLazyCodexAppServerBindingStore(state));
    const second = {
      ...receipt,
      callId: "call-two",
      childThreadId: "second-child",
      predecessorRunId: "codex-thread:second-child:turn:child-turn-a",
    };
    const record = { kind: "record-native-subagent-submission" as const, owner, receipt };
    const logicalRecord = { ...record, owner: logicalOwner };
    await expect(
      Promise.all([
        store.mutate(identity, record, currentAuthority),
        peer.mutate(logicalIdentity, { ...logicalRecord, receipt: second }, currentAuthority),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(peer.mutate(logicalIdentity, logicalRecord, currentAuthority)).resolves.toBe(true);
    await expect(
      peer.mutate(
        logicalIdentity,
        { ...logicalRecord, receipt: { ...receipt, childThreadId: "wrong-child" } },
        currentAuthority,
      ),
    ).resolves.toBe(false);
    expect(store.read(identity)).toEqual(binding);

    resetPluginStateStoreForTests();
    const reopenedState = openState(root);
    const reopened = scope(createLazyCodexAppServerBindingStore(reopenedState));
    expect(reopened.readNativeSubagentSubmissions(logicalIdentity, logicalOwner)).toEqual([
      receipt,
      second,
    ]);
    const consume = { ...logicalRecord, kind: "consume-native-subagent-submission" as const };
    const wrongTurn = { ...consume, receipt: { ...receipt, submissionId: "wrong-turn" } };
    await expect(reopened.mutate(logicalIdentity, wrongTurn, currentAuthority)).resolves.toBe(
      false,
    );
    await expect(reopened.mutate(logicalIdentity, consume, currentAuthority)).resolves.toBe(true);
    await expect(reopened.mutate(logicalIdentity, consume, currentAuthority)).resolves.toBe(true);
    expect(reopened.readNativeSubagentSubmissions(logicalIdentity, logicalOwner)).toEqual([second]);
    const consumeSecond = { ...consume, receipt: second };
    await expect(reopened.mutate(logicalIdentity, consumeSecond, currentAuthority)).resolves.toBe(
      true,
    );
    expect(reopenedState.lookup(bindingStoreKey(identity))).not.toHaveProperty(
      "nativeSubagentSubmissions",
    );
    await expect(reopened.mutate(logicalIdentity, consumeSecond, currentAuthority)).resolves.toBe(
      false,
    );
    expect(reopened.read(logicalIdentity)).toEqual(binding);
  });

  it.each(["missing", "retired", "generation", "actor", "thread", "connection", "lifecycle"])(
    "rejects receipt reads and writes for a %s owner without changing the binding",
    async (scenario) => {
      const { state, store, owner } = await fixture(receipt);
      let selectedIdentity = identity;
      let selectedOwner: CodexNativeSubagentHistoryOwner = owner;
      if (scenario === "missing") {
        state.delete(bindingStoreKey(identity));
      } else if (scenario === "retired") {
        await store.retireSessionGeneration(identity);
      } else if (scenario === "generation") {
        selectedIdentity = { ...identity, sessionId: "replacement-session" };
        selectedOwner = { ...owner, sessionId: selectedIdentity.sessionId };
      } else if (scenario === "actor") {
        selectedOwner = { ...owner, sessionId: "unrelated-session" };
      } else if (scenario === "thread") {
        selectedOwner = { ...owner, parentThreadId: "replacement-thread" };
      } else if (scenario === "connection") {
        selectedOwner = { ...owner, connectionFingerprint: "f".repeat(64) };
      } else {
        selectedOwner = { ...owner, lifecycleRevision: "replacement-revision" };
      }
      const before = state.lookup(bindingStoreKey(identity));
      expect(store.readNativeSubagentSubmissions(selectedIdentity, selectedOwner)).toEqual([]);
      for (const kind of [
        "record-native-subagent-submission",
        "consume-native-subagent-submission",
      ] as const) {
        await expect(
          store.mutate(selectedIdentity, { kind, owner: selectedOwner, receipt }, currentAuthority),
        ).resolves.toBe(false);
      }
      expect(state.lookup(bindingStoreKey(identity))).toEqual(before);
    },
  );

  it.each(["record-native-subagent-submission", "consume-native-subagent-submission"] as const)(
    "rechecks current authority inside the atomic %s update",
    async (kind) => {
      const { state, owner } = await fixture(receipt);
      const before = state.lookup(bindingStoreKey(identity));
      let current = true;
      const guarded = createCodexAppServerBindingStore({
        ...state,
        update: (key, apply, options) =>
          state.update(
            key,
            (value) => {
              current = false;
              return apply(value);
            },
            options,
          ),
      });
      await expect(
        guarded.mutate(identity, { kind, owner, receipt }, () => {
          if (!current) {
            throw new Error("Parent authority changed.");
          }
        }),
      ).rejects.toMatchObject({
        cause: { message: "Parent authority changed." },
      });
      expect(state.lookup(bindingStoreKey(identity))).toEqual(before);
    },
  );

  it("preserves receipts through same-owner writes and binding leases", async () => {
    const { state, store, owner } = await fixture(receipt);
    await store.withLease(identity, async () => {
      await store.mutate(identity, { kind: "set", binding: { ...binding, model: "gpt-5.5" } });
      await store.mutate(identity, {
        kind: "patch",
        threadId: binding.threadId,
        patch: { serviceTier: "priority" },
      });
      expect(store.readNativeSubagentSubmissions(identity, owner)).toEqual([receipt]);
    });
    expect(store.readNativeSubagentSubmissions(identity, owner)).toEqual([receipt]);
    expect(state.lookup(bindingStoreKey(identity))).not.toHaveProperty("lease");
    expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5", serviceTier: "priority" });
  });

  it.each(["thread", "connection", "reset", "retire"])(
    "clears receipt metadata when the binding changes its %s boundary",
    async (scenario) => {
      const { state, store, owner } = await fixture(receipt);
      if (scenario === "thread") {
        await store.mutate(identity, {
          kind: "replace-thread",
          expectedThreadId: binding.threadId,
          binding: { ...binding, threadId: "replacement-thread" },
        });
      } else if (scenario === "connection") {
        await store.mutate(identity, {
          kind: "patch",
          threadId: binding.threadId,
          patch: { appServerRuntimeFingerprint: "replacement-runtime" },
        });
      } else if (scenario === "reset") {
        await store.resetSessionGeneration(identity);
      } else {
        await store.retireSessionGeneration(identity);
      }
      expect(state.lookup(bindingStoreKey(identity)) ?? {}).not.toHaveProperty(
        "nativeSubagentSubmissions",
      );
      expect(store.read(identity)).toEqual(
        scenario === "thread"
          ? { ...binding, threadId: "replacement-thread" }
          : scenario === "connection"
            ? { ...binding, appServerRuntimeFingerprint: "replacement-runtime" }
            : undefined,
      );
      expect(store.readNativeSubagentSubmissions(identity, owner)).toEqual([]);
    },
  );

  it.each([true, false])(
    "adopts physical sessions with lifecycle stamp present=%s",
    async (stamped) => {
      const { state, store, owner } = await fixture();
      if (!stamped) {
        delete owner.lifecycleRevision;
      }
      await store.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt },
        currentAuthority,
      );
      const successor = { ...identity, sessionId: "adopted-session" };
      await expect(store.adoptSessionGeneration(successor, identity.sessionId)).resolves.toBe(
        "adopted",
      );
      const successorOwner = { ...owner, sessionId: successor.sessionId };
      expect(store.readNativeSubagentSubmissions(successor, successorOwner)).toEqual(
        stamped ? [receipt] : [],
      );
      expect(store.read(successor)).toEqual(binding);
      expect(store.readNativeSubagentSubmissions(identity, owner)).toEqual([]);
      if (stamped) {
        const replacement = { ...successorOwner, lifecycleRevision: "replacement-revision" };
        expect(store.readNativeSubagentSubmissions(successor, replacement)).toEqual([]);
        await expect(
          store.mutate(
            successor,
            {
              kind: "record-native-subagent-submission",
              owner: replacement,
              receipt,
            },
            currentAuthority,
          ),
        ).resolves.toBe(false);
      } else {
        expect(state.lookup(bindingStoreKey(successor))).not.toHaveProperty(
          "nativeSubagentSubmissions",
        );
      }
    },
  );

  it.each([
    { version: 2, future: ["preserve-me"] },
    { version: 1, receipts: "invalid" },
  ])("preserves unreadable receipt metadata through unrelated writes", async (metadata) => {
    const { state, store, owner } = await fixture();
    state.register(bindingStoreKey(identity), {
      version: 1,
      state: "active",
      sessionId: identity.sessionId,
      binding,
      nativeSubagentSubmissions: metadata,
    });
    await store.withLease(identity, async () => {
      await store.mutate(identity, { kind: "set", binding });
      await store.mutate(identity, {
        kind: "patch",
        threadId: binding.threadId,
        patch: { model: "gpt-5.5" },
      });
    });
    expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5" });
    const before = state.lookup(bindingStoreKey(identity));
    expect(before).toHaveProperty("nativeSubagentSubmissions", metadata);
    expect(() => store.readNativeSubagentSubmissions(identity, owner)).toThrow(
      /native subagent submission/i,
    );
    for (const kind of [
      "record-native-subagent-submission",
      "consume-native-subagent-submission",
    ] as const) {
      await expect(
        store.mutate(identity, { kind, owner, receipt }, currentAuthority),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/native subagent submission/i) },
      });
    }
    expect(state.lookup(bindingStoreKey(identity))).toEqual(before);
  });
});
