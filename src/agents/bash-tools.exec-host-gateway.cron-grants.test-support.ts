import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { projectCronReceiptAuthorityJobFacts } from "../cron/store/receipt-authority-facts.js";
import {
  observeCronReceiptAuthority,
  withCronReceiptAuthorityMutation,
} from "../cron/store/receipt-authority-owner.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import { finishCronRunReceiptAsync } from "../cron/store/run-receipt-store.js";
import { claimCronRunReceiptForTest } from "../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type {
  ProcessGatewayAllowlistParams,
  ProcessGatewayAllowlistResult,
} from "./bash-tools.exec-host-gateway.types.js";

type CronGrantFixture = {
  prepareApprovalPolicy: () => void;
  runGatewayAllowlist: (
    params: Partial<ProcessGatewayAllowlistParams> & Pick<ProcessGatewayAllowlistParams, "command">,
  ) => Promise<ProcessGatewayAllowlistResult>;
  approvalDecisionMock: Mock<() => Promise<string | null | undefined>>;
  createExecApprovalRequestRouteMock: Mock<
    typeof import("./bash-tools.exec-host-shared.js").createExecApprovalRequestRoute
  >;
  commitExecAuthorizationMock: Mock<
    typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked
  >;
  captureSecurityEvents: () => {
    events: Extract<DiagnosticEventPayload, { type: "security.event" }>[];
    stop: () => void;
  };
};

export function registerCronStandingGrantTests({
  prepareApprovalPolicy,
  runGatewayAllowlist,
  approvalDecisionMock,
  createExecApprovalRequestRouteMock,
  commitExecAuthorizationMock,
  captureSecurityEvents,
}: CronGrantFixture): void {
  describe("cron standing grants", () => {
    const CRON_STORE_KEY = "/tmp/openclaw-exec-host-cron-store";
    const grantCommand = "run-nightly-backup --verbose";
    const grantTempDirs: string[] = [];
    let stateDirBackup: string | undefined;
    let hadStateDirBackup = false;
    let workdir: string;
    let unregisterCronSource: (() => void) | undefined;

    beforeEach(() => {
      hadStateDirBackup = "OPENCLAW_STATE_DIR" in process.env;
      stateDirBackup = process.env.OPENCLAW_STATE_DIR;
      const stateDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-grant-state-")),
      );
      grantTempDirs.push(stateDir);
      process.env.OPENCLAW_STATE_DIR = stateDir;
      workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-grant-cwd-")));
      grantTempDirs.push(workdir);
      // Grants are consulted only when policy would otherwise prompt, before
      // any JSON allowlist digest can satisfy the command.
      prepareApprovalPolicy();
    });

    afterEach(async () => {
      unregisterCronSource?.();
      unregisterCronSource = undefined;
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      if (hadStateDirBackup) {
        process.env.OPENCLAW_STATE_DIR = stateDirBackup;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
      for (const dir of grantTempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function databaseOptions() {
      return { env: { ...process.env } };
    }

    function seedCronJobRow(): string {
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
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "run the backup" },
      } as CronStoredJob;
      upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
      const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
      const loadedJob = loaded.store.jobs.find((entry) => entry.id === "job-1");
      if (!loadedJob) {
        throw new Error("seeded cron job did not load back");
      }
      return resolveCronJobConfigRevision(loadedJob);
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

    async function prepareCronRun(mintGrant: boolean, expiresAtMs: number | null = null) {
      const revision = seedCronJobRow();
      if (mintGrant) {
        await mintStandingGrant(revision, expiresAtMs);
      }
      unregisterCronSource = registerCronRunExecSource("cron-run-1", {
        agentId: "main",
        jobId: "job-1",
        jobConfigRevision: revision,
        jobName: "Nightly backup",
      });
    }

    function runCron() {
      return runGatewayAllowlist({
        command: grantCommand,
        workdir,
        agentId: "main",
        runId: "cron-run-1",
        ask: "on-miss",
      });
    }

    it("executes a cron occurrence via a standing grant without prompting", async () => {
      await prepareCronRun(true);
      const security = captureSecurityEvents();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
      // Consultation skips the prompt; only pre-spawn revalidation records a use.
      expect(readGrantUseCounts()).toEqual([0]);
      expect(result.revalidateBeforeExecution).toBeDefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      security.stop();
      expect(JSON.stringify(security.events)).toContain("standing-grant");
      expect(readGrantUseCounts()).toEqual([1]);
    });

    it.for(["valid", "expired"] as const)(
      "serializes standing-grant consumption and publishes before returning execution authority (%s)",
      async (grantState, { signal }) => {
        const expiresAtMs = Date.now() + 60_000;
        await prepareCronRun(true, expiresAtMs);
        const result = await runCron();
        const revalidate = result.revalidateBeforeExecution;
        expect(revalidate).toBeDefined();
        if (!revalidate) {
          throw new Error("Expected standing-grant revalidation");
        }
        const database = openOpenClawStateDatabase(databaseOptions());
        const job = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY)).store
          .jobs[0]!;
        const handle = claimCronRunReceiptForTest(CRON_STORE_KEY, job, Date.now());
        const context = captureOpenClawStateWorkerContext();
        const observation = observeCronReceiptAuthority(
          context,
          { type: "cron.currentReceipt", handle, includeJob: true, includeAvailability: true },
          {
            receipt: handle,
            job: projectCronReceiptAuthorityJobFacts(job),
            deletionBlocked: false,
          },
        );
        const precedingEntered = createDeferredCore();
        const releasePreceding = createDeferredCore();
        const readCompleted = createDeferredCore();
        const releasePublication = createDeferredCore();
        const order: string[] = [];
        const read = stateReads.executeExistingOpenClawStateRead;
        const readGate = vi
          .spyOn(stateReads, "executeExistingOpenClawStateRead")
          .mockImplementation(async (...args) => {
            const reply = await read(...args);
            if (args[1].type === "cron.currentReceipt" && readGrantUseCounts()[0] === 1) {
              readCompleted.resolve();
              await releasePublication.promise;
              order.push("publication");
            }
            return reply;
          });
        const stopEvents = onInternalDiagnosticEvent((event, metadata) => {
          if (
            metadata.trusted &&
            event.type === "security.event" &&
            event.reason?.startsWith("standing-grant grant=")
          ) {
            order.push("approved");
          }
        });
        let preceding: Promise<void> | undefined;
        let consuming: ReturnType<typeof revalidate> | undefined;
        let following: Promise<void> | undefined;
        const clock = vi.spyOn(Date, "now");
        try {
          await withinTest(observation.prepared, signal);
          preceding = withCronReceiptAuthorityMutation(context, async () => {
            precedingEntered.resolve();
            await releasePreceding.promise;
            order.push("preceding");
          });
          await withinTest(precedingEntered.promise, signal);
          consuming = revalidate().then((denied) => {
            order.push("returned");
            return denied;
          });
          following = withCronReceiptAuthorityMutation(context, async () => {
            order.push("following");
          });
          expect(readGrantUseCounts()).toEqual([0]);
          expect(order).toEqual([]);
          releasePreceding.resolve();
          await withinTest(
            awaitGateBeforeSettlement(
              readCompleted.promise,
              consuming,
              "Standing grant returned before rebuilding committed authority",
            ),
            signal,
          );
          expect(readGrantUseCounts()).toEqual([1]);
          expect(order).toEqual(["preceding"]);
          expect(() => observation.readForPreparation()).toThrow("unavailable");
          if (grantState === "expired") {
            clock.mockReturnValue(expiresAtMs);
          }
          releasePublication.resolve();
          if (grantState === "expired") {
            await expect(consuming).resolves.toMatchObject({
              details: { status: "failed" },
              content: [
                {
                  type: "text",
                  text: expect.stringContaining("standing grant no longer valid (expired)"),
                },
              ],
            });
            expect(order).not.toContain("approved");
          } else {
            await expect(consuming).resolves.toBeUndefined();
            expect(order.indexOf("publication")).toBeLessThan(order.indexOf("approved"));
            expect(order.indexOf("approved")).toBeLessThan(order.indexOf("returned"));
          }
          await following;
          expect(order.indexOf("publication")).toBeLessThan(order.indexOf("following"));
          expect(order.indexOf("publication")).toBeLessThan(order.indexOf("returned"));
          expect(observation.readForPreparation().facts.receipt).toEqual(handle);
        } finally {
          releasePreceding.resolve();
          releasePublication.resolve();
          await Promise.allSettled([preceding, consuming, following]);
          stopEvents();
          readGate.mockRestore();
          clock.mockRestore();
          observation.release();
          await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: Date.now() });
        }
      },
    );

    it("denies revalidation when the grant is invalidated after consult", async () => {
      await prepareCronRun(true);
      const security = captureSecurityEvents();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(result.revalidateBeforeExecution).toBeDefined();
      // Revoke the parent approval between consult and spawn: the closure
      // must deny instead of executing on the stale authority.
      const database = openOpenClawStateDatabase(databaseOptions());
      // sqlite-allow-raw -- test-only reversal of the minting approval row.
      database.db
        .prepare("update operator_approvals set status = 'denied', decision = 'deny'")
        .run();
      const denied = await result.revalidateBeforeExecution?.();
      security.stop();
      expect(denied?.details.status).toBe("failed");
      expect(denied?.content[0]).toMatchObject({
        text: expect.stringContaining("standing grant no longer valid"),
      });
      expect(readGrantUseCounts()).toEqual([0]);
      expect(JSON.stringify(security.events)).toContain("standing-grant-invalidated");
    });

    it("skips the JSON allowlist digest when a cron allow-always resolves", async () => {
      await prepareCronRun(false);
      approvalDecisionMock.mockResolvedValue("allow-always");
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      await vi.waitFor(() => expect(commitExecAuthorizationMock).toHaveBeenCalledOnce());
      expect(commitExecAuthorizationMock.mock.calls[0]?.[0].allowAlwaysDecision).toBeUndefined();
    });
  });
}
