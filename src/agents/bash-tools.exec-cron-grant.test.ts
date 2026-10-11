import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareReplyTurnExecution } from "../auto-reply/reply/agent-runner-admission.js";
import {
  createMockFollowupRun,
  createMockTypingController,
} from "../auto-reply/reply/test-helpers.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { bindCronJobAdmittedRun, resetCronActiveJobs } from "../cron/active-jobs.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { prepareCronRunAdmission } from "../cron/run-admission.js";
import { resolveCronRunAdmissionSource } from "../cron/run-authority.js";
import { markServiceCronJobActive } from "../cron/service/run-receipts.js";
import { createCronServiceState } from "../cron/service/state.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import { releaseLocalCronRunReceiptOwnership } from "../cron/store/run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  finishCronRunReceiptAsync,
} from "../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import {
  insertOperatorApproval,
  listCronStandingGrants,
  revokeCronStandingGrant,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import {
  lookupCronRunExecSource,
  registerCronRunExecSource,
} from "../infra/cron-run-exec-source.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { readExecApprovalsSnapshot, updateExecApprovals } from "../infra/exec-approvals-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import * as cronGrant from "./bash-tools.exec-cron-grant.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const commitExecAuthorizationMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked>(),
);
const approvalDecisionMock = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
const callGatewayToolMock = vi.hoisted(() =>
  vi.fn(async (method: string) => {
    if (method === "exec.approval.request") {
      return { status: "accepted" };
    }
    if (method !== "exec.approval.waitDecision") {
      throw new Error(`Unexpected Gateway method: ${method}`);
    }
    const decision = await approvalDecisionMock();
    if (decision === undefined) {
      throw new Error("approval request failed");
    }
    return { decision };
  }),
);

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: () => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    segmentSatisfiedBy: [],
  }),
  hasDurableExecApproval: () => false,
  hasExactCommandDurableExecApproval: () => false,
  buildEnforcedShellCommand: () => ({ ok: false, reason: "segment execution plan unavailable" }),
  requiresExecApproval: () => true,
  commitExecAuthorizationLocked: commitExecAuthorizationMock,
  resolveApprovalAuditTrustPath: () => null,
  resolveAllowAlwaysPatterns: () => [],
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>()),
  // Initial host evaluation is outside the moved SQL boundary; final policy validation stays real.
  resolveExecHostApprovalContext: () => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "on-miss",
    askFallback: "deny",
  }),
}));

// mock-isolation: Approval decisions use a synthetic RPC peer; no live Gateway is contacted.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: () => ({}),
}));

function captureSecurityEvents() {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

function runGatewayAllowlist(
  params: Pick<
    Parameters<typeof processGatewayAllowlist>[0],
    "command" | "workdir" | "agentId" | "runId" | "ask" | "signal"
  >,
) {
  return processGatewayAllowlist({
    env: process.env as Record<string, string>,
    pty: false,
    defaultTimeoutSec: 30,
    security: "allowlist",
    safeBins: new Set(),
    safeBinProfiles: {},
    warnings: [],
    approvalRunningNoticeMs: 0,
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    ...params,
  });
}

describe("cron standing grants", () => {
  const CRON_STORE_KEY = "/tmp/openclaw-exec-host-cron-store";
  const grantCommand =
    process.platform === "win32"
      ? "Add-Content -Encoding utf8 -Path cron-native-effects.txt -Value cron-native-launch"
      : "printf 'cron-native-launch\\n' >> cron-native-effects.txt";
  let stateDirBackup: string | undefined;
  let hadStateDirBackup = false;
  let workdir: string;
  let unregisterCronSource: (() => void) | undefined;
  let runOwner:
    | ReturnType<typeof prepareCronRunAdmission>
    | ReturnType<typeof prepareReplyTurnExecution>
    | undefined;
  let controller: AbortController;
  const releases: Array<() => void> = [];

  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

  beforeEach(() => {
    hadStateDirBackup = "OPENCLAW_STATE_DIR" in process.env;
    stateDirBackup = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.realpathSync(grantTempDirs.make("openclaw-cron-grant-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    workdir = fs.realpathSync(grantTempDirs.make("openclaw-cron-grant-cwd-"));
    if (process.platform !== "win32") {
      vi.stubEnv("SHELL", "/bin/sh");
    }
    resetGatewayWorkAdmission();
    resetDiagnosticEventsForTest();
    commitExecAuthorizationMock.mockReset();
    approvalDecisionMock.mockReset();
    callGatewayToolMock.mockClear();
  });

  const grantTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const release of releases.splice(0)) {
        release();
      }
      unregisterCronSource?.();
      unregisterCronSource = undefined;
      await runOwner?.close();
      runOwner = undefined;
      resetCronActiveJobs();
      resetProcessRegistryForTests();
      for (const dir of grantTempDirs.dirs) {
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
        );
      }
      closeOpenClawStateDatabaseForTest();
      if (hadStateDirBackup) {
        process.env.OPENCLAW_STATE_DIR = stateDirBackup;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  function databaseOptions() {
    return { env: { ...process.env } };
  }

  function seedCronJobRow(sessionTarget: "isolated" | "main") {
    const database = openOpenClawStateDatabase(databaseOptions());
    // SAFETY: minimal valid cron job shape for the storage codec round-trip.
    const job = {
      id: "job-1",
      agentId: "main",
      name: "Nightly backup",
      enabled: true,
      createdAtMs: Date.now() - 1_000,
      updatedAtMs: Date.now() - 1_000,
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run the backup" },
    } as CronStoredJob;
    upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
    const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
    const loadedJob = loaded.store.jobs.find((entry) => entry.id === "job-1");
    if (!loadedJob) {
      throw new Error("seeded cron job did not load back");
    }
    return loadedJob;
  }

  async function mintStandingGrant(revision: string, expiresAtMs: number | null): Promise<void> {
    await insertOperatorApproval({
      approval: {
        id: "cron-approval-1",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: grantCommand,
          commandPreview: grantCommand,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        reviewerDeviceIds: [],
        source: {
          agentId: "main",
          sessionKey: "agent:main:cron:job-1",
          sessionId: "session-1",
          runId: "cron-run-0",
          toolCallId: null,
          toolName: "exec",
        },
        audienceSessionKeys: [],
        runtimeEpoch: "epoch-1",
        createdAtMs: Date.now() - 500,
        expiresAtMs: Date.now() + 60_000,
      },
      databaseOptions: databaseOptions(),
    });
    const resolved = await resolveOperatorApproval({
      id: "cron-approval-1",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer-1" },
      databaseOptions: databaseOptions(),
      standingGrant: {
        kind: "cron",
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: revision,
        operationBinding: buildCronExecOperationBinding({
          command: grantCommand,
          cwd: workdir,
          env: undefined,
        }),
        expiresAtMs,
      },
    });
    expect(resolved.outcome).toBe("resolved");
  }

  function readGrantUseCounts(): number[] {
    const database = openOpenClawStateDatabase(databaseOptions());
    const stateDb = getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "operator_approval_standing_grants">
    >(database.db);
    return executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("operator_approval_standing_grants").select(["use_count"]),
    ).rows.map((row) => row.use_count);
  }

  async function prepareCronRun(
    mintGrant: boolean,
    expiresAtMs: number | null = null,
    sessionTarget: "isolated" | "main" = "isolated",
  ) {
    const job = seedCronJobRow(sessionTarget);
    const admissionSource = resolveCronRunAdmissionSource(job);
    const revision = resolveCronJobConfigRevision(job);
    const receipt = claimCronRunReceiptForTest(CRON_STORE_KEY, job, Date.now());
    releases.push(() => releaseLocalCronRunReceiptOwnership(receipt));
    const marker = markServiceCronJobActive(
      createCronServiceState({
        scheduler: createTestGatewayScheduler(),
        storePath: CRON_STORE_KEY,
        cronEnabled: true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      }),
      job,
      receipt,
    );
    controller = new AbortController();
    let isolatedAdmission: ReturnType<typeof prepareCronRunAdmission> | undefined;
    if (sessionTarget === "main") {
      runOwner = prepareReplyTurnExecution(
        {
          commandBody: "run the backup",
          followupRun: createMockFollowupRun({
            run: {
              sessionKey: "agent:main:main",
              scheduledAutomation: {
                job,
                admissionSource,
                assertCurrent: () => controller.signal.throwIfAborted(),
              },
            },
          }),
          sessionCtx: {},
          opts: { abortSignal: controller.signal },
          typingSignals: createTypingSignaler({
            typing: createMockTypingController(),
            mode: "never",
          }),
          blockReplyPipeline: null,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          applyReplyToMode: (payload) => payload,
          shouldEmitToolResult: () => false,
          shouldEmitToolOutput: () => false,
          pendingToolTasks: new Set(),
          getActiveSessionEntry: () => undefined,
          resolvedVerboseLevel: "off",
        },
        "cron-run-1",
      );
    } else {
      isolatedAdmission = prepareCronRunAdmission({
        admissionSource,
        cfg: {},
        agentId: "main",
        runId: "cron-run-1",
        jobId: job.id,
        sessionKey: "agent:main:cron:job-1",
        deliveryAttemptFence: null,
      });
      runOwner = isolatedAdmission;
    }
    bindCronJobAdmittedRun(
      marker,
      await runOwner.preparedRunAdmission.admit("embedded"),
      controller.signal,
    );
    if (mintGrant) {
      await mintStandingGrant(revision, expiresAtMs);
    }
    if (isolatedAdmission) {
      unregisterCronSource = registerCronRunExecSource("cron-run-1", {
        agentId: "main",
        jobId: "job-1",
        jobConfigRevision: revision,
        jobName: "Nightly backup",
        standingGrantAuthority: isolatedAdmission.standingGrantAuthority,
      });
    }
    return { job, receipt };
  }

  async function runCron() {
    const result = await runGatewayAllowlist({
      command: grantCommand,
      workdir,
      agentId: "main",
      runId: "cron-run-1",
      ask: "on-miss",
      signal: controller.signal,
    });
    if (result.releaseSpawn) {
      releases.push(result.releaseSpawn);
    }
    return result;
  }

  async function runNativeCron(approval: Awaited<ReturnType<typeof runCron>>) {
    const scopeKey = `cron-native:${workdir}`;
    const closeScope = getProcessSupervisor().acquireScopeCleanup(scopeKey, {
      processTree: "owned-only",
    });
    try {
      const run = await runExecProcess({
        command: grantCommand,
        execCommand: approval.execCommandOverride ?? grantCommand,
        workdir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: workdir,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: 10,
        scopeKey,
        startupSignal: controller.signal,
        beforeSpawn: approval.revalidateBeforeExecution,
        assertCurrent: approval.assertCurrent,
        initiateSpawn: approval.initiateSpawn,
        releaseSpawn: approval.releaseSpawn,
      });
      return await run.promise;
    } finally {
      await closeScope();
    }
  }

  function readNativeEffects() {
    return fs
      .readFileSync(path.join(workdir, "cron-native-effects.txt"), "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  }

  it("executes a cron occurrence via a standing grant without prompting", async () => {
    await prepareCronRun(true);
    const security = captureSecurityEvents();
    const sql = observeMainThreadSql();
    sql.calibrate();
    let result: Awaited<ReturnType<typeof runCron>>;
    try {
      result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      expect(result.revalidateBeforeExecution).toBeDefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      sql.expectIdle();
    } finally {
      sql.restore();
      security.stop();
    }
    await expect(runNativeCron(result)).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(readNativeEffects()).toBe("cron-native-launch");
    await expect(runNativeCron(result)).rejects.toThrow("exec denied by final preflight");
    expect(readNativeEffects()).toBe("cron-native-launch");
    expect(JSON.stringify(security.events)).toContain("standing-grant");
    expect(readGrantUseCounts()).toEqual([1]);
  });

  it("uses ordinary reply admission for a standing grant and refuses retained launches after close", async () => {
    await prepareCronRun(true, null, "main");
    const approval = await runCron();
    expect(approval.pendingResult).toBeUndefined();
    expect(approval.deniedResult).toBeUndefined();
    expect(approval.revalidateBeforeExecution).toBeDefined();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    await expect(runNativeCron(approval)).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(readNativeEffects()).toBe("cron-native-launch");

    const retained = await runCron();
    expect(retained.revalidateBeforeExecution).toBeDefined();
    await runOwner?.close();
    expect(lookupCronRunExecSource("cron-run-1")).toBeUndefined();
    await expect(runNativeCron(retained)).rejects.toThrow("exec denied by final preflight");
    expect(readNativeEffects()).toBe("cron-native-launch");
    expect(readGrantUseCounts()).toEqual([1]);
  });

  it.each(["revoked grant", "finished receipt", "replacement receipt"] as const)(
    "prevents native I/O after consult with a %s",
    async (invalidation) => {
      const { job, receipt } = await prepareCronRun(true);
      const security = captureSecurityEvents();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(result.revalidateBeforeExecution).toBeDefined();
      if (invalidation === "revoked grant") {
        const [grant] = await listCronStandingGrants();
        await revokeCronStandingGrant({ grantId: grant!.grantId, revokedBy: "operator" });
      } else {
        await finishCronRunReceiptAsync({
          handle: receipt,
          status: "ok",
          finishedAtMs: Date.now(),
        });
        if (invalidation === "replacement receipt") {
          const successor = claimCronRunReceiptForTest(CRON_STORE_KEY, job, Date.now());
          releases.push(() => releaseLocalCronRunReceiptOwnership(successor));
          expect(successor.receiptId).not.toBe(receipt.receiptId);
        }
      }
      await expect(runNativeCron(result)).rejects.toMatchObject({
        message: "exec denied by final preflight",
        result: {
          details: { status: "failed" },
          content: [
            expect.objectContaining({
              text: expect.stringContaining("standing grant no longer valid"),
            }),
          ],
        },
      });
      security.stop();
      expect(fs.existsSync(path.join(workdir, "cron-native-effects.txt"))).toBe(false);
      expect(readGrantUseCounts()).toEqual([0]);
      expect(JSON.stringify(security.events)).toContain("standing-grant-invalidated");
    },
  );

  it.each([
    "revoke",
    "cancel",
    "fallback",
    "policy deny",
    "policy ask",
    "expiry",
    "native throw",
  ] as const)(
    "settles one consumed use when %s intervenes before native initiation",
    async (intervention) => {
      const expiresAtMs = 4_000_000_000_000;
      await prepareCronRun(true, intervention === "expiry" ? expiresAtMs : null);
      const [grant] = await listCronStandingGrants();
      const result = await runCron();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      const order: string[] = [];
      const launch = vi.fn(() => {
        order.push("launch");
        if (intervention === "native throw") {
          throw new Error("synthetic native launch failure");
        }
      });
      if (intervention === "revoke") {
        await revokeCronStandingGrant({ grantId: grant!.grantId, revokedBy: "operator" });
        order.push("revoked");
      } else if (intervention === "cancel") {
        controller.abort();
      } else if (intervention === "policy deny" || intervention === "policy ask") {
        const file = readExecApprovalsSnapshot().file;
        await updateExecApprovals({
          update: {
            kind: "replace",
            file: {
              ...file,
              defaults: {
                ...file.defaults,
                ...(intervention === "policy deny"
                  ? { security: "deny" as const }
                  : { ask: "always" as const }),
              },
            },
          },
        });
      } else if (intervention === "fallback") {
        // A proven no-initiation retry revalidates without another consume.
        result.releaseSpawn?.("retry");
        await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      }
      if (intervention === "expiry") {
        const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAtMs);
        try {
          expect(() => result.initiateSpawn?.(launch)).toThrow();
          expect(launch).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
        }
      } else if (intervention === "native throw") {
        expect(() => result.initiateSpawn?.(launch)).toThrow("synthetic native launch failure");
        expect(launch).toHaveBeenCalledOnce();
        expect((await result.revalidateBeforeExecution?.())?.details.status).toBe("failed");
      } else if (intervention.startsWith("policy")) {
        await expect(runNativeCron(result)).rejects.toThrow("exec denied by final preflight");
        expect(fs.existsSync(path.join(workdir, "cron-native-effects.txt"))).toBe(false);
      } else if (intervention === "cancel") {
        expect(() => result.initiateSpawn?.(launch)).toThrow();
        expect(launch).not.toHaveBeenCalled();
      } else {
        result.initiateSpawn?.(launch);
        expect(launch).toHaveBeenCalledOnce();
      }
      if (intervention === "revoke") {
        // Revocation after committed consumption does not fence a checked native launch.
        expect(order).toEqual(["revoked", "launch"]);
      }
      expect(readGrantUseCounts()).toEqual([1]);
    },
  );

  it("denies native execution when a committed grant expires before its consume reply returns", async ({
    signal,
  }) => {
    const expiresAtMs = 4_000_000_000_000;
    await prepareCronRun(true, expiresAtMs);
    const consumed = createDeferredCore();
    const releaseReply = createDeferredCore();
    const prepare = cronGrant.prepareCronStandingGrantConsumption;
    const delayedReply = vi
      .spyOn(cronGrant, "prepareCronStandingGrantConsumption")
      .mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        if (!prepared) {
          return prepared;
        }
        return {
          ...prepared,
          async consume(...input: Parameters<typeof prepared.consume>) {
            const result = await prepared.consume(...input);
            // Delay only the real owner's reply, after its committed use and publication.
            consumed.resolve();
            await releaseReply.promise;
            return result;
          },
        };
      });
    const security = captureSecurityEvents();
    const approved = () =>
      security.events.filter((event) => event.reason?.startsWith("standing-grant grant="));
    const clock = vi.spyOn(Date, "now");
    let execution: ReturnType<typeof runNativeCron> | undefined;
    try {
      execution = runNativeCron(await runCron());
      await withinTest(
        awaitGateBeforeSettlement(
          consumed.promise,
          execution,
          "Exec missed the consume reply gate",
        ),
        signal,
      );
      expect(readGrantUseCounts()).toEqual([1]);
      expect(approved()).toEqual([]);
      clock.mockReturnValue(expiresAtMs);
      releaseReply.resolve();
      await expect(execution).rejects.toMatchObject({
        message: "exec denied by final preflight",
        result: {
          details: { status: "failed" },
          content: [
            {
              type: "text",
              text: expect.stringContaining("standing grant no longer valid (expired)"),
            },
          ],
        },
      });
      expect(approved()).toEqual([]);
      expect(fs.existsSync(path.join(workdir, "cron-native-effects.txt"))).toBe(false);
      expect(readGrantUseCounts()).toEqual([1]);
    } finally {
      releaseReply.resolve();
      await Promise.allSettled([execution]);
      clock.mockRestore();
      security.stop();
      delayedReply.mockRestore();
    }
  });

  it("refuses policy tightening until a consumed remote launch acknowledges initiation", async () => {
    await prepareCronRun(true);
    const result = await runCron();
    await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
    const acknowledgement = createDeferredCore();
    const deny = () =>
      updateExecApprovals({
        update: {
          kind: "replace",
          file: { ...readExecApprovalsSnapshot().file, defaults: { security: "deny" } },
        },
      });
    try {
      const launch = vi.fn();
      result.initiateSpawn?.(launch, acknowledgement.promise);
      expect(launch).toHaveBeenCalledOnce();
      result.releaseSpawn?.();
      await expect(deny()).rejects.toThrow("native launch acknowledgement is pending");
      acknowledgement.resolve();
      await acknowledgement.promise;
      await expect(deny()).resolves.not.toBeNull();
      expect(readGrantUseCounts()).toEqual([1]);
    } finally {
      acknowledgement.resolve();
      result.releaseSpawn?.();
    }
  });

  it("never launches or reconsumes after an unknown committed-use publication", async () => {
    await prepareCronRun(true);
    const result = await runCron();
    const observe = workerAdmission.observeSqliteWorkerCommittedFacts;
    const publication = vi
      .spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts")
      .mockImplementation((admission, observer) =>
        observe(admission, (receipt) => {
          observer(receipt);
          throw new Error("synthetic consume publication loss");
        }),
      );
    try {
      expect((await result.revalidateBeforeExecution?.())?.details.status).toBe("failed");
    } finally {
      publication.mockRestore();
    }
    expect((await result.revalidateBeforeExecution?.())?.details.status).toBe("failed");
    const launch = vi.fn();
    expect(() => result.initiateSpawn?.(launch)).toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(readGrantUseCounts()).toEqual([1]);
  });

  it("skips the JSON allowlist digest when a cron allow-always resolves", async () => {
    await prepareCronRun(false);
    approvalDecisionMock.mockResolvedValue("allow-always");
    const committed = createDeferredCore();
    commitExecAuthorizationMock.mockImplementationOnce(async () => {
      committed.resolve();
      return () => {};
    });
    const result = await runCron();
    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult).toBeUndefined();
    await committed.promise;
    expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
    expect(commitExecAuthorizationMock.mock.calls[0]?.[0].allowAlwaysDecision).toBeUndefined();
  });
});
