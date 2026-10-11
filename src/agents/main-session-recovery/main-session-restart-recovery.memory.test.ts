import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createMockGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resumeMainSession } from "./main-session-restart-dispatch.js";
import {
  announceRestartRecoveryResumption,
  captureRestartRecoveryDeliveryCurrent,
} from "./main-session-restart-recovery-delivery.js";
import {
  captureExpectedRestartRecoveryCurrent,
  loadExpectedRestartRecoveryTarget,
} from "./main-session-restart-recovery-exact-target.js";

vi.mock("node:sqlite", async (original) => ({
  ...(await original<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory recovery opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory recovery allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/recovery-memory" };
const location = {
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
const scope = {
  agentId: location.agentId,
  storePath: location.path,
  sessionKey: "agent:main:dashboard:incognito-recovery",
  env,
};
const entry: SessionEntry = {
  sessionId: "recovery-session",
  updatedAt: 1,
  incognito: true,
  abortedLastRun: true,
  restartRecoveryDeliveryRunId: "recovery-run",
  restartRecoveryDeliverySourceRunId: "source-run",
};

afterEach(() => memorySessionActorOwners.closeDatabase(location));

describe("memory restart recovery adapters", () => {
  it("reads the current recovery claim without creating an absent owner", async () => {
    const target = {
      storePath: scope.storePath,
      expected: {
        ...scope,
        sessionId: entry.sessionId,
        claim: { runId: "recovery-run", sourceRunId: "source-run" },
      },
    };
    expect(captureExpectedRestartRecoveryCurrent(target)()).toBe(false);
    expect(await loadExpectedRestartRecoveryTarget(target)).toBeUndefined();
    expect(memorySessionActorOwners.read(location)).toBeUndefined();
    await upsertSessionEntryCore(scope, entry);
    const current = captureExpectedRestartRecoveryCurrent(target);
    expect(current()).toBe(true);
    expect(await loadExpectedRestartRecoveryTarget(target)).toMatchObject(entry);
    await upsertSessionEntryCore(scope, { ...entry, restartRecoveryDeliveryRunId: "new-run" });
    expect(current()).toBe(false);
    expect(await loadExpectedRestartRecoveryTarget(target)).toBeUndefined();
    memorySessionActorOwners.closeSession(location, scope.sessionKey);
    expect(current()).toBe(false);
  });

  it("passes current send policy to the recovery notice transport after awaited writes", async () => {
    const deliveryContext = { channel: "discord", to: "channel:synthetic" };
    const ready = {
      ...entry,
      abortedLastRun: false,
      restartRecoveryDeliveryContext: deliveryContext,
    };
    await upsertSessionEntryCore(scope, ready);
    const params = {
      ...scope,
      cfg: {},
      sessionId: entry.sessionId,
      recoveryRunId: "recovery-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      deliveryContext,
    };
    const current = captureRestartRecoveryDeliveryCurrent(params);
    expect(current()).toBe(true);
    const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(
      async (input) => {
        await upsertSessionEntryCore(scope, { ...ready, sendPolicy: "deny" });
        expect(input.isCurrent?.({})).toBe(false);
        return { suppressed: true };
      },
    );
    await announceRestartRecoveryResumption({
      ...params,
      gatewayRuntime: createMockGatewayRecoveryRuntime({ sendRecoveryNotice }),
    });
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
    expect(current()).toBe(false);
    memorySessionActorOwners.closeSession(location, scope.sessionKey);
    expect(current()).toBe(false);
  });

  it("skips an absent session and a completion no longer owned by the live session", async () => {
    const gatewayRuntime = createMockGatewayRecoveryRuntime();
    const completion: NonNullable<SessionEntry["restartRecoveryHarnessCompletion"]> = {
      taskId: "child",
      taskRunId: "child-run",
      taskStatus: "succeeded",
      sourceRunId: "announce:child",
      requesterSessionKey: scope.sessionKey,
      requesterAgentId: scope.agentId,
      sessionId: entry.sessionId,
    };
    const params = {
      ...scope,
      entry: { ...entry, restartRecoveryHarnessCompletion: completion },
      observation: { sessionId: entry.sessionId, cycleId: "cycle", revision: 1 },
      recoveryAttempt: 1,
      gatewayRuntime,
    };
    expect(await resumeMainSession(params)).toBe("skipped");
    expect(memorySessionActorOwners.read(location)).toBeUndefined();
    await upsertSessionEntryCore(scope, params.entry);
    await upsertSessionEntryCore(scope, {
      ...entry,
      restartRecoveryHarnessCompletion: undefined,
    });
    expect(
      await resumeMainSession({
        ...params,
        recoveryAdmission: {
          handoffId: "synthetic-admission",
          shouldContinue: () => true,
          beginDispatch: () => true,
        },
      }),
    ).toBe("skipped");
    expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
  });
});
