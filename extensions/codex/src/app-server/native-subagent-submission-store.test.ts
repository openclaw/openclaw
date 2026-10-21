import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { request } from "node:http";
import path from "node:path";
import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { registerNativeHookRelayForBundledRuntime } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSubagentSessionAuthority } from "./native-subagent-assignment-store.js";
import {
  createCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  agentMessage,
  collabItem,
  CodexNativeSubagentMonitor,
  createClient,
  createNativeModelSourceFixture,
  createRuntime,
  createCompletionScope,
  directSpawnItem,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentPendingAssignment as Assignment } from "./native-subagent-pending-assignments.js";
import type {
  CodexNativeSubagentSubmission as Submission,
  CodexNativeSubagentSubmissionStore as SubmissionStore,
} from "./native-subagent-submission.js";
import { scopeCodexRunBindingStore } from "./session-binding-scope.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type CodexAppServerBindingStore as BindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const currentAuthority = () => undefined;
const recordSubmission = "record-native-subagent-submission";
const consumeSubmission = "consume-native-subagent-submission";
const submissionMutations = [recordSubmission, consumeSubmission] as const;

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
const receipt: Submission = {
  parentTurnId: "parent-turn",
  callId: "call-one",
  childThreadId: "child-thread",
  submissionId: "child-turn-b",
  predecessorRunId: "codex-thread:child-thread:turn:child-turn-a",
  predecessorNativeTurnId: "child-turn-a",
};
const key = bindingStoreKey(identity);
const recordedCompletion = {
  childThreadId: "child-thread",
  status: "succeeded",
  statusLabel: "recorded_task_result",
  result: "Preserve the recorded result",
} as const;

function makeAssignment(
  owner: CodexNativeSubagentHistoryOwner,
  overrides: Partial<Assignment> = {},
): Assignment {
  return {
    runId: "codex-thread:child-thread:turn:child-turn-b",
    childThreadId: receipt.childThreadId,
    nativeTurnId: receipt.submissionId,
    nativeParentThreadId: binding.threadId,
    owner,
    ...overrides,
  };
}

function openState(root: string) {
  return createCodexSqliteTestBindingStateStore({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });
}

async function reopenStore(root: string) {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const state = openState(root);
  return { state, store: createLazyCodexAppServerBindingStore(state) };
}

async function fixture(initialReceipt?: Submission) {
  const root = tempDirs.make("codex-native-submission-");
  const state = openState(root);
  let store = createCodexAppServerBindingStore(state);
  const boundMutate = store.mutate.bind(store, identity);
  const mutate = (...args: Parameters<typeof boundMutate>) => store.mutate(identity, ...args);
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    lifecycleRevision: "revision-one",
    binding,
  });
  assert(owner, "The fixture binding must have a history owner.");
  const assertCurrent = () => {
    if (store.read(identity)?.threadId !== binding.threadId) {
      throw new Error("Cancellation binding changed");
    }
  };
  const authority = { assertCurrent, assertCurrentAsync: async () => assertCurrent() };
  const assignmentStore = {
    ...authority,
    read: () => store.readNativeSubagentAssignments?.(identity, owner) ?? Promise.resolve([]),
    record: (assignment: Assignment, guard: () => void = currentAuthority) =>
      mutate({ kind: "record-native-subagent-assignment", owner, assignment }, guard),
    consume: (assignment: Assignment, guard: () => void) =>
      mutate({ kind: "consume-native-subagent-assignment", owner, assignment }, guard),
  };
  const submissionStore = {
    ...authority,
    read: () => store.readNativeSubagentSubmissions(identity, owner),
    record: (value: Submission, guard: () => void = currentAuthority) =>
      mutate({ kind: recordSubmission, owner, receipt: value }, guard),
    consume: (value: Submission, guard: () => void) =>
      mutate({ kind: consumeSubmission, owner, receipt: value }, guard),
  };
  await mutate({ kind: "set", binding });
  if (initialReceipt) {
    await submissionStore.record(initialReceipt);
  }
  return {
    root,
    state,
    store,
    owner,
    mutate,
    assertCurrent,
    assignmentStore,
    submissionStore,
    reopen: async () => {
      ({ store } = await reopenStore(root));
    },
    rotate: (threadId: string) =>
      mutate({
        kind: "replace-thread",
        expectedThreadId: binding.threadId,
        binding: { ...binding, threadId },
      }),
    patch: (patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>) =>
      mutate({ kind: "patch", threadId: binding.threadId, patch }),
    recordAssignment: assignmentStore.record,
    recordReceipt: submissionStore.record,
    readAssignments: assignmentStore.read,
    readSubmissions: submissionStore.read,
  };
}

describe("native subagent submission receipts in the binding store", () => {
  it("persists an authenticated HTTP receipt after its startup binding lease closes", async () => {
    const { root, store, owner, readSubmissions, reopen } = await fixture();
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    let applied: boolean | undefined;
    const { relay, staleWrite } = await store.withLease(identity, async () => {
      const registration = registerNativeHookRelayForBundledRuntime({
        provider: "codex",
        sessionId: identity.sessionId,
        runId: "http-receipt",
        allowedEvents: ["post_tool_use"],
        postToolUse: {
          toolNames: ["receipt_tool"],
          observe: async (_invocation, assertCurrent) => {
            applied = await store.mutate(
              identity,
              { kind: recordSubmission, owner, receipt },
              assertCurrent,
            );
          },
        },
      });
      return {
        relay: registration,
        staleWrite: AsyncResource.bind(() =>
          store.mutate(identity, {
            kind: "patch",
            threadId: binding.threadId,
            patch: { model: "stale-writer" },
          }),
        ),
      };
    });
    try {
      await relay.ready;
      await expect(staleWrite()).rejects.toThrow("Lost Codex binding lease");
      expect(store.read(identity)).toEqual(binding);
      const bridge = await nativeHookRelayTesting.getNativeHookRelayBridgeRecordForTests(
        relay.relayId,
      );
      assert(bridge);
      const { hostname, port, token } = bridge;
      assert(typeof hostname === "string");
      assert(typeof port === "number");
      assert(typeof token === "string");
      const response = await new Promise<{ code?: number; body: string }>((resolve, reject) => {
        const outgoing = request(
          {
            hostname,
            port,
            method: "POST",
            path: "/invoke",
            agent: false,
            signal: AbortSignal.timeout(5_000),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
          },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk: string) => {
              body += chunk;
            });
            incoming.once("error", reject);
            incoming.once("end", () => resolve({ code: incoming.statusCode, body }));
          },
        );
        outgoing.once("error", reject);
        outgoing.end(
          JSON.stringify({
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            event: "post_tool_use",
            rawPayload: {
              hook_event_name: "PostToolUse",
              tool_name: "receipt_tool",
              tool_use_id: receipt.callId,
              tool_input: {},
              tool_response: {},
            },
          }),
        );
      });
      expect(response).toMatchObject({ code: 200 });
      expect(applied).toBe(true);
      expect(await readSubmissions()).toEqual([receipt]);
      await reopen();
      expect(await readSubmissions()).toEqual([receipt]);
    } finally {
      relay.unregister();
      await relay.drain();
      await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    }
  });

  it("retains recorded completion across native resume without mutating incoming facts", async () => {
    const { owner, readAssignments, recordAssignment } = await fixture();
    const assignment = makeAssignment(owner, {
      runId: "codex-thread:child-thread",
      nativeTurnId: "original-turn",
    });
    await recordAssignment({ ...assignment, recordedCompletion });
    const resumed = { ...assignment, nativeTurnId: "resumed-turn" };
    await recordAssignment(resumed);

    expect(await readAssignments()).toEqual([{ ...resumed, recordedCompletion }]);
    expect(resumed).not.toHaveProperty("recordedCompletion");
  });

  it.each([
    { nativeTurnId: "child-turn-b", reverse: false, discoverTurn: false },
    { nativeTurnId: "resumed-turn", reverse: false, discoverTurn: false },
    { nativeTurnId: "resumed-turn", reverse: true, discoverTurn: false },
    { nativeTurnId: "child-turn-b", reverse: false, discoverTurn: true },
  ])(
    "deduplicates and durably retires only the exact child turn and receipt ($nativeTurnId, reverse=$reverse, discoverTurn=$discoverTurn)",
    async ({ nativeTurnId, reverse, discoverTurn }) => {
      const { root, state, owner, mutate, readAssignments, recordReceipt, recordAssignment } =
        await fixture(receipt);
      const first = makeAssignment(owner, {
        nativeTurnId,
        ...(nativeTurnId === "child-turn-b" ? { submission: receipt } : {}),
      });
      const nextReceipt = { ...receipt, callId: "call-two", submissionId: "child-turn-c" };
      const second = {
        ...first,
        runId: "codex-thread:child-thread:turn:child-turn-c",
        nativeTurnId: "child-turn-c",
        ...(first.submission ? { submission: nextReceipt } : {}),
      };
      await recordReceipt(nextReceipt);
      const row = state.lookup(key);
      assert(row?.state === "active");
      const { submission: _submission, ...unsubmitted } = first;
      const alias = { ...unsubmitted, runId: "codex-thread:child-thread" };
      const { nativeTurnId: _nativeTurnId, ...unobserved } = alias;
      const aliases = [first, { ...(discoverTurn ? unobserved : alias), recordedCompletion }];
      if (reverse) {
        aliases.reverse();
      }
      state.register(key, {
        ...row,
        nativeSubagentAssignments: { version: 1, assignments: [...aliases, second] },
      });
      await recordAssignment(first);
      await recordAssignment(alias);
      const pending = await readAssignments();
      expect(pending).toHaveLength(2);
      expect(pending).toContainEqual({ ...first, recordedCompletion });
      await expect(
        recordAssignment({
          ...first,
          recordedCompletion: { ...recordedCompletion, result: "Conflicting result" },
        }),
      ).rejects.toThrow("Conflicting Codex native pending assignment metadata");
      const retirement = {
        kind: "consume-native-subagent-assignment" as const,
        owner,
        assignment: alias,
        undelivered: true as const,
      };
      expect(await mutate(retirement, currentAuthority)).toBe(true);
      expect(await mutate(retirement, currentAuthority)).toBe(true);
      expect(
        await mutate(
          {
            ...retirement,
            owner: { ...owner, lifecycleRevision: "other-lifecycle" },
          },
          currentAuthority,
        ),
      ).toBe(false);
      expect(
        await mutate(
          {
            ...retirement,
            assignment: { ...alias, runId: second.runId },
          },
          currentAuthority,
        ),
      ).toBe(false);
      const { store: reopened } = await reopenStore(root);
      expect(await reopened.readNativeSubagentSubmissions(identity, owner)).toEqual([nextReceipt]);
      await reopened.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: binding.threadId,
        binding: { ...binding, threadId: "rotated-parent" },
      });
      const rotated = { ...owner, parentThreadId: "rotated-parent" };
      expect(await reopened.readNativeSubagentAssignments?.(identity, rotated)).toEqual([second]);
    },
  );

  it.each(["receipt", "assignment"] as const)(
    "Stop preserves recovery across a rejected %s acknowledgement and consumes it on retry",
    async (rejectedOwner) => {
      const f = await fixture();
      const { owner, assertCurrent, reopen } = f;
      const stopReceipt = { ...receipt, predecessorRunId: "codex-thread:child-thread" };
      const { childThreadId, submissionId, predecessorNativeTurnId, parentTurnId, callId } =
        stopReceipt;
      const assignment = makeAssignment(owner, { submission: stopReceipt });
      const assignmentRecorded = createDeferred<boolean>();
      const receiptRecorded = createDeferred<boolean>();
      let reject = false;
      const assignmentStore = {
        ...f.assignmentStore,
        record: (value: Assignment, guard: () => void) => {
          const recorded = f.assignmentStore.record(value, guard);
          if (value.runId === assignment.runId && !value.submission) {
            assignmentRecorded.resolve(recorded);
          }
          return recorded;
        },
        consume: (value: Assignment, guard: () => void) =>
          reject && rejectedOwner === "assignment"
            ? Promise.resolve(false)
            : f.assignmentStore.consume(value, guard),
      };
      const consumeReceipt = vi.fn<SubmissionStore["consume"]>((value, guard) =>
        reject && rejectedOwner === "receipt"
          ? Promise.resolve(false)
          : f.submissionStore.consume(value, guard),
      );
      const submissionStore = {
        ...f.submissionStore,
        record: (value: Submission, guard: () => void) => {
          const recorded = f.submissionStore.record(value, guard);
          receiptRecorded.resolve(recorded);
          return recorded;
        },
        consume: consumeReceipt,
      };
      const client = createClient();
      const parentItem = (item: Parameters<typeof client.item>[0]) =>
        client.item(item, parentTurnId, binding.threadId);
      const activeTurn = (turnId: string) =>
        threadRead({ turnId, status: "inProgress", threadStatus: "active" });
      client.setThreadRead(childThreadId, activeTurn(predecessorNativeTurnId));
      const runtime = createRuntime();
      const custody: AgentHarnessCompletionCustody = {
        signal: new AbortController().signal,
        isCurrent: () => true,
        retain: () => custody,
        settleExecution() {},
        release() {},
      };
      runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(custody);
      const interrupt = vi.fn(async (threadId: string, turnId: string, guard: () => void) => {
        guard();
        expect([threadId, turnId]).toEqual([childThreadId, submissionId]);
        await client.completeTurn({ turnId: submissionId, status: "interrupted" });
        return true;
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        interruptChildAndWait: interrupt,
      });
      const requestCustody = Object.freeze({});
      const modelSource = createNativeModelSourceFixture(["test-model"]);
      const parent = await monitor.registerParent({
        parentThreadId: binding.threadId,
        requesterSessionKey: identity.sessionKey,
        requesterTurnRunId: "parent-run",
        requestCustody,
        agentId: identity.agentId,
        historyOwner: owner,
        completionScope: createCompletionScope(identity.sessionKey),
        modelSource,
        configurationQualification: {
          assertCurrent: modelSource.assertCurrent,
          hasProvider: (provider) => provider === "test-provider",
        },
        claimDirectChild: () => () => {},
        assignmentStore,
        submissionStore,
      });
      const stop = () =>
        monitor.withDescendantCancellation(
          {
            parentThreadId: binding.threadId,
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            sessionId: identity.sessionId,
            lifecycleRevision: owner.lifecycleRevision,
            acceptsRequest: (acceptedCustody) => acceptedCustody === requestCustody,
            assertCurrent,
          },
          (cancel) => cancel(),
        );
      try {
        await parent.ready;
        parent.bindTurn(parentTurnId);
        await notifyChildStarted(client);
        await parentItem(directSpawnItem("v1", binding.threadId, childThreadId));
        await client.startTurn(predecessorNativeTurnId);
        await client.finishTurn(
          predecessorNativeTurnId,
          agentMessage("a-final", "A result", "final_answer"),
        );
        await parentItem(
          collabItem("wait", [childThreadId], {
            id: "wait-a",
            senderThreadId: binding.threadId,
            agentsStates: {
              [childThreadId]: { status: "completed", message: "A result" },
            },
          }),
        );
        const predecessor = threadRead({
          turnId: predecessorNativeTurnId,
          result: "A result",
          resultPhase: "final_answer",
          threadStatus: "notLoaded",
        });
        predecessor.thread.modelProvider = "test-provider";
        client.setThreadRead(childThreadId, predecessor);
        await monitor.prepareModelInput({
          threadId: binding.threadId,
          turnId: parentTurnId,
          itemId: callId,
          target: childThreadId,
          readQualification: () => undefined,
          assertCurrent,
        });
        const history = activeTurn(submissionId);
        assert(history.thread.turns && predecessor.thread.turns);
        history.thread.turns.unshift(...predecessor.thread.turns);
        history.thread.modelProvider = "test-provider";
        client.setThreadRead(childThreadId, history);
        await parentItem(
          collabItem("sendInput", [childThreadId], {
            id: callId,
            senderThreadId: binding.threadId,
          }),
        );
        await client.sendInputOutput({
          parentThreadId: binding.threadId,
          turnId: parentTurnId,
          callId,
          submissionId,
        });
        await client.startTurn(submissionId);
        expect(await assignmentRecorded.promise).toBe(true);
        expect(await receiptRecorded.promise).toBe(true);
        const expectSaved = async (assignments: Assignment[], receipts: Submission[]) => {
          expect(await assignmentStore.read()).toEqual(assignments);
          expect(await submissionStore.read()).toEqual(receipts);
        };
        await expectSaved([assignment], [stopReceipt]);
        reject = true;
        const failed = await stop();
        expect(failed.killed).toBe(0);
        expect(failed.errors).toEqual([
          new Error(
            rejectedOwner === "receipt"
              ? "Cancelled native follow-up receipt was not acknowledged."
              : "Native assignment was not acknowledged.",
          ),
        ]);
        await reopen();
        await expectSaved([assignment], rejectedOwner === "receipt" ? [stopReceipt] : []);
        reject = false;
        const retried = await stop();
        expect([retried.killed, retried.errors]).toEqual([1, undefined]);
        expect(interrupt).toHaveBeenCalledOnce();
        expect(consumeReceipt).toHaveBeenCalledTimes(rejectedOwner === "receipt" ? 2 : 1);
        await reopen();
        await expectSaved([], []);
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        await parent.unregister();
        await monitor.dispose();
      }
    },
  );

  it("refuses receipt persistence after the captured parent lifecycle changes", async () => {
    const { root, owner, mutate, readSubmissions } = await fixture();
    const scope = {
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      storePath: path.join(root, "agents", identity.agentId, "sessions", "sessions.json"),
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    };
    const entry = {
      sessionId: identity.sessionId,
      lifecycleRevision: owner.lifecycleRevision,
      updatedAt: 1,
    };
    const replace = (update: () => typeof entry, fallbackEntry?: typeof entry) =>
      patchSessionEntry({
        ...scope,
        fallbackEntry,
        replaceEntry: true,
        skipMaintenance: true,
        update,
      });
    await replace(() => entry, entry);
    const parent = await captureSessionEntryCurrentCheckAsync(scope);
    using _ = { [Symbol.dispose]: () => parent.release() };
    const authority = createNativeSubagentSessionAuthority(parent);
    await replace(() => ({ ...entry, lifecycleRevision: "replacement-lifecycle" }));
    await expect(
      mutate({ kind: recordSubmission, owner, receipt }, currentAuthority, authority),
    ).rejects.toThrow();
    expect(await readSubmissions()).toEqual([]);
  });

  it("reopens initial assignment facts across native rotation but not physical adoption", async () => {
    const { root, owner, recordAssignment, rotate } = await fixture();
    const assignment = makeAssignment(owner, {
      runId: "codex-thread:initial-child",
      childThreadId: "initial-child",
      nativeTurnId: "initial-turn",
    });
    expect(await recordAssignment(assignment)).toBe(true);
    await rotate("rotated-parent");
    resetPluginStateStoreForTests();
    const reopened = createLazyCodexAppServerBindingStore(openState(root));
    const rotated = { ...owner, parentThreadId: "rotated-parent" };
    expect(await reopened.readNativeSubagentAssignments?.(identity, rotated)).toEqual([assignment]);
    expect(await reopened.readNativeSubagentSubmissions(identity, rotated)).toEqual([]);
    const successor = { ...identity, sessionId: "new-physical-session" };
    await reopened.adoptSessionGeneration(successor, identity.sessionId, currentAuthority);
    expect(
      await reopened.readNativeSubagentAssignments?.(successor, {
        ...rotated,
        sessionId: successor.sessionId,
      }),
    ).toEqual([]);
  });

  it("persists concurrent receipts across reopen and consumes only the exact submission", async () => {
    const { root, state, store, owner, mutate } = await fixture();
    const logicalIdentity = { ...identity, sessionId: "logical-parent-session" };
    const logicalOwner = { ...owner, sessionId: logicalIdentity.sessionId };
    const scope = (bindingStore: BindingStore) =>
      scopeCodexRunBindingStore({ bindingStore, logicalIdentity, physicalIdentity: identity });
    const peer = scope(createLazyCodexAppServerBindingStore(state));
    const second = {
      ...receipt,
      callId: "call-two",
      childThreadId: "second-child",
      predecessorRunId: "codex-thread:second-child:turn:child-turn-a",
    };
    const record = { kind: recordSubmission, owner, receipt } as const;
    const logicalRecord = { ...record, owner: logicalOwner };
    await expect(
      Promise.all([
        mutate(record, currentAuthority),
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

    const { state: reopenedState, store: reopenedStore } = await reopenStore(root);
    const reopened = scope(reopenedStore);
    const read = () => reopened.readNativeSubagentSubmissions(logicalIdentity, logicalOwner);
    expect(await read()).toEqual([receipt, second]);
    const consume = { ...logicalRecord, kind: consumeSubmission } as const;
    const wrongTurn = { ...consume, receipt: { ...receipt, submissionId: "wrong-turn" } };
    const consumeReceipt = (mutation: typeof consume) =>
      reopened.mutate(logicalIdentity, mutation, currentAuthority);
    expect(await consumeReceipt(wrongTurn)).toBe(false);
    expect(await consumeReceipt(consume)).toBe(true);
    expect(await consumeReceipt(consume)).toBe(true);
    expect(await read()).toEqual([second]);
    const consumeSecond = { ...consume, receipt: second };
    expect(await consumeReceipt(consumeSecond)).toBe(true);
    expect(reopenedState.lookup(key)).not.toHaveProperty("nativeSubagentSubmissions");
    expect(await consumeReceipt(consumeSecond)).toBe(false);
    expect(reopened.read(logicalIdentity)).toEqual(binding);
  });

  it.each(["missing", "retired", "generation", "actor", "thread", "connection", "lifecycle"])(
    "rejects receipt reads and writes for a %s owner without changing the binding",
    async (scenario) => {
      const { state, store, owner } = await fixture(receipt);
      let caller = identity;
      let actor: CodexNativeSubagentHistoryOwner = owner;
      if (scenario === "missing") {
        state.delete(key);
      } else if (scenario === "retired") {
        await store.retireSessionGeneration(identity);
      } else if (scenario === "generation") {
        caller = { ...identity, sessionId: "replacement-session" };
        actor = { ...owner, sessionId: caller.sessionId };
      } else if (scenario === "actor") {
        actor = { ...owner, sessionId: "unrelated-session" };
      } else if (scenario === "thread") {
        actor = { ...owner, parentThreadId: "replacement-thread" };
      } else if (scenario === "connection") {
        actor = { ...owner, connectionFingerprint: "f".repeat(64) };
      } else {
        actor = { ...owner, lifecycleRevision: "replacement-revision" };
      }
      const before = state.lookup(key);
      expect(await store.readNativeSubagentSubmissions(caller, actor)).toEqual([]);
      for (const kind of submissionMutations) {
        expect(await store.mutate(caller, { kind, owner: actor, receipt }, currentAuthority)).toBe(
          false,
        );
      }
      expect(state.lookup(key)).toEqual(before);
    },
  );

  it.each([recordSubmission, consumeSubmission] as const)(
    "rechecks current authority before the atomic %s update",
    async (kind) => {
      const { state, owner } = await fixture(receipt);
      const before = state.lookup(key);
      let current = true;
      const guarded = createCodexAppServerBindingStore({
        ...state,
        withCurrent(authority) {
          const mutationState = state.withCurrent(authority);
          return {
            ...mutationState,
            compareAndApply(stateKey, comparison, intent) {
              current = false;
              return mutationState.compareAndApply(stateKey, comparison, intent);
            },
          };
        },
      });
      await expect(
        guarded.mutate(identity, { kind, owner, receipt }, () => {
          if (!current) {
            throw new Error("Parent authority changed.");
          }
        }),
      ).rejects.toThrow("Parent authority changed.");
      expect(state.lookup(key)).toEqual(before);
    },
  );

  it("preserves receipts through same-owner writes and binding leases", async () => {
    const { state, store, mutate, readSubmissions, patch } = await fixture(receipt);
    await store.withLease(identity, async () => {
      await mutate({ kind: "set", binding: { ...binding, model: "gpt-5.5" } });
      await patch({ serviceTier: "priority" });
      expect(await readSubmissions()).toEqual([receipt]);
    });
    expect(await readSubmissions()).toEqual([receipt]);
    expect(state.lookup(key)).not.toHaveProperty("lease");
    expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5", serviceTier: "priority" });
  });

  it.each(["thread", "connection", "reset", "retire"])(
    "clears receipt metadata when the binding changes its %s boundary",
    async (scenario) => {
      const { state, store, readSubmissions, rotate, patch } = await fixture(receipt);
      if (scenario === "thread") {
        await rotate("replacement-thread");
      } else if (scenario === "connection") {
        await patch({ appServerRuntimeFingerprint: "replacement-runtime" });
      } else if (scenario === "reset") {
        await store.resetSessionGeneration(identity);
      } else {
        await store.retireSessionGeneration(identity);
      }
      expect(state.lookup(key) ?? {}).not.toHaveProperty("nativeSubagentSubmissions");
      expect(store.read(identity)).toEqual(
        scenario === "thread"
          ? { ...binding, threadId: "replacement-thread" }
          : scenario === "connection"
            ? { ...binding, appServerRuntimeFingerprint: "replacement-runtime" }
            : undefined,
      );
      expect(await readSubmissions()).toEqual([]);
    },
  );

  it.each([true, false])(
    "adopts physical sessions with lifecycle stamp present=%s",
    async (stamped) => {
      const { state, store, owner, readSubmissions, recordReceipt } = await fixture();
      if (!stamped) {
        delete owner.lifecycleRevision;
      }
      await recordReceipt(receipt);
      const successor = { ...identity, sessionId: "adopted-session" };
      expect(await store.adoptSessionGeneration(successor, identity.sessionId)).toBe("adopted");
      const successorOwner = { ...owner, sessionId: successor.sessionId };
      expect(await store.readNativeSubagentSubmissions(successor, successorOwner)).toEqual(
        stamped ? [receipt] : [],
      );
      expect(store.read(successor)).toEqual(binding);
      expect(await readSubmissions()).toEqual([]);
      if (stamped) {
        const replacement = { ...successorOwner, lifecycleRevision: "replacement-revision" };
        expect(await store.readNativeSubagentSubmissions(successor, replacement)).toEqual([]);
        expect(
          await store.mutate(
            successor,
            { kind: recordSubmission, owner: replacement, receipt },
            currentAuthority,
          ),
        ).toBe(false);
      } else {
        expect(state.lookup(bindingStoreKey(successor))).not.toHaveProperty(
          "nativeSubagentSubmissions",
        );
      }
    },
  );

  it.each([
    { version: 2, future: ["preserve-me"] },
    { version: 1, receipts: ["malformed"] },
  ])(
    "preserves unreadable receipt metadata through writes and retirement (version $version)",
    async (metadata) => {
      const { root, state, store, owner, mutate, readSubmissions, recordAssignment, patch } =
        await fixture();
      state.register(key, {
        version: 1,
        state: "active",
        sessionId: identity.sessionId,
        binding,
        nativeSubagentSubmissions: metadata,
      });
      await store.withLease(identity, async () => {
        await mutate({ kind: "set", binding });
        await patch({ model: "gpt-5.5" });
      });
      expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5" });
      const before = state.lookup(key);
      expect(before).toHaveProperty("nativeSubagentSubmissions", metadata);
      await expect(readSubmissions()).rejects.toThrow(/native subagent submission/i);
      for (const kind of submissionMutations) {
        await expect(mutate({ kind, owner, receipt }, currentAuthority)).rejects.toThrow(
          /native subagent submission/i,
        );
      }
      expect(state.lookup(key)).toEqual(before);

      const assignment = makeAssignment(owner);
      await recordAssignment(assignment);
      const retirement = {
        kind: "consume-native-subagent-assignment" as const,
        owner,
        assignment,
        undelivered: true as const,
      };
      expect(await mutate(retirement, currentAuthority)).toBe(true);
      expect(await mutate(retirement, currentAuthority)).toBe(true);
      const { state: reopenedState, store: reopened } = await reopenStore(root);
      expect(await reopened.readNativeSubagentAssignments?.(identity, owner)).toEqual([]);
      expect(reopenedState.lookup(key)).toEqual(before);
    },
  );
});
