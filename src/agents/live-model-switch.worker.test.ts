import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearLiveModelSwitchPending,
  consolidateLiveModelSwitchAfterRun,
  shouldSwitchToLiveModel,
} from "./live-model-switch.js";
import { createAgentPatchedSessionModelRunGuard } from "./session-model-auto-revert.js";

vi.mock("../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("../config/sessions/session-history-eviction.js", () => ({
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

afterEach(() => vi.restoreAllMocks());

it.each(["clear", "consolidate"] as const)(
  "%s consumes only the selected model without caller-thread session SQL",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:worker-model-switch",
      };
      const cfg: OpenClawConfig = { session: { store: database.path } };
      const entry = {
        sessionId: "model-switch-session",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        liveModelSwitchPending: true,
      };
      replaceSessionEntrySync(scope, entry);
      const consume = () =>
        operation === "clear"
          ? clearLiveModelSwitchPending({
              ...scope,
              cfg,
              defaultProvider: "openai",
              defaultModel: "gpt-5.4",
              expectedSelection: { provider: "openai", model: "gpt-5.4" },
            })
          : consolidateLiveModelSwitchAfterRun({
              ...scope,
              cfg,
              providerUsed: "openai",
              modelUsed: "gpt-5.4",
            });
      const sql = observeHostDataSql();
      try {
        await consume();
        expect(
          sql.queries.filter((query) =>
            /session_nodes|session_entry_snapshots|session_participants|session_windows/i.test(
              query,
            ),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadSessionEntry(scope)).not.toHaveProperty("liveModelSwitchPending");

      replaceSessionEntrySync(scope, { ...entry, modelOverride: "gpt-5.5" });
      await consume();
      expect(loadSessionEntry(scope)).toMatchObject({
        modelOverride: "gpt-5.5",
        liveModelSwitchPending: true,
      });
      expect(
        await shouldSwitchToLiveModel({
          ...scope,
          cfg,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          currentProvider: "openai",
          currentModel: "gpt-5.4",
        }),
      ).toMatchObject({ provider: "openai", model: "gpt-5.5" });
    });
  },
);

it("propagates model-guard read cancellation instead of treating it as missing metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:model-guard-cancel",
    };
    replaceSessionEntrySync(scope, { sessionId: "model-guard-session", updatedAt: 1 });
    const controller = new AbortController();
    const reason = new Error("model read owner cancelled");
    let cancelledAtAdmission = false;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          cancelledAtAdmission = true;
          controller.abort(reason);
          callback(request, grant);
        }, attachment),
    );
    await expect(
      createAgentPatchedSessionModelRunGuard({
        ...scope,
        cfg: {},
        assertReadCurrent: () => controller.signal.throwIfAborted(),
      }),
    ).rejects.toBe(reason);
    expect(cancelledAtAdmission).toBe(true);
  });
});
