// Subagent registry archive tests cover keep/delete cleanup modes, retryable
// session deletion, and context-engine lifecycle callbacks.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import * as internalSessionEffects from "../../internal-session-effects.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn<
    typeof import("../../../config/sessions/session-accessor.js").loadSessionEntryReadOnly
  >(() => undefined),
}));

const noop = () => {};
let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.mocked(getRuntimeConfig);

const respondToGatewayRequest = vi.hoisted(() => async (request: unknown) => {
  const method = (request as { method?: string }).method;
  if (method === "agent.wait") {
    // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
    return { status: "pending" };
  }
  return {};
});

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(respondToGatewayRequest),
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntryReadOnly: sessionAccessorMocks.loadSessionEntryReadOnly,
  };
});

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: vi.fn((_handler: unknown) => noop),
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
  hasLiveAgentRunContext: vi.fn(() => false),
}));

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../context-engine/init.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn<
    typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd
  >(async () => {}),
}));

vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn<
    typeof import("../announce/subagent-announce.js").captureSubagentCompletionReply
  >(async () => undefined),
  runSubagentAnnounceFlow: vi.fn<
    typeof import("../announce/subagent-announce.js").runSubagentAnnounceFlow
  >(async () => "delivered"),
}));

vi.mock("../announce/subagent-announce.requester-settle-wake.js", () => ({
  maybeWakeRequesterAfterAllChildrenSettled: vi.fn<
    typeof import("../announce/subagent-announce.requester-settle-wake.js").maybeWakeRequesterAfterAllChildrenSettled
  >(async (params) => {
    await params.completeBatch([params.settledEntry]);
    return false;
  }),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

describe("subagent registry archive behavior", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let settleRootWork: ReturnType<typeof observeRootWork>;
  let mod: typeof import("./subagent-registry.test-helpers.js");
  let createCanonicalSubagentRunFixture: typeof import("./subagent-registry.persistence.test-support.js").createCanonicalSubagentRunFixture;
  let createSubagentRunRecord: typeof import("../../subagent-test-fixtures.test-helpers.js").createSubagentRunRecord;

  beforeAll(async () => {
    ({ createCanonicalSubagentRunFixture } =
      await import("./subagent-registry.persistence.test-support.js"));
    ({ createSubagentRunRecord } = await import("../../subagent-test-fixtures.test-helpers.js"));
    mod = await import("./subagent-registry.test-helpers.js");
  });

  const addCanonicalSubagentRunForTests = (
    entry: Parameters<typeof mod.addSubagentRunForTests>[0],
  ) =>
    mod.addSubagentRunForTests(createCanonicalSubagentRunFixture(createSubagentRunRecord(entry)));

  const sweepAndSettleCleanup = async () => {
    try {
      await mod.testing.sweepOnceForTests();
    } finally {
      // Sweeping admits detached cleanup and requester-settlement work. Join
      // those real promises; a fixed number of microtasks cannot prove retirement.
      await settleRootWork(true);
    }
  };

  const waitForNoRequesterRuns = async () => {
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
    };
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockImplementation(respondToGatewayRequest);
    loadConfigMock.mockReset().mockImplementation(() => currentConfig);
    vi.mocked(ensureContextEnginesInitialized).mockReset();
    vi.mocked(resolveContextEngine).mockReset();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(captureSubagentCompletionReply).mockReset();
    vi.mocked(runSubagentAnnounceFlow).mockReset();
    vi.mocked(getAgentRunContext).mockReset().mockReturnValue(undefined);
    sessionAccessorMocks.loadSessionEntryReadOnly.mockReset();
    await mod.resetSubagentRegistryForTests({ persist: false });
    settleRootWork = observeRootWork();
  });

  afterEach(async () => {
    try {
      await settleRootWork();
    } finally {
      await mod.resetSubagentRegistryForTests({ persist: false });
      vi.useRealTimers();
    }
  });

  it("starts delete-mode retention when its terminal lifecycle event completes", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    vi.mocked(getAgentRunContext).mockReturnValue({} as never);
    vi.mocked(captureSubagentCompletionReply).mockResolvedValue("completed result");
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("retryable");

    await mod.registerSubagentRun({
      runId: "run-delete-completed",
      childSessionKey: "agent:main:subagent:delete-completed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish after a long run",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });
    await vi.advanceTimersByTimeAsync(90_000);

    const endedAt = Date.now();
    const lifecycleHandler = vi.mocked(onAgentEvent).mock.calls.at(-1)?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");
    const terminalPublished = createDeferred();
    const stop = subscribeSubagentRunChanges("projection", () => {
      const run = subagentRuns.get("run-delete-completed");
      if (run?.execution.status === "terminal" && run.execution.endedAt === endedAt) {
        terminalPublished.resolve();
      }
    });
    try {
      lifecycleHandler?.({
        runId: "run-delete-completed",
        stream: "lifecycle",
        seq: 1,
        ts: endedAt,
        data: { phase: "end", endedAt, terminalReply: { disposition: "visible", text: "done" } },
      });
      await terminalPublished.promise;
    } finally {
      stop();
    }

    await settleRootWork(true);
    expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
      execution: { status: "terminal", endedAt },
      archiveAtMs: endedAt + 60_000,
    });
  });

  it("does not reap a queued collector waiting for a swarm slot past the stale grace", async () => {
    // Queued collectors have no gateway run context until FIFO dispatch; the
    // stale-context reap must not fabricate a lost-context failure for them.
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-queued-collector",
      childSessionKey: "agent:main:subagent:queued-collector",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait for a swarm slot",
      cleanup: "keep",
      collect: true,
      createdAt: now - 120_000,
      execution: { status: "queued" },
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
      runId: "run-queued-collector",
      execution: { status: "queued" },
    });
    expect(
      mod.listSubagentRunsForRequester("agent:main:main")[0]?.collectorCompletion,
    ).toBeUndefined();
  });

  it("does not archive an active run carrying an obsolete persisted deadline", async () => {
    vi.mocked(getAgentRunContext).mockReturnValue({} as never);
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-delete-stale-deadline",
      childSessionKey: "agent:main:subagent:delete-stale-deadline",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "continue running after retention migration",
      cleanup: "delete",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      archiveAtMs: now - 60_000,
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
      runId: "run-delete-stale-deadline",
      execution: { status: "running" },
    });
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string }).method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it.each(["pending"] as const)(
    "does not archive a completed delete-mode run while delivery is %s",
    async (deliveryStatus) => {
      const now = Date.now();
      await addCanonicalSubagentRunForTests({
        runId: `run-delete-delivery-${deliveryStatus}`,
        childSessionKey: `agent:main:subagent:delete-delivery-${deliveryStatus}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "deliver completion before archival",
        cleanup: "delete",
        expectsCompletionMessage: true,
        createdAt: now - 120_000,
        endedAt: now - 60_000,
        archiveAtMs: now - 1,
        delivery: { status: deliveryStatus },
      });

      await mod.testing.sweepOnceForTests();

      const entry = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(entry?.delivery?.status).toBe(deliveryStatus);
      expect(
        vi
          .mocked(callGateway)
          .mock.calls.some(
            ([request]) => (request as { method?: string }).method === "sessions.delete",
          ),
      ).toBe(false);

      await mutateSubagentRuns([entry!.runId], (rows) => {
        const current = rows.get(entry!.runId)!;
        return {
          value: undefined,
          postimages: new Map([
            [
              current.runId,
              {
                ...current,
                delivery: { ...current.delivery, status: "delivered" as const },
              },
            ],
          ]),
        };
      });
      await mod.testing.sweepOnceForTests();

      await waitForNoRequesterRuns();
    },
  );

  it("keeps archived delete-mode runs for retry when sessions.delete fails", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    const onSubagentEnded = vi.fn(async () => undefined);
    const attachmentsRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sweep-retry-"));
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
    sessionAccessorMocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "session-delete-retry",
      lifecycleRevision: "lifecycle-delete-retry",
      updatedAt: Date.now(),
    });
    let deleteAttempts = 0;
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete failed");
        }
      }
      return {};
    });
    vi.mocked(ensureContextEnginesInitialized).mockResolvedValue(undefined);
    vi.mocked(resolveContextEngine).mockResolvedValue({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: false, compacted: false }),
      onSubagentEnded,
    });

    await addCanonicalSubagentRunForTests({
      runId: "run-delete-retry",
      childSessionKey: "agent:main:subagent:delete-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
      attachmentsDir,
      attachmentsRootDir,
    });

    await mod.testing.sweepOnceForTests();
    await vi.dynamicImportSettled();

    expect(deleteAttempts).toBe(1);
    expect(vi.mocked(callGateway)).toHaveBeenCalledWith({
      assertDispatchCurrent: expect.any(Function),
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:delete-retry",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "session-delete-retry",
        expectedLifecycleRevision: "lifecycle-delete-retry",
      },
      timeoutMs: 10_000,
    });
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    expect(onSubagentEnded).not.toHaveBeenCalled();
    await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();

    await mod.testing.sweepOnceForTests();
    await vi.dynamicImportSettled();

    expect(deleteAttempts).toBe(2);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("stabilizes provisional killed tasks before deleting expired tombstones", async () => {
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-tombstone-expired",
      childSessionKey: "agent:main:subagent:killed-tombstone-expired",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      startedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    expect(
      vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
  });

  it("retains cancellation evidence when the retirement write is rejected", async () => {
    const now = Date.now();
    const runId = "run-killed-tombstone-retry";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:killed-tombstone-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });
    await mutateSubagentRuns([runId], (rows) => {
      const entry = rows.get(runId)!;
      return {
        value: undefined,
        postimages: new Map([
          [
            runId,
            {
              ...entry,
              execution: { ...entry.execution, suppressSessionEffects: true },
            },
          ],
        ]),
      };
    });
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    let rejectedWrites = 0;
    let refusedPreimage: SubagentRunRecord | undefined;
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                if (
                  command.type === "subagents.persistChanges" &&
                  (command.input as SubagentRegistryWrite).deleteRunIds.includes(runId)
                ) {
                  rejectedWrites += 1;
                  refusedPreimage = subagentRuns.get(runId);
                  throw new Error("retirement write rejected");
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    try {
      await sweepAndSettleCleanup();
      expect(rejectedWrites).toBe(1);
      expect(refusedPreimage).toBeDefined();
      expect(refusedPreimage?.cleanupHandled).toBe(true);
      expect(subagentRuns.get(runId)).toEqual({ ...refusedPreimage, cleanupHandled: false });
      expect(subagentRuns.get(runId)).toMatchObject({
        endedReason: "subagent-killed",
        execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        endedReason: "subagent-killed",
        execution: { status: "terminal", outcome: { status: "error", error: "manual kill" } },
      });
      expect(
        vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
    } finally {
      writer.mockRestore();
    }
  });

  it("preserves stable operator cancellation when retiring expired tombstones", async () => {
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-operator-cancelled",
      childSessionKey: "agent:main:subagent:killed-operator-cancelled",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve operator cancellation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps stable cancellation tombstones through the completion grace window", async () => {
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-grace",
      childSessionKey: "agent:main:subagent:killed-grace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retain cancellation evidence",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      endedAt: now - 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 60_000, taskCancellationAccepted: true },
      cleanupHandled: true,
      cleanupCompletedAt: now - 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
  });

  it("directly kills a replacement run through its durable task ID", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:replacement-direct-kill";
    await addCanonicalSubagentRunForTests({
      runId: "run-after-replacement-direct-kill",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill replacement task",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 11 * 60_000,
    });

    expect(
      await mod.markSubagentRunTerminated({
        runId: "run-after-replacement-direct-kill",
        reason: "manual kill",
      }),
    ).toBe(1);
  });

  it("does not reconcile an older tombstone through a newer session task", async () => {
    const now = Date.now();
    await addCanonicalSubagentRunForTests({
      runId: "run-old-generation",
      childSessionKey: "agent:main:subagent:reused-session",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire old generation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: {
        killedAt: now - 5 * 60_000,
        supersededAt: now - 60_000,
      },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await sweepAndSettleCleanup();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("retains newly rearmed requester custody while superseded cleanup is awaiting", async () => {
    vi.mocked(getAgentRunContext).mockReturnValue({} as never);
    const now = Date.now();
    const runId = "superseded-new-wake";
    const successorRunId = "superseded-new-wake-successor";
    const childSessionKey = "agent:main:subagent:superseded-new-wake";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retain rearmed wake",
      cleanup: "keep",
      generation: 1,
      createdAt: now - 10 * 60_000,
      execution: {
        status: "terminal",
        endedAt: now - 5 * 60_000,
        outcome: { status: "error", error: "killed" },
        transcriptTarget: {
          agentId: "main",
          sessionId: "old-effects",
          sessionKey: "agent:main:internal-session-effects:old-wake",
          storePath: "/synthetic-old-effects",
        },
      },
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
    });
    await addCanonicalSubagentRunForTests({
      runId: successorRunId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "successor",
      cleanup: "keep",
      generation: 2,
      createdAt: now - 60_000,
    });
    const entered = createDeferred();
    const released = createDeferred();
    const cleanup = vi
      .spyOn(internalSessionEffects, "removeInternalSessionEffectsSession")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
      });
    const pending = mod.testing.sweepOnceForTests();
    try {
      await entered.promise;
      await mutateSubagentRuns([runId, successorRunId], (rows) => {
        const current = rows.get(runId)!;
        return {
          value: undefined,
          postimages: new Map<string, SubagentRunRecord | null>([
            [successorRunId, null],
            [
              runId,
              {
                ...current,
                requesterSettleWake: {
                  status: "pending",
                  attemptCount: 0,
                  rearmGeneration: 2,
                  batchRunIds: [runId],
                  requesterYieldBatch: true,
                },
              },
            ],
          ]),
        };
      });
    } finally {
      released.resolve();
      await pending;
      cleanup.mockRestore();
    }
    expect(subagentRuns.get(runId)?.requesterSettleWake?.rearmGeneration).toBe(2);
    expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterSettleWake?.rearmGeneration).toBe(
      2,
    );
    expect(subagentRuns.has(successorRunId)).toBe(false);
  });

  it("stabilizes killed tasks before their configured session archive deadline", async () => {
    const now = Date.now();
    const archiveAtMs = now + 55 * 60_000;
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-retained-session",
      childSessionKey: "agent:main:subagent:killed-retained-session",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stabilize before archive",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs,
    });

    await mod.testing.sweepOnceForTests();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-killed-retained-session",
        archiveAtMs,
        suppressAnnounceReason: undefined,
      }),
    ]);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it("continues killed cleanup when ended hook loading fails", async () => {
    const now = Date.now();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockImplementation(() => {
      throw new Error("plugin load failed");
    });
    await addCanonicalSubagentRunForTests({
      runId: "run-killed-hook-load-failure",
      childSessionKey: "agent:main:subagent:killed-hook-load-failure",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cleanup despite hook failure",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await expect(mod.testing.sweepOnceForTests()).resolves.toBeUndefined();
    await vi.dynamicImportSettled();

    await waitForNoRequesterRuns();
  });

  it("does not overlap archive sweep retries while sessions.delete is still in flight", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    const deleteGate = createDeferred();
    const deleteEntered = createDeferred();
    sessionAccessorMocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "session-delete-inflight",
      lifecycleRevision: "lifecycle-delete-inflight",
      updatedAt: Date.now(),
    });
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        deleteEntered.resolve();
        await deleteGate.promise;
      }
      return {};
    });

    await addCanonicalSubagentRunForTests({
      runId: "run-delete-inflight",
      childSessionKey: "agent:main:subagent:delete-inflight",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "inflight delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
    });

    const firstSweep = mod.testing.sweepOnceForTests();
    try {
      await deleteEntered.promise;
      expect(
        vi
          .mocked(callGateway)
          .mock.calls.filter(
            ([request]) =>
              (request as { method?: string } | undefined)?.method === "sessions.delete",
          ),
      ).toHaveLength(1);
      expect(vi.mocked(callGateway)).toHaveBeenCalledWith({
        assertDispatchCurrent: expect.any(Function),
        method: "sessions.delete",
        params: {
          key: "agent:main:subagent:delete-inflight",
          deleteTranscript: true,
          emitLifecycleHooks: false,
          expectedSessionId: "session-delete-inflight",
          expectedLifecycleRevision: "lifecycle-delete-inflight",
        },
        timeoutMs: 10_000,
      });

      await mod.testing.sweepOnceForTests();
      expect(
        vi
          .mocked(callGateway)
          .mock.calls.filter(
            ([request]) =>
              (request as { method?: string } | undefined)?.method === "sessions.delete",
          ),
      ).toHaveLength(1);
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    } finally {
      deleteGate.resolve();
      await firstSweep;
    }
    await vi.dynamicImportSettled();
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  });

  it("does not set archiveAtMs for persistent session-mode runs", async () => {
    await mod.registerSubagentRun({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-session-1");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps archiveAtMs unset when replacing a keep-mode run after steer restart", async () => {
    await mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:run-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const replaced = await mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps retention unarmed when replacing an active delete-mode run after steer restart", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    await mod.registerSubagentRun({
      runId: "run-delete-old",
      childSessionKey: "agent:main:subagent:delete-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const replaced = await mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-delete-old",
      nextRunId: "run-delete-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-delete-new");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("does not traverse legacy attachment paths after steer restart", async () => {
    const attachmentsRootDir = tempDirs.make("openclaw-replace-attachments-");
    const attachmentsDir = path.join(attachmentsRootDir, "old");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");

    const runId = "run-delete-attachments-old";
    await addCanonicalSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:delete-attachments-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replace attachments",
      cleanup: "delete",
      createdAt: Date.now(),
      execution: { status: "running" },
      attachmentsRootDir,
      attachmentsDir,
    });
    const restored = expectDefined(loadSubagentRegistryFromSqlite().get(runId), "legacy run");
    expect(restored).toMatchObject({ attachmentsRootDir, attachmentsDir });
    expect(restored.attachmentId).toBeUndefined();
    subagentRuns.set(runId, restored);

    const replaced = await mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-delete-attachments-old",
      nextRunId: "run-delete-attachments-new",
    });

    expect(replaced).toBe(true);
    await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
  });
});
