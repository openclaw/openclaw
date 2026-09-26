import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getTaskById } from "../../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as admission from "./subagent-completion-admission.store.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("subagent completion recovery identity", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make(
      "openclaw-completion-recovery-",
      resolvePreferredOpenClawTmpDir(),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    resumeSubagentRun.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function persistCompletion(
    name: "old" | "current",
    deliveryStatus: "suspended" | "delivered" = "suspended",
    remappedRun = false,
  ) {
    const now = Date.now();
    const task: TaskRecord = {
      taskId: `task-${name}`,
      runId: `run-${name}`,
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:shared",
      task: `finish ${name} work`,
      status: "succeeded",
      deliveryStatus: deliveryStatus === "suspended" ? "failed" : "delivered",
      terminalOutcome: deliveryStatus === "suspended" ? "blocked" : "succeeded",
      progressSummary: `${name} result`,
      notifyPolicy: "done_only",
      createdAt: now - (name === "old" ? 20_000 : 10_000),
      endedAt: now - 1_000,
      lastEventAt: now,
      cleanupAfter: now + 7 * 24 * 60 * 60_000,
    };
    const subagent = createSubagentRunRecord({
      runId: remappedRun ? `completion-${name}` : task.runId!,
      taskRunId: remappedRun ? task.runId : undefined,
      childSessionKey: task.childSessionKey,
      task: task.task,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: `${name} result`, capturedAt: now },
      delivery: {
        status: deliveryStatus,
        disposition: deliveryStatus === "suspended" ? "permanent_failure" : "delivered",
        generation: 1,
        ...(deliveryStatus === "suspended"
          ? { suspendedAt: now, suspendedReason: "expiry", lastError: "requester unavailable" }
          : { deliveredAt: now }),
      },
    });
    settleSubagentCompletionDelivery({ subagent, task, databaseOptions: { database } });
    subagentRuns.set(subagent.runId, subagent);
    return { task, subagent };
  }

  function storedPair(pair: ReturnType<typeof persistCompletion>) {
    const row = database.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(pair.subagent.runId) as { payload_json: string } | undefined;
    return {
      task: database.db.prepare("SELECT * FROM task_runs WHERE task_id = ?").get(pair.task.taskId),
      subagent: row ? (JSON.parse(row.payload_json) as unknown) : undefined,
    };
  }

  function dismiss(taskId: string) {
    return dismissSubagentCompletionDelivery(taskId, {
      discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
      databaseOptions: { database },
    });
  }

  it.each([false, true])(
    "dismisses only the selected result (remapped run: %s)",
    async (remapped) => {
      // Retained completions precede follow-up runs on the same reusable child session.
      const old = persistCompletion("old");
      const current = persistCompletion("current", "suspended", remapped);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect.soft(dismiss("task-current")).resolves.toMatchObject({
        ok: true,
        task: {
          taskId: "task-current",
          deliveryStatus: "dismissed",
          progressSummary: "current result",
        },
      });
      expect.soft(storedPair(current).task).toMatchObject({
        delivery_status: "dismissed",
        progress_summary: "current result",
        terminal_outcome: "blocked",
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );

  it.each(["delivered", "suspended"] as const)(
    "retries the selected completion with an older %s run on its session",
    async (oldStatus) => {
      const old = persistCompletion("old", oldStatus);
      const current = persistCompletion("current", "suspended", true);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect
        .soft(retrySubagentCompletionDelivery("task-current", { database }))
        .resolves.toMatchObject({
          ok: true,
          duplicateRisk: true,
          task: {
            taskId: "task-current",
            deliveryStatus: "pending",
            progressSummary: "current result",
          },
        });
      expect.soft(resumeSubagentRun.mock.calls).toEqual([[current.subagent.runId]]);
      expect.soft(storedPair(current).task).toMatchObject({
        delivery_status: "pending",
        progress_summary: "current result",
        terminal_outcome: "succeeded",
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "pending",
          generation: 2,
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
    },
  );

  it.each(["dismiss", "retry", "retry and suspend"] as const)(
    "keeps the competing %s result while retry authority prepares",
    async (competing) => {
      const pair = persistCompletion("current");
      const context = createContext();
      const client = createOperatorClient({
        profileName: "held-retry",
        scopes: ["operator.write"],
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const capture = operatorCapture.captureGatewayOperatorRunAuthority;
      let captured: Awaited<ReturnType<typeof capture>>;
      const held = vi
        .spyOn(operatorCapture, "captureGatewayOperatorRunAuthority")
        .mockImplementationOnce(async (...args) => {
          captured = await capture(...args);
          entered.resolve();
          await resume.promise;
          return captured;
        });
      const pending = withPluginRuntimeGatewayRequestScope(
        { client, context, isWebchatConnect: () => false },
        () => retrySubagentCompletionDelivery(pair.task.taskId, { database }),
      );
      const settled = Promise.allSettled([pending]);
      try {
        await entered.promise;
        if (competing === "dismiss") {
          await dismiss(pair.task.taskId);
        } else {
          await retrySubagentCompletionDelivery(pair.task.taskId, { database });
          if (competing === "retry and suspend") {
            expect(
              admission.blockSubagentCompletionDelivery({
                subagent: pair.subagent,
                taskId: pair.task.taskId,
                reason: "retry blocked again",
                suspendedReason: "permanent_failure",
                databaseOptions: { database },
              }),
            ).toBe(true);
          }
        }
        const committed = storedPair(pair);
        const resumptions = resumeSubagentRun.mock.calls.length;
        resume.resolve();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          reason: "completion delivery changed during preparation",
        });
        expect(storedPair(pair)).toEqual(committed);
        expect(resumeSubagentRun).toHaveBeenCalledTimes(resumptions);
        expect(captured?.authority.assertCurrent).toThrow();
      } finally {
        resume.resolve();
        await settled;
        held.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "retries under a fresh operator without reviving retired custody (write fails: %s)",
    async (fails) => {
      const { subagent, task } = persistCompletion("current");
      const context = createContext();
      const originalClient = createOperatorClient({
        profileName: "original",
        scopes: ["operator.write"],
      });
      const original = (await withPluginRuntimeGatewayRequestScope(
        { client: originalClient, context, isWebchatConnect: () => false },
        captureOperatorToolGatewayContinuationContext,
      ))!;
      subagentRuns.bindCompletionAuthority(subagent, original);
      subagentRuns.releaseCompletionAuthority(subagent);
      expect(() => subagentRuns.runWithCompletionAuthority(subagent, () => "retired")).toThrow(
        /authority/,
      );
      const client = createOperatorClient({
        profileName: "retry-owner",
        scopes: ["operator.write"],
      });
      const fresh = (await operatorCapture.captureGatewayOperatorRunAuthority({
        client,
        context,
      }))!;
      client.internal = { operatorRunAuthority: fresh.authority };
      if (fails) {
        vi.spyOn(admission, "settleSubagentCompletionDelivery").mockImplementationOnce(() => {
          throw new Error("write refused");
        });
      }
      try {
        const retry = withPluginRuntimeGatewayRequestScope(
          { client, context, isWebchatConnect: () => false },
          () => retrySubagentCompletionDelivery(task.taskId, { database }),
        );
        if (fails) {
          await expect(retry).rejects.toThrow("write refused");
        } else {
          await expect(retry).resolves.toMatchObject({ ok: true });
        }
        fresh.release();
        if (fails) {
          expect(fresh.authority.assertCurrent).toThrow();
        } else {
          subagentRuns.runWithCompletionAuthority(subagent, () =>
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source,
            ).toBe(fresh.authority.source),
          );
          subagentRuns.releaseCompletionAuthority(subagent);
          expect(fresh.authority.assertCurrent).toThrow();
        }
        expect(original.operatorAuthority?.assertCurrent).toThrow();
      } finally {
        fresh.release();
      }
    },
  );

  it.each(["dismiss", "retry"] as const)(
    "%s fails closed when only a sibling completion owner remains",
    async (action) => {
      const old = persistCompletion("old");
      const current = persistCompletion("current");
      subagentRuns.delete(current.subagent.runId);
      database.db.prepare("DELETE FROM subagent_runs WHERE run_id = ?").run(current.subagent.runId);
      const oldRows = storedPair(old);
      const currentRows = storedPair(current);
      const oldLive = structuredClone(old.subagent);
      const currentTask = getTaskById("task-current");

      const result = await (action === "dismiss"
        ? dismiss("task-current")
        : retrySubagentCompletionDelivery("task-current", { database }));

      expect(result).toEqual({
        ok: false,
        reason:
          action === "dismiss"
            ? "completion delivery is not blocked"
            : "task has no recoverable subagent completion",
      });
      expect(storedPair(old)).toEqual(oldRows);
      expect(storedPair(current)).toEqual(currentRows);
      expect(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(getTaskById("task-current")).toEqual(currentTask);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );
});
