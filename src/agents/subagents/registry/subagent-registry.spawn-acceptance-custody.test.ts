// H1 (absorb 14fe10d0): armed registration. An accepted native child is armed in its
// registration write; only its final acceptance owner disarms it. Every failure mode
// before that point (custody write refused, termination failing, restart, unknown
// commit outcome) must terminate or replay the child, never orphan it. These tests
// run the real spawn pipeline against the real registry and SQLite store; only the
// Gateway RPC, the announce delivery transport and registry write faults are seams.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
// Shared mocks must load before the registry modules below.
// oxfmt-ignore
import { sharedRegistryMocks } from "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { runSpawnPipeline } from "../../spawn-pipeline.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import type {
  RegisterSubagentRunParams,
  SubagentRegistrationIdentity,
} from "./subagent-registry-run-launch.js";
import { takeDeferredArmedSubagentResume } from "./subagent-registry-spawn-acceptance.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import * as registry from "./subagent-registry.js";
import {
  activateSubagentRegistry,
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  resumeSubagentRun,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  faultWrites,
  interceptRegistryWrites,
  liftFaults,
  type WriteRule,
} from "./subagent-registry.write-faults.test-support.js";

const announceMocks = vi.hoisted(() => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
  maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
}));
vi.mock("../announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce.js")>()),
  runSubagentAnnounceFlow: announceMocks.runSubagentAnnounceFlow,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));
vi.mock("../announce/subagent-announce.requester-settle-wake.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../announce/subagent-announce.requester-settle-wake.js")
  >()),
  maybeWakeRequesterAfterAllChildrenSettled:
    announceMocks.maybeWakeRequesterAfterAllChildrenSettled,
}));

const runId = "run-acceptance";
const childSessionKey = "agent:main:subagent:acceptance";
const gatewayRunId = runId;

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let stateDir: string | undefined;
const abortCalls: string[] = [];
const successfulAborts: string[] = [];
let abortSucceeds = true;
let childWait = createDeferred<Record<string, unknown>>();

const custodyWrite: WriteRule["match"] = (rows) =>
  rows.some((row) => row.runId === runId && row.acceptedSpawnRollback !== undefined);
const confirmWrite: WriteRule["match"] = (rows, write) =>
  !write.deleteRunIds.length &&
  rows.some(
    (row) =>
      row.runId === runId &&
      row.spawnAcceptance === undefined &&
      row.acceptedSpawnRollback === undefined &&
      row.execution.status === "running",
  );

beforeEach(async () => {
  // #169714: runtime config reads only the published snapshot.
  setRuntimeConfigSnapshot({});
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acceptance-custody-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  abortCalls.length = 0;
  successfulAborts.length = 0;
  abortSucceeds = true;
  childWait = createDeferred<Record<string, unknown>>();
  announceMocks.runSubagentAnnounceFlow.mockClear();
  announceMocks.maybeWakeRequesterAfterAllChildrenSettled.mockClear();
  interceptRegistryWrites();
  sharedRegistryMocks.callGateway.mockImplementation((async (request: {
    method?: string;
    params?: { runId?: string };
  }) => {
    if (request.method === "agent.wait") {
      return await childWait.promise;
    }
    if (request.method !== "chat.abort") {
      return { status: "ok" };
    }
    abortCalls.push(String(request.params?.runId));
    if (!abortSucceeds) {
      throw new Error("gateway unavailable");
    }
    successfulAborts.push(String(request.params?.runId));
    return { aborted: true, runIds: [request.params?.runId] };
  }) as unknown as typeof sharedRegistryMocks.callGateway);
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  liftFaults();
  // Unknown-outcome writes fence their runs in process memory; resolve them as a
  // new process would (one canonical restore) so no fence leaks into the next test.
  await restoreSubagentRunsFromDisk({ runs: new Map() }).catch(() => undefined);
  childWait.resolve({ status: "timeout" });
  closeOpenClawStateDatabaseForTest();
  await resetSubagentRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
  envSnapshot.restore();
});

type OwnedRegistration = RegisterSubagentRunParams & {
  expectedRegistration: SubagentRegistrationIdentity;
};

/** The native spawn's own pipeline wiring (subagent-spawn.ts), minus the Gateway. */
function spawnNative(options: {
  expectsCompletionMessage?: boolean;
  requesterTurnRunId?: string;
  deferred?: boolean;
  afterRegistration?: () => Promise<void>;
  terminate?: () => Promise<void>;
  assertActive?: () => void;
}) {
  const terminate = options.terminate ?? (async () => {});
  return runSpawnPipeline({
    adapter: {
      initialize: async () => ({}),
      dispatchTurn: async () => ({ runId }),
      cleanupOnFailure: async ({ phase }) => {
        if (phase === "register") {
          await terminate();
        }
      },
    },
    progressSessionKey: "agent:main:main",
    ...(options.assertActive ? { assertActive: options.assertActive } : {}),
    buildRegistration: (_state, acceptedRunId) =>
      ({
        runId: acceptedRunId,
        childSessionKey,
        childAgentId: "main",
        sessionEntry: { sessionId: "sess-acceptance", lifecycleRevision: "revision-acceptance" },
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "armed acceptance",
        cleanup: "keep",
        expectsCompletionMessage: options.expectsCompletionMessage ?? true,
        ...(options.requesterTurnRunId ? { requesterTurnRunId: options.requesterTurnRunId } : {}),
        acceptanceCustody: { gatewayRunId },
      }) as RegisterSubagentRunParams,
    ...(options.afterRegistration ? { afterRegistration: options.afterRegistration } : {}),
    recordAcceptedRollback: (registration: OwnedRegistration, error: unknown) =>
      registry.recordAcceptedSubagentSpawnRollback({
        runId: registration.runId,
        childSessionKey: registration.childSessionKey,
        gatewayRunId,
        reason: error instanceof Error ? error.message : String(error),
        expectedRegistration: registration.expectedRegistration,
      }),
    rollbackRegistration: (registration: OwnedRegistration) =>
      registry.rollbackSubagentRunRegistration({
        runId: registration.runId,
        childSessionKey: registration.childSessionKey,
        expectedRegistration: registration.expectedRegistration,
      }),
    confirmAcceptance: (registration: OwnedRegistration) =>
      registry.confirmSubagentSpawnAcceptance({
        runId: registration.runId,
        childSessionKey: registration.childSessionKey,
        expectedRegistration: registration.expectedRegistration,
      }),
    deferAcceptanceConfirmation: options.deferred === true,
    releaseAcceptanceHold: (registration: OwnedRegistration) =>
      registry.releaseSubagentSpawnAcceptanceHoldForRun(registration.runId),
  } as Parameters<typeof runSpawnPipeline>[0]);
}

const failingTermination = async () => {
  throw new Error("accepted child termination unconfirmed");
};
const durableRow = () => loadSubagentRegistryFromSqlite().get(runId);
const liveRow = () => subagentRuns.get(runId);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Gives asynchronous registry work (worker writes) time to land before a negative check. */
async function quiesce(): Promise<void> {
  await settle();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 400);
  });
  await settle();
}

/** The child run ends with a visible result (the lifecycle end event). */
function endChild(endedAt = Date.now()): void {
  const handler = (
    sharedRegistryMocks.onAgentEvent.mock.calls.at(-1) as unknown[] | undefined
  )?.[0] as ((event: Record<string, unknown>) => void) | undefined;
  expect(handler).toBeDefined();
  handler?.({
    runId,
    sessionKey: childSessionKey,
    stream: "lifecycle",
    seq: 1,
    ts: Date.now(),
    data: {
      phase: "end",
      endedAt,
      terminalReply: { disposition: "visible", text: "child result" },
    },
  });
}

/** Restarts from a durable image; returns the restored Gateway's agent dispatch. */
async function restartFrom(image: Map<string, SubagentRunRecord>) {
  closeOpenClawStateDatabaseForTest();
  await resetSubagentRegistryForTests({ persist: false });
  saveSubagentRegistryToSqlite(image);
  // A new process holds no in-memory write fences: resolve them the way upstream
  // does, by one canonical (non-merge) restore from the durable rows.
  await restoreSubagentRunsFromDisk({ runs: new Map() });
  await initSubagentRegistry();
  const dispatchAgent = vi.fn(async () => ({ runId: "relaunched", status: "accepted" }));
  const gatewayContext = {
    // Startup recovery has no pending admission to prepare in this fixture.
    recoveryRuntime: { dispatchAgent, prepareRestartRecovery: () => undefined },
    resolveGatewayContext: () => gatewayContext as never,
  };
  await activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  await settle();
  return dispatchAgent;
}

/** No announce or requester wake carries this armed child's own result. */
function expectNoDeliveryForArmedChild(): void {
  const calls = [
    ...announceMocks.runSubagentAnnounceFlow.mock.calls,
    ...announceMocks.maybeWakeRequesterAfterAllChildrenSettled.mock.calls,
  ] as unknown[][];
  expect(
    calls.filter(([request]) => {
      const params = request as { childRunId?: string; settledEntry?: { runId?: string } };
      return params.childRunId === runId || params.settledEntry?.runId === runId;
    }),
  ).toEqual([]);
}

/** A required completion reserves its requester's controller source before announcing. */
function seedRequesterSession(): void {
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: "agent:main:main" },
    { sessionId: "sess-requester", updatedAt: Date.now() },
  );
}

function expectNoDelivery(): void {
  expect(announceMocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  expect(announceMocks.maybeWakeRequesterAfterAllChildrenSettled).not.toHaveBeenCalled();
}

describe("armed registration: accepted-spawn custody (H1)", () => {
  it("T1: custody write and termination both fail in-process; the sweeper aborts the child", async () => {
    faultWrites("refuse", custodyWrite);
    const result = await spawnNative({
      afterRegistration: async () => {
        throw new Error("post-registration acceptance failed");
      },
      terminate: failingTermination,
    });
    expect(result.ok).toBe(false);

    liftFaults();
    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();
    expect(successfulAborts).toEqual([gatewayRunId]);
    expect(liveRow()).toBeUndefined();
    expect(durableRow()).toBeUndefined();
    expectNoDelivery();
  });

  it("T2: custody write and termination fail, then restart; the restored child is aborted, never resumed", async () => {
    faultWrites("refuse", custodyWrite);
    const result = await spawnNative({
      afterRegistration: async () => {
        throw new Error("post-registration acceptance failed");
      },
      terminate: failingTermination,
    });
    expect(result.ok).toBe(false);
    const crashImage = loadSubagentRegistryFromSqlite();
    expect(crashImage.get(runId)).toBeDefined();

    liftFaults();
    abortCalls.length = 0;
    successfulAborts.length = 0;
    const dispatchAgent = await restartFrom(crashImage);
    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();
    expect(successfulAborts).toEqual([gatewayRunId]);
    expect(liveRow()).toBeUndefined();
    expect(durableRow()).toBeUndefined();
    expect(dispatchAgent).not.toHaveBeenCalled();
    expectNoDelivery();
  });

  it("T3: a crash after registration and before confirmation fails closed on restart", async () => {
    const result = await spawnNative({ deferred: true });
    expect(result.ok).toBe(true);
    // The acceptance owner never reached its final acceptance point.
    const crashImage = loadSubagentRegistryFromSqlite();
    expect(crashImage.get(runId)?.spawnAcceptance).toMatchObject({ gatewayRunId });

    const dispatchAgent = await restartFrom(crashImage);
    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();
    expect(successfulAborts).toEqual([gatewayRunId]);
    expect(liveRow()).toBeUndefined();
    expect(durableRow()).toBeUndefined();
    expect(dispatchAgent).not.toHaveBeenCalled();
    expectNoDelivery();
  });

  // Upstream #200807 fails, from the sweeper, a running row an earlier Gateway process created;
  // the fork's activation settles an ownerless continuation delegate. Neither owns H1 custody.
  it.each([
    ["a native spawn without a completion notice", { expectsCompletionMessage: false }],
    ["a continuation delegate", { drainsContinuationDelegateQueue: true }],
  ] as const)(
    "T3d: %s an earlier process armed stays with its acceptance owner through restart",
    async (_name, row) => {
      const result = await spawnNative({
        deferred: true,
        expectsCompletionMessage: "expectsCompletionMessage" in row ? false : undefined,
      });
      expect(result.ok).toBe(true);
      const crashImage = loadSubagentRegistryFromSqlite();
      const armed = crashImage.get(runId)!;
      expect(armed.spawnAcceptance).toMatchObject({ gatewayRunId });
      // The earlier process created and ran it, under a lifecycle this one does not own.
      const earlier = Math.floor(performance.timeOrigin) - 10_000;
      crashImage.set(runId, {
        ...armed,
        ...row,
        createdAt: earlier,
        execution: { ...armed.execution, startedAt: earlier, lifecycleGeneration: "earlier" },
      });
      const registryWarn = vi.spyOn(subagentRegistryLog, "warn");

      const dispatchAgent = await restartFrom(crashImage);
      // Activation leaves the arm to its owner...
      expect(liveRow()).toMatchObject({
        spawnAcceptance: { gatewayRunId },
        execution: { status: "running" },
      });
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();

      // ...and the sweeper's acceptance owner stops and rolls it back before the restart
      // settle can fail it: no interruption, no notice.
      expect(successfulAborts).toEqual([gatewayRunId]);
      expect(liveRow()).toBeUndefined();
      expect(durableRow()).toBeUndefined();
      expect(registryWarn).not.toHaveBeenCalledWith(
        "Settling subagent interrupted by Gateway restart",
        expect.anything(),
      );
      expect(dispatchAgent).not.toHaveBeenCalled();
      expectNoDelivery();
    },
  );

  it("T4 (guard): a confirmed spawn is durable without an arm and resumes normally after restart", async () => {
    const result = await spawnNative({});
    expect(result.ok).toBe(true);
    expect(durableRow()?.spawnAcceptance).toBeUndefined();
    expect(durableRow()?.execution.status).toBe("running");

    await restartFrom(loadSubagentRegistryFromSqlite());
    await testing.sweepOnceForTests();
    expect(abortCalls).toEqual([]);
    expect(liveRow()?.runId).toBe(runId);
  });

  it("T5: a refused confirmation write rolls the accepted child back", async () => {
    faultWrites("refuse", confirmWrite, 1);
    const result = await spawnNative({});
    expect(result.ok).toBe(false);
    expect(liveRow()).toBeUndefined();
    expect(durableRow()).toBeUndefined();
  });

  it.each([false, true])(
    "T9: a child that ends while armed is not delivered before confirmation (confirm=%s)",
    async (confirm) => {
      seedRequesterSession();
      const entered = createDeferred();
      const decide = createDeferred();
      const spawning = spawnNative({
        afterRegistration: async () => {
          entered.resolve();
          await decide.promise;
          if (!confirm) {
            throw new Error("final acceptance failed");
          }
        },
      });
      await entered.promise;
      // The child finishes with a result while its acceptance is unconfirmed.
      endChild();
      await vi.waitFor(() => expect(liveRow()?.execution.endedAt).toBeTypeOf("number"));
      await quiesce();
      await testing.sweepOnceForTests();
      expectNoDelivery();

      decide.resolve();
      const result = await spawning;
      await quiesce();
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();
      await quiesce();
      if (confirm) {
        expect(result.ok).toBe(true);
        // The confirmation flush replays the gated delivery exactly once.
        await vi.waitFor(() =>
          expect(announceMocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1),
        );
        await quiesce();
        expect(announceMocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      } else {
        expect(result.ok).toBe(false);
        expectNoDelivery();
        expect(liveRow()).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "T9b: a held armed orphan is not orphan-completed before confirmation (confirm=%s)",
    async (confirm) => {
      const entered = createDeferred();
      const decide = createDeferred();
      const spawning = spawnNative({
        expectsCompletionMessage: false,
        afterRegistration: async () => {
          entered.resolve();
          await decide.promise;
          if (!confirm) {
            throw new Error("final acceptance failed");
          }
        },
      });
      await entered.promise;
      // The child session is missing (no session entry), and a resume path fires.
      resumeSubagentRun(runId);
      await quiesce();
      expect(liveRow()?.execution.status).toBe("running");
      expect(liveRow()?.execution.outcome).toBeUndefined();

      decide.resolve();
      const result = await spawning;
      await quiesce();
      if (confirm) {
        expect(result.ok).toBe(true);
        // Confirmation replays the deferred resume exactly once. Upstream #185730 settles no
        // orphan on resume, so the confirmed child stays with its live owner.
        expect(takeDeferredArmedSubagentResume(liveRow()!)).toBe(false);
        expect(liveRow()?.execution.status).toBe("running");
        expect(liveRow()?.execution.outcome).toBeUndefined();
      } else {
        expect(result.ok).toBe(false);
        expect(liveRow()).toBeUndefined();
        expectNoDelivery();
      }
    },
  );

  it.each([false, true])(
    "T9c: a held armed run past announce expiry is not given up before confirmation (confirm=%s)",
    async (confirm) => {
      const entered = createDeferred();
      const decide = createDeferred();
      const spawning = spawnNative({
        expectsCompletionMessage: false,
        afterRegistration: async () => {
          entered.resolve();
          await decide.promise;
          if (!confirm) {
            throw new Error("final acceptance failed");
          }
        },
      });
      await entered.promise;
      // Ended long ago (beyond ANNOUNCE_EXPIRY_MS) while still armed and held.
      endChild(1);
      await vi.waitFor(() => expect(liveRow()?.execution.endedAt).toBeTypeOf("number"));
      await quiesce();
      resumeSubagentRun(runId);
      await quiesce();
      expect(liveRow()?.cleanupCompletedAt).toBeUndefined();

      decide.resolve();
      const result = await spawning;
      await quiesce();
      await testing.sweepOnceForTests();
      await quiesce();
      if (confirm) {
        expect(result.ok).toBe(true);
        // The give-up runs after confirmation and retires the expired run.
        await vi.waitFor(() =>
          expect(
            liveRow()?.cleanupCompletedAt ?? (liveRow() ? undefined : "released"),
          ).toBeDefined(),
        );
      } else {
        expect(result.ok).toBe(false);
        expect(liveRow()).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "T9c (ancestor walk, F5): a settled grandchild does not give up its held armed ancestor (confirm=%s)",
    async (confirm) => {
      const entered = createDeferred();
      const decide = createDeferred();
      const spawning = spawnNative({
        expectsCompletionMessage: false,
        afterRegistration: async () => {
          entered.resolve();
          await decide.promise;
          if (!confirm) {
            throw new Error("final acceptance failed");
          }
        },
      });
      await entered.promise;
      // The armed child ended long ago (beyond ANNOUNCE_EXPIRY_MS) while held.
      endChild(1);
      await vi.waitFor(() => expect(liveRow()?.execution.endedAt).toBeTypeOf("number"));
      await quiesce();
      // Its own grandchild settles: the expiry give-up completes its cleanup
      // bookkeeping, which walks the ancestors (resumeAncestorCleanup) directly,
      // outside the F2 resume funnel.
      const grandchildRunId = "run-acceptance-grandchild";
      await addSubagentRunForTests({
        runId: grandchildRunId,
        childSessionKey: "agent:main:subagent:acceptance-grandchild",
        requesterSessionKey: childSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: "acceptance",
        task: "grandchild",
        cleanup: "keep",
        generation: 1,
        createdAt: 1,
        expectsCompletionMessage: false,
        execution: {
          status: "terminal",
          startedAt: 1,
          endedAt: 1,
          outcome: { status: "ok" },
        },
        completion: { required: false, resultText: null, capturedAt: 1 },
        delivery: { status: "not_required" },
      });
      resumeSubagentRun(grandchildRunId);
      await vi.waitFor(() =>
        expect(
          subagentRuns.get(grandchildRunId)?.cleanupCompletedAt ??
            (subagentRuns.get(grandchildRunId) ? undefined : "released"),
        ).toBeDefined(),
      );
      await quiesce();
      // F5: the walk reached the armed ancestor and left it alone.
      expect(liveRow()?.spawnAcceptance).toMatchObject({ gatewayRunId });
      expect(liveRow()?.cleanupCompletedAt).toBeUndefined();
      expect(liveRow()?.cleanupHandled).toBeFalsy();
      expectNoDeliveryForArmedChild();

      decide.resolve();
      const result = await spawning;
      await quiesce();
      if (confirm) {
        expect(result.ok).toBe(true);
        // Confirmation replays the ended child's give-up exactly once.
        await vi.waitFor(() =>
          expect(
            liveRow()?.cleanupCompletedAt ?? (liveRow() ? undefined : "released"),
          ).toBeDefined(),
        );
      } else {
        expect(result.ok).toBe(false);
        expect(liveRow()).toBeUndefined();
        expectNoDeliveryForArmedChild();
      }
    },
  );

  it.each([false, true])(
    "T9 (yield batch, G2): a yielded requester batch is not woken for a held armed child (confirm=%s)",
    async (confirm) => {
      const requesterTurnRunId = "requester-turn-acceptance";
      const entered = createDeferred();
      const decide = createDeferred();
      const spawning = spawnNative({
        requesterTurnRunId,
        afterRegistration: async () => {
          entered.resolve();
          await decide.promise;
          if (!confirm) {
            throw new Error("final acceptance failed");
          }
        },
      });
      await entered.promise;
      // The requester yields in the same turn, and the armed child completes.
      await expect(
        registry.markRequesterTurnYielded({
          requesterSessionKey: "agent:main:main",
          requesterTurnRunId,
        }),
      ).resolves.toBe(1);
      endChild();
      await vi.waitFor(() => expect(liveRow()?.execution.endedAt).toBeTypeOf("number"));
      await registry.settleRequesterAfterSessionSpawns({
        requesterSessionKey: "agent:main:main",
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId, childSessionKey, expectsCompletionMessage: true }],
      });
      await quiesce();
      // G2 (and G1): no requester wake and no announce while the spawn is unconfirmed.
      expectNoDelivery();

      decide.resolve();
      const result = await spawning;
      await quiesce();
      await testing.sweepOnceForTests();
      await quiesce();
      if (confirm) {
        expect(result.ok).toBe(true);
        // The confirmation flush delivers the yielded batch's child exactly once.
        await vi.waitFor(() =>
          expect(
            announceMocks.runSubagentAnnounceFlow.mock.calls.length +
              announceMocks.maybeWakeRequesterAfterAllChildrenSettled.mock.calls.length,
          ).toBeGreaterThan(0),
        );
        expect(announceMocks.runSubagentAnnounceFlow.mock.calls.length).toBeLessThanOrEqual(1);
      } else {
        expect(result.ok).toBe(false);
        expect(liveRow()).toBeUndefined();
        expectNoDelivery();
        // The rolled-back member leaves nothing for the requester batch to wait on.
        expect(
          await registry.listUnsettledRequesterChildren({ requesterSessionKey: "agent:main:main" }),
        ).toEqual([]);
      }
    },
  );

  it("T10: a restored armed row whose conversion and abort fail stays fenced", async () => {
    const result = await spawnNative({ deferred: true });
    expect(result.ok).toBe(true);
    const crashImage = loadSubagentRegistryFromSqlite();

    faultWrites("refuse", custodyWrite);
    abortSucceeds = false;
    const dispatchAgent = await restartFrom(crashImage);
    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();
    await settle();
    expect(successfulAborts).toEqual([]);
    expect(liveRow()?.spawnAcceptance).toMatchObject({ gatewayRunId });
    expect(liveRow()?.execution.outcome).toBeUndefined();
    expect(durableRow()?.spawnAcceptance).toMatchObject({ gatewayRunId });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expectNoDelivery();

    liftFaults();
    abortSucceeds = true;
    await testing.sweepOnceForTests();
    expect(successfulAborts).toEqual([gatewayRunId]);
    expect(liveRow()).toBeUndefined();
    expect(durableRow()).toBeUndefined();
  });

  it.each(["landed", "not-landed"] as const)(
    "T13: an unknown-outcome confirmation converges forward; restart decides by the durable row (%s)",
    async (twin) => {
      // The confirm write's receipt is lost. "not-landed" restarts from the durable
      // image taken just before that write committed.
      let preWrite: Map<string, SubagentRunRecord> | undefined;
      faultWrites(
        "lose-receipt",
        (rows, write) => {
          if (!confirmWrite(rows, write)) {
            return false;
          }
          preWrite = loadSubagentRegistryFromSqlite();
          return true;
        },
        1,
      );
      const result = await spawnNative({});
      expect(result.ok).toBe(true);
      expect(result.ok && result.acceptance).toBe("uncertain");
      // In-process: the rollback handle is a no-op, the child is never aborted,
      // and delivery stays gated on the still-armed live row.
      if (result.ok) {
        await result.rollbackAccepted();
      }
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();
      expect(abortCalls).toEqual([]);
      expect(liveRow()?.runId).toBe(runId);
      expectNoDelivery();

      if (twin === "landed") {
        expect(durableRow()?.spawnAcceptance).toBeUndefined();
        // Open on disk: an ordinary accepted run; no abort, row kept.
        await restartFrom(loadSubagentRegistryFromSqlite());
        await testing.sweepOnceForTests();
        expect(abortCalls).toEqual([]);
        expect(liveRow()?.runId).toBe(runId);
        expect(liveRow()?.spawnAcceptance).toBeUndefined();
      } else {
        expect(preWrite?.get(runId)?.spawnAcceptance).toMatchObject({ gatewayRunId });
        // Still armed on disk: restart fails it closed.
        const dispatchAgent = await restartFrom(preWrite!);
        await testing.sweepOnceForTests();
        expect(successfulAborts).toEqual([gatewayRunId]);
        expect(liveRow()).toBeUndefined();
        expect(durableRow()).toBeUndefined();
        expect(dispatchAgent).not.toHaveBeenCalled();
        expectNoDelivery();
      }
    },
  );

  it.each(["landed", "not-landed"] as const)(
    "T15: an unknown-outcome rollback conversion never throws out of the sweep (%s)",
    async (twin) => {
      const result = await spawnNative({ deferred: true, terminate: failingTermination });
      expect(result.ok).toBe(true);
      let image: Map<string, SubagentRunRecord> | undefined;
      faultWrites(
        "lose-receipt",
        (rows, write) => {
          if (!custodyWrite(rows, write)) {
            return false;
          }
          image = loadSubagentRegistryFromSqlite();
          return true;
        },
        1,
      );
      abortSucceeds = false;
      if (result.ok) {
        await result.rollbackAccepted().catch(() => {});
      }
      await expect(testing.sweepOnceForTests()).resolves.toBeUndefined();
      await expect(testing.sweepOnceForTests()).resolves.toBeUndefined();
      expectNoDelivery();

      abortSucceeds = true;
      await expect(testing.sweepOnceForTests()).resolves.toBeUndefined();
      expect(successfulAborts.length).toBeGreaterThanOrEqual(1);
      expect(new Set(successfulAborts)).toEqual(new Set([gatewayRunId]));
      expectNoDelivery();

      // Restart from the image captured at the conversion: fenced, aborted, row gone.
      const crash = twin === "landed" ? loadSubagentRegistryFromSqlite() : image!;
      successfulAborts.length = 0;
      await restartFrom(crash);
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();
      expect(successfulAborts).toEqual([gatewayRunId]);
      expect(liveRow()).toBeUndefined();
      expect(durableRow()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "T16: retired authority with pending delivery cannot starve adoption of an unheld arm (restart=%s)",
    async (restart) => {
      // Registration commits the armed row, then its post-publication ownership check
      // fails: authority is retired, the error is rethrown raw, and the pipeline
      // cleans up without ownership while termination fails.
      let published = false;
      const blockWrite = faultWrites("refuse", (rows) =>
        rows.some((row) => row.runId === runId && row.delivery?.status === "suspended"),
      );
      await expect(
        spawnNative({
          assertActive: () => {
            if (subagentRuns.get(runId)) {
              published = true;
              throw new Error("registration lost its post-publication owner");
            }
          },
          terminate: failingTermination,
        }),
      ).rejects.toThrow("accepted child termination unconfirmed");
      expect(published).toBe(true);
      expect(liveRow()?.delivery?.status).toBe("pending");
      if (restart) {
        const image = loadSubagentRegistryFromSqlite();
        await restartFrom(image);
      }
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();
      await testing.sweepOnceForTests();
      expect(successfulAborts).toEqual([gatewayRunId]);
      expect(liveRow()).toBeUndefined();
      expect(durableRow()).toBeUndefined();
      // The adoption branch decided the row before the retired-authority branch.
      expect(blockWrite.hits).toBe(0);
      expectNoDelivery();
    },
  );
});
