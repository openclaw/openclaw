import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { persistAbortTargetEntry } from "../../auto-reply/reply/commands-session-store.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import * as recoveryStore from "./main-session-recovery-store.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
} from "./main-session-recovery-store.js";
import { createRestartRecoveryStoreFixture } from "./main-session-restart-recovery-fixture.test-support.js";
import { retryRestartAbortedMainSessionRecovery as retryRestartAbortedMainSessionRecoveryBase } from "./main-session-restart-recovery.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let tmpDir: string;
const callGateway = vi.fn<(params: Parameters<typeof gatewayCall>[0]) => Promise<unknown>>();
const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => createDeferred().promise,
  sendRecoveryNotice,
});
const retryRestartAbortedMainSessionRecovery = (
  params: Omit<Parameters<typeof retryRestartAbortedMainSessionRecoveryBase>[0], "gatewayRuntime">,
) => retryRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const { makeMainSessionFixture, writeTranscript } = createRestartRecoveryStoreFixture(() => tmpDir);

beforeEach(async () => {
  vi.clearAllMocks();
  callGateway.mockReset();
  callGateway.mockImplementation(async () => ({ runId: "run-resumed" }));
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ scenario: "minimal" });
  tmpDir = state.root;
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

// openclaw#1468: a live stop or supersede must not look like restart-interrupted work.
describe("probe1468", () => {
  const messageToolOnlyClaim = {
    restartRecoveryDeliveryRunId: "room-run",
    restartRecoverySourceIngress: "channel",
    restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    restartRecoveryDeliveryContext: {
      channel: "discord",
      to: "discord:channel:room",
      accountId: "work",
    },
  } as const;

  function rowFacts(entry: SessionEntry | undefined) {
    return {
      status: entry?.status,
      abortedLastRun: entry?.abortedLastRun,
      lifecycleRunId: entry?.lifecycleRunId,
      restartRecoveryRuns: entry?.restartRecoveryRuns?.map((run) => run.runId),
      restartRecoveryDeliveryRunId: entry?.restartRecoveryDeliveryRunId,
      mainRestartRecovery: entry?.mainRestartRecovery
        ? {
            keys: Object.keys(entry.mainRestartRecovery).toSorted(),
            chargedAttempts: entry.mainRestartRecovery.chargedAttempts,
            foregroundClaims: Boolean(entry.mainRestartRecovery.foregroundClaims),
            tombstone:
              entry.mainRestartRecovery.tombstone?.reason ??
              Boolean(entry.mainRestartRecovery.tombstone),
          }
        : undefined,
    };
  }

  async function liveRoomRow(overrides: SessionEntryFixture = {}) {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const fixture = await makeMainSessionFixture({
      status: undefined,
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      lifecycleRunId: "room-run",
      restartRecoveryRuns: [{ runId: "room-run", lifecycleGeneration }],
      ...messageToolOnlyClaim,
      ...overrides,
    });
    await writeTranscript(fixture.sessionsDir, "main-session", [
      { role: "user", content: "a room turn" },
    ]);
    return { ...fixture, lifecycleGeneration };
  }

  async function persistRun(
    sessionKey: string,
    lifecycleGeneration: string,
    runId: string,
    data: Record<string, unknown>,
  ) {
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      agentId: "main",
      event: { ts: Date.now(), sessionId: "main-session", runId, lifecycleGeneration, data },
    });
  }

  async function successorTurn(
    row: Awaited<ReturnType<typeof liveRoomRow>>,
    options: { completeBeforeRelease?: boolean } = {},
  ) {
    const { sessionKey, storePath, lifecycleGeneration, readEntry } = row;
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "main-session",
      runId: "successor-run",
      target: { agentId: "main", sessionKey, storePath },
    });
    const afterClaim = rowFacts(readEntry());
    if (options.completeBeforeRelease) {
      await persistRun(sessionKey, lifecycleGeneration, "successor-run", { phase: "start" });
      await persistRun(sessionKey, lifecycleGeneration, "successor-run", {
        phase: "end",
        stopReason: "end_turn",
      });
    }
    const pending =
      claim.kind === "claimed"
        ? await recoveryStore.releaseMainSessionRecoveryOwner(claim.lease)
        : undefined;
    const afterRelease = rowFacts(readEntry());
    const retry = await retryRestartAbortedMainSessionRecovery({
      agentId: "main",
      expectedSessionId: "main-session",
      sessionKey,
      storePath,
      stateDir: tmpDir,
    });
    const final = rowFacts(readEntry());
    return {
      claimKind: claim.kind,
      afterClaim,
      releasePendingTarget: Boolean(pending),
      afterRelease,
      retry,
      recoveryNotices: sendRecoveryNotice.mock.calls.length,
      final,
    };
  }

  function expectSafe(result: Awaited<ReturnType<typeof successorTurn>>) {
    expect(result.final.mainRestartRecovery?.tombstone ?? false).toBe(false);
    expect(result.releasePendingTarget).toBe(false);
    expect(result.recoveryNotices).toBe(0);
  }

  it("P0 superseded end event (#1463 fossil shape) leaves the live session safe", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "superseded",
        aborted: true,
      });
      const result = await successorTurn(row);
      expectSafe(result);
    });
  });

  it("P1 /stop end event persisted before the next turn leaves the live session safe", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      });
      const result = await successorTurn(row);
      expectSafe(result);
    });
  });

  it("P2 /stop marker (persistAbortTargetEntry) before the aborted end event leaves the session safe", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      // commands-session-store.ts persistAbortTargetEntry writes abortedLastRun=true
      // while the run's fence and delivery claim are still live.
      const row = await liveRoomRow({ abortedLastRun: true });
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      });
      const result = await successorTurn(row);
      expectSafe(result);
    });
  });

  it("P3 /stop end event, successor terminal persisted before owner release", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      });
      const result = await successorTurn(row, { completeBeforeRelease: true });
      expectSafe(result);
    });
  });

  it("P4 /stop end event after the delivery claim already settled", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow({ restartRecoveryDeliveryRunId: undefined });
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      });
      const result = await successorTurn(row);
      expect(result.claimKind).toBe("not_required");
      expectSafe(result);
    });
  });

  it("P5 completed end_turn with retained delivery claim stays safe", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "end_turn",
      });
      const result = await successorTurn(row);
      expectSafe(result);
    });
  });

  it("C1 genuine restart end event (stopReason restart) still opens recovery", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      await persistRun(row.sessionKey, row.lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "restart",
        aborted: true,
      });
      const afterEnd = rowFacts(row.readEntry());
      const result = await successorTurn(row);
      expect(afterEnd.status).toBe("interrupted");
      expect(result.claimKind).toBe("claimed");
      expect(result.releasePendingTarget).toBe(true);
    });
  });

  it("C2 genuine restart over a preserved terminal outcome keeps its status and still recovers", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow({
        status: "done",
        endedAt: Date.now() - 1_000,
        lifecycleRunId: undefined,
        restartRecoveryRuns: undefined,
      });
      await commitMainSessionRecovery({
        command: { kind: "mark_interrupted", cycleId: "restart-cycle", now: Date.now() },
        requireWriteSuccess: true,
        target: { agentId: "main", sessionKey: row.sessionKey, storePath: row.storePath },
      });
      const afterMark = rowFacts(row.readEntry());
      const result = await successorTurn(row);
      expect(afterMark.status).toBe("done");
      expect(afterMark.abortedLastRun).toBe(true);
      expect(result.claimKind).toBe("claimed");
      expect(result.releasePendingTarget).toBe(true);
    });
  });

  it("stop flag, terminal and delivery-claim cleanup leave the next message unrecovered", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const row = await liveRoomRow();
      const { sessionKey, storePath, lifecycleGeneration, readEntry } = row;
      const stopped = expectDefined(readEntry(), "live room row");
      await expect(
        persistAbortTargetEntry({
          entry: stopped,
          key: sessionKey,
          sessionStore: { [sessionKey]: stopped },
          storePath,
        }),
      ).resolves.toBe(true);
      await persistRun(sessionKey, lifecycleGeneration, "room-run", {
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      });
      // The agent-command cleanup owner settles the stopped run's delivery claim.
      await sessionAccessor.patchSessionEntryCore({ sessionKey, storePath }, (current) => ({
        ...current,
        ...buildMainSessionRecoverySettlementPatch({
          entry: current,
          recordTerminalSource: true,
          clearRecoveryState: current.abortedLastRun !== true,
          terminalRunId: "room-run",
        }),
      }));
      const afterCleanup = rowFacts(readEntry());
      const result = await successorTurn(row);
      // A flag written before the terminal reads as a restart marker; only its fence retires.
      expect(afterCleanup).toEqual({ abortedLastRun: true, lifecycleRunId: "room-run" });
      expect(result.claimKind).toBe("not_required");
      expectSafe(result);
      expect(result.retry).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
    });
  });
});
