import assert from "node:assert/strict";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { RetainedLiveThread } from "./client-thread-owner.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import type { RpcRequest } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import {
  createAppServerOptions,
  createCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetThreadLifecycleTestFixtures);

async function fixture() {
  const cwd = tempDirs.make("codex-assignment-rotation-");
  const params = createParams(path.join(cwd, "session.jsonl"), cwd);
  params.agentId = "main";
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  const key = bindingStoreKey(identity);
  const values = new Map<string, StoredCodexAppServerBinding>();
  const store = createCodexAppServerBindingStore(createCodexTestBindingStateStore(values));
  let starts = 0;
  let successor: (() => Promise<ReturnType<typeof threadStartResult>>) | undefined;
  const wire = createCodexLifecycleHarness({
    respond: async (method) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        starts += 1;
        return starts > 1 && successor ? await successor() : threadStartResult(`parent-${starts}`);
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`Unexpected native lifecycle request: ${method}`);
    },
  });
  ensureCodexAppServerClientRuntime(wire.client, { agentDir: cwd });
  onTestFinished(async () => {
    await wire.client.closeAndWait();
  });
  const options = {
    client: wire.client,
    bindingStore: store,
    params,
    cwd,
    dynamicTools: [],
    appServer: createAppServerOptions(),
    nativeCodeModeEnabled: true,
    userMcpServersEnabled: false,
    mcpServersFingerprint: "mcp-before",
    mcpServersFingerprintEvaluated: true,
    appServerRuntimeFingerprint: "connection-A",
  } satisfies CodexStartOrResumeThreadParams;
  const parent = await startOrResumeThread(options);
  const releasePredecessor = vi.fn<RetainedLiveThread["release"]>(
    async (threadId, assertCurrent, withCurrent) => {
      await wire.client.request("thread/unsubscribe", { threadId }, { assertCurrent, withCurrent });
    },
  );
  await retainCodexAppServerLiveThread(
    wire.client,
    parent.threadId,
    releasePredecessor,
    parent.liveThreadConfigFingerprint,
  );
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: parent.threadId,
    sessionId: params.sessionId,
    binding: parent,
  });
  assert(owner);
  const assignments: CodexNativeSubagentPendingAssignment[] = [
    {
      runId: "codex-thread:running-child",
      childThreadId: "running-child",
      nativeParentThreadId: parent.threadId,
      owner,
    },
    {
      runId: "codex-thread:finished-child",
      childThreadId: "finished-child",
      nativeParentThreadId: parent.threadId,
      owner,
      recordedCompletion: {
        childThreadId: "finished-child",
        status: "succeeded",
        statusLabel: "recorded_task_result",
        result: "Retained child result",
        completedAt: 200,
      },
    },
  ];
  const stored = values.get(key);
  assert(stored?.state === "active");
  values.set(key, {
    ...stored,
    nativeSubagentAssignments: { version: 1, assignments },
    nativeSubagentTaskImport: { version: 1, taskIds: ["legacy-running", "legacy-finished"] },
  });
  const readAssignments = (threadId: string, binding = parent) => {
    const currentOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: threadId,
      sessionId: params.sessionId,
      binding,
    });
    assert(currentOwner);
    assert(typeof store.readNativeSubagentAssignments === "function");
    return store.readNativeSubagentAssignments(identity, currentOwner);
  };
  const readState = () => {
    const current = values.get(key);
    if (!current) {
      return undefined;
    }
    const { lease: _lease, ...durable } = current;
    return structuredClone(durable);
  };
  expect(readAssignments(parent.threadId)).toEqual(assignments);
  return {
    ...wire,
    options,
    identity,
    readState,
    store,
    parent,
    assignments,
    releasePredecessor,
    readAssignments,
    setSuccessor: (respond: () => Promise<ReturnType<typeof threadStartResult>>) => {
      successor = respond;
    },
    rotate: (patch: Partial<CodexStartOrResumeThreadParams> = {}) =>
      startOrResumeThread({ ...options, mcpServersFingerprint: "mcp-after", ...patch }),
  };
}

describe("native assignment custody across ordinary parent rotation", () => {
  it("keeps imported assignments until the ordinary replacement commits", async () => {
    const f = await fixture();
    const before = f.readState();
    const entered = createDeferred<void>();
    const proceed = createDeferred<void>();
    f.setSuccessor(async () => {
      entered.resolve();
      await proceed.promise;
      return threadStartResult("parent-2");
    });
    const pending = f.rotate();
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        settled.then(() => {
          throw new Error("Replacement settled before reaching native thread/start");
        }),
      ]);
      expect(f.readState()).toEqual(before);
      expect(f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
      expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
        f.parent.threadId,
        undefined,
        expect.any(Function),
      );
    } finally {
      proceed.resolve();
      await settled;
    }
    const replacement = await pending;
    expect(f.store.read(f.identity)?.threadId).toBe("parent-2");
    expect(f.readAssignments(replacement.threadId, replacement)).toEqual(f.assignments);
  });

  it("does not expose the old assignments through a different connection", async () => {
    const f = await fixture();
    const replacement = await f.rotate({ appServerRuntimeFingerprint: "connection-B" });
    expect(replacement.appServerRuntimeFingerprint).toBe("connection-B");
    expect(f.readAssignments(replacement.threadId, replacement)).toEqual([]);
  });

  it.each(["start", "abort", "revoked", "conflict"] as const)(
    "preserves authoritative assignments when the successor encounters %s failure",
    async (failure) => {
      const f = await fixture();
      const controller = new AbortController();
      let expected = f.readState();
      assert(expected?.state === "active");
      const predecessor = expected.binding;
      const closeHost =
        failure === "revoked"
          ? await bindProductionHarnessHostCapabilitiesForTest(f.options.params, {
              profileId: "rotation-operator",
              scopes: ["operator.write"],
              assertCurrent: () => {},
            })
          : undefined;
      if (closeHost) {
        onTestFinished(closeHost);
      }
      if (failure === "abort") {
        const mutate = f.store.mutate.bind(f.store);
        vi.spyOn(f.store, "mutate").mockImplementation((...args) => {
          if (args[1].kind === "replace-thread") {
            controller.abort(new Error("Rotation aborted"));
          }
          return mutate(...args);
        });
      }
      f.setSuccessor(async () => {
        if (failure === "start") {
          throw new Error("Successor start rejected");
        }
        if (failure === "revoked") {
          closeHost?.();
        }
        if (failure === "conflict") {
          expect(
            await f.store.mutate(f.identity, {
              kind: "replace-thread",
              expectedThreadId: f.parent.threadId,
              binding: { ...predecessor, threadId: "competing-parent" },
            }),
          ).toBe(true);
          expected = f.readState();
        }
        return threadStartResult("parent-uncommitted");
      });
      await expect(f.rotate({ signal: controller.signal })).rejects.toThrow(
        {
          start: "Successor start rejected",
          abort: "Rotation aborted",
          revoked: "agent harness host capability is no longer active",
          conflict: "Codex thread binding changed while committing a fresh thread: parent-1",
        }[failure],
      );
      expect(f.readState()).toEqual(expected);
      assert(expected?.state === "active");
      expect(f.readAssignments(expected.binding.threadId)).toEqual(f.assignments);
      expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(2);
      expect(
        f.request.mock.calls
          .filter(([method]) => method === "thread/delete")
          .map(([, params]) => params),
      ).toEqual(failure === "start" ? [] : [{ threadId: "parent-uncommitted" }]);
      expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
        f.parent.threadId,
        undefined,
        expect.any(Function),
      );
    },
  );

  it("refuses a predecessor unsubscribe revoked immediately before its wire admission", async () => {
    const f = await fixture();
    const before = f.readState();
    const controller = new AbortController();
    const release = f.releasePredecessor.getMockImplementation();
    assert(release);
    f.releasePredecessor.mockImplementationOnce(async (...args) => {
      controller.abort(new Error("Rotation revoked before unsubscribe"));
      await release(...args);
    });

    await expect(f.rotate({ signal: controller.signal })).rejects.toThrow();

    expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
      f.parent.threadId,
      undefined,
      expect.any(Function),
    );
    expect(f.request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toEqual([
      [
        "thread/unsubscribe",
        { threadId: f.parent.threadId },
        { assertCurrent: undefined, withCurrent: expect.any(Function) },
      ],
    ]);
    const methods = f.writes.map((line) => (JSON.parse(line) as RpcRequest).method);
    expect(methods.filter((method) => method === "thread/unsubscribe")).toEqual([]);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(f.readState()).toEqual(before);
    expect(f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
  });

  it("refuses a claimed predecessor before starting or committing a successor", async () => {
    const f = await fixture();
    const before = f.readState();
    const claim = await claimCodexAppServerLiveThread(f.client, f.parent.threadId);
    assert(claim);
    try {
      await expect(f.rotate()).rejects.toThrow("claimed by active work; stop it first");
      expect(f.readState()).toEqual(before);
      expect(f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
      expect(f.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
      expect(f.releasePredecessor).not.toHaveBeenCalled();
      expect(() => claim.assertCurrent()).not.toThrow();
    } finally {
      await claim.release(f.parent.threadId);
    }
  });

  it("keeps an early rotation transient until a later durable turn", async () => {
    const f = await fixture();
    await f.store.mutate(f.identity, {
      kind: "patch",
      threadId: f.parent.threadId,
      patch: { nativeSkillIsolationFingerprint: "previous-skill-policy" },
    });
    const before = f.readState();
    const transient = await startOrResumeThread({
      ...f.options,
      params: { ...f.options.params, delegationCapability: "report_only" },
    });
    expect(transient.lifecycle.preserveExistingBinding).toBe(true);
    expect(transient.liveThreadConfigFingerprint).toBeUndefined();
    expect(f.readState()).toEqual(before);
    expect(f.readAssignments(f.parent.threadId)).toEqual(f.assignments);
    expect(f.releasePredecessor).not.toHaveBeenCalled();

    const replacement = await startOrResumeThread(f.options);
    expect(replacement.threadId).toBe("parent-3");
    expect(replacement.lifecycle.preserveExistingBinding).toBeUndefined();
    expect(f.store.read(f.identity)?.threadId).toBe(replacement.threadId);
    expect(f.readAssignments(replacement.threadId, replacement)).toEqual(f.assignments);
    expect(f.releasePredecessor).toHaveBeenCalledExactlyOnceWith(
      f.parent.threadId,
      undefined,
      expect.any(Function),
    );
  });
});
