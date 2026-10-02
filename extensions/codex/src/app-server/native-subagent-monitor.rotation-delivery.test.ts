// A detached parent's native child completes after the parent's Codex thread
// rotated (same session, lifecycle, and connection). Delivery must follow the
// rotation to the rightful requester exactly once; any other ownership change
// must still reject, and nothing is dropped without a logged reason.
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSubagentAssignmentStore } from "./native-subagent-assignment-store.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createCompletionScope,
  createRuntime,
  nativeCompletionNotification,
  nativeHistoryOwner,
  notifyChildStarted,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";

const REQUESTER = "agent:main:main";

type FakeBinding = {
  threadId: string;
  cwd: string;
  appServerRuntimeFingerprint?: string;
  pendingSupervisionBranch?: unknown;
};

function createFakeBindingStore(binding: { current: FakeBinding | undefined }) {
  const persisted = new Map<string, CodexNativeSubagentPendingAssignment[]>();
  return {
    read: () => (binding.current ? { ...binding.current } : undefined),
    readNativeSubagentAssignments: (_identity: unknown, owner: { parentThreadId: string }) => [
      ...(persisted.get(owner.parentThreadId) ?? []),
    ],
    mutate: async (
      _identity: unknown,
      mutation: {
        kind: string;
        owner: { parentThreadId: string };
        assignment: CodexNativeSubagentPendingAssignment;
      },
      assertCurrent: () => void,
    ) => {
      assertCurrent();
      const entries = (persisted.get(mutation.owner.parentThreadId) ?? []).filter(
        (entry) => entry.runId !== mutation.assignment.runId,
      );
      if (mutation.kind === "record-native-subagent-assignment") {
        entries.push(mutation.assignment);
      }
      persisted.set(mutation.owner.parentThreadId, entries);
      return true;
    },
  };
}

function createHarness(options: { identitySessionId?: string } = {}) {
  const warn = vi.spyOn(embeddedAgentLog, "warn");
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
    recoveryPollDelaysMs: [],
  });
  const binding: { current: FakeBinding | undefined } = {
    current: { threadId: "parent-thread", cwd: "/tmp", appServerRuntimeFingerprint: "connection-A" },
  };
  const lifecycle = { revision: "revision-1" };
  const bindingStore = createFakeBindingStore(binding);
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: options.identitySessionId ?? "physical-1",
  };
  const createStore = (parentThreadId: string) => {
    const owner = nativeHistoryOwner(parentThreadId);
    // Mirrors run-attempt-resources: strict submission binding + parent lifecycle.
    return createNativeSubagentAssignmentStore({
      bindingStore: bindingStore as never,
      identity,
      owner,
      assertLifecycleCurrent: () => {
        const current = binding.current;
        if (!current || current.threadId !== owner.parentThreadId) {
          throw new Error("Native submission binding is no longer current.");
        }
        if (lifecycle.revision !== owner.lifecycleRevision) {
          throw new Error("Native submission session lifecycle is no longer current.");
        }
      },
      readParentSession: () => ({ sessionId: "physical-1", lifecycleRevision: lifecycle.revision }),
    });
  };
  const register = (parentThreadId: string) =>
    monitor.registerParent({
      parentThreadId,
      agentId: "main",
      requesterSessionKey: REQUESTER,
      completionScope: createCompletionScope(REQUESTER),
      historyOwner: nativeHistoryOwner(parentThreadId),
      assignmentStore: createStore(parentThreadId),
    });
  const rotate = async () => {
    binding.current = { ...binding.current!, threadId: "rotated-parent" };
    const parentB = await register("rotated-parent");
    await parentB.unregister();
  };
  const complete = (agentPath: string, result: string) =>
    client.notify(
      nativeCompletionNotification({ parentThreadId: "parent-thread", agentPath, result }),
    );
  const delivered = () =>
    runtime.deliverAgentHarnessCompletion.mock.calls.map((call) => call[0].childSessionId);
  const warnings = (message: string) =>
    warn.mock.calls.filter(([entry]) => entry === message).map((call) => call[1]);
  const dispose = async () => {
    await monitor.dispose();
    client.close();
  };
  return {
    binding,
    lifecycle,
    client,
    runtime,
    register,
    rotate,
    complete,
    delivered,
    warnings,
    dispose,
  };
}

async function spawnTwoAndDetach(harness: ReturnType<typeof createHarness>) {
  const parentA = await harness.register("parent-thread");
  await notifyChildStarted(harness.client, "parent-thread", "child-fast", "/root/fast");
  await notifyChildStarted(harness.client, "parent-thread", "child-slow", "/root/slow");
  await parentA.unregister();
  await harness.complete("/root/fast", "fast result");
  expect(harness.delivered()).toEqual(["child-fast"]);
}

describe("native completion after parent thread rotation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers a rotated parent's child completion exactly once to the requester", async () => {
    const harness = createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await spawnTwoAndDetach(harness);
      await harness.rotate();
      const admissions: Array<boolean | undefined> = [];
      harness.runtime.deliverAgentHarnessCompletion.mockImplementation(async (params) => {
        // Host-side source-session admission runs during delivery.
        admissions.push(params.isSourceSessionAdmissionAllowed?.());
        return { delivered: true, path: "direct" };
      });
      await harness.complete("/root/slow", "slow result");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast", "child-slow"]);
      expect(admissions).toEqual([true]);
      const slow = harness.runtime.deliverAgentHarnessCompletion.mock.calls[1]![0];
      expect(slow.scope.requesterSessionKey).toBe(REQUESTER);
      expect(slow.expectedRequester).toEqual({
        sessionId: "physical-1",
        lifecycleRevision: "revision-1",
      });
      expect(slow.announceId).toBe("codex-native:parent-thread:child-slow:succeeded");
      expect(slow.result).toBe("slow result");
      expect(harness.warnings("Dropping native completion")).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("does not deliver twice when the delivering announce itself rotates the thread", async () => {
    const harness = createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      harness.runtime.deliverAgentHarnessCompletion.mockImplementationOnce(async () => {
        // The announce turn starts a fresh Codex thread and rewrites the binding.
        harness.binding.current = { ...harness.binding.current!, threadId: "rotated-parent" };
        return { delivered: true, path: "direct" };
      });
      const parentA = await harness.register("parent-thread");
      await notifyChildStarted(harness.client, "parent-thread", "child-fast", "/root/fast");
      await parentA.unregister();
      await harness.complete("/root/fast", "fast result");
      await harness.complete("/root/fast", "fast result");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast"]);
      expect(harness.warnings("Dropping native completion")).toEqual([]);
      expect(harness.warnings("Holding native completion with unresolved history owner")).toEqual(
        [],
      );
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    {
      name: "lifecycle revision changed",
      mutate: (harness: ReturnType<typeof createHarness>) => {
        harness.lifecycle.revision = "revision-2";
      },
      reason: "lifecycle-changed",
    },
    {
      name: "connection fingerprint changed",
      mutate: (harness: ReturnType<typeof createHarness>) => {
        harness.binding.current = {
          ...harness.binding.current!,
          appServerRuntimeFingerprint: "connection-B",
        };
      },
      reason: "connection-changed",
    },
  ])("drops with a logged reason when the $name", async ({ mutate, reason }) => {
    const harness = createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await spawnTwoAndDetach(harness);
      await harness.rotate();
      mutate(harness);
      await harness.complete("/root/slow", "slow result");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast"]);
      expect(harness.warnings("Dropping native completion")).toEqual([
        expect.objectContaining({ childThreadId: "child-slow", reason }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("drops a completion whose owner belongs to a different session", async () => {
    const harness = createHarness({ identitySessionId: "physical-2" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await spawnTwoAndDetach(harness);
      await harness.rotate();
      await harness.complete("/root/slow", "slow result");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast"]);
      expect(harness.warnings("Dropping native completion")).toEqual([
        expect.objectContaining({ childThreadId: "child-slow", reason: "session-changed" }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("holds through a pending supervision branch with bounded, logged retries, then drops", async () => {
    const harness = createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await spawnTwoAndDetach(harness);
      await harness.rotate();
      harness.binding.current = {
        ...harness.binding.current!,
        pendingSupervisionBranch: { sourceThreadId: "rotated-parent" },
      };
      await harness.complete("/root/slow", "slow result");
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast"]);
      const holds = harness.warnings("Holding native completion with unresolved history owner");
      expect(holds).toHaveLength(6);
      expect(holds[0]).toEqual(
        expect.objectContaining({ childThreadId: "child-slow", reason: "pending-supervision-branch" }),
      );
      expect(harness.warnings("Dropping native completion")).toEqual([
        expect.objectContaining({
          childThreadId: "child-slow",
          reason: "pending-supervision-branch",
          ownerHoldAttempts: 6,
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("delivers once a transiently unresolved owner resolves within the retry window", async () => {
    const harness = createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await spawnTwoAndDetach(harness);
      await harness.rotate();
      const settled = harness.binding.current!;
      harness.binding.current = { ...settled, pendingSupervisionBranch: { sourceThreadId: "x" } };
      await harness.complete("/root/slow", "slow result");
      expect(harness.delivered()).toEqual(["child-fast"]);
      harness.binding.current = settled;
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(harness.delivered()).toEqual(["child-fast", "child-slow"]);
      expect(harness.warnings("Dropping native completion")).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
