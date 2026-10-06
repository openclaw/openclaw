import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  clearLiveModelSwitchPending,
  consolidateLiveModelSwitchAfterRun,
  shouldSwitchToLiveModel,
} from "./live-model-switch.js";
import { createAgentPatchedSessionModelRunGuard } from "./session-model-auto-revert.js";

afterEach(() => vi.restoreAllMocks());

describe("live model switch worker persistence", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-model-switch-worker-");

  it.each(["clear", "consolidate"] as const)(
    "%s consumes only the applied selection without host session SQL",
    async (operation) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const scope = { storePath, sessionKey: "agent:main:model-switch" };
      const cfg = { session: { store: storePath } };
      const initial = {
        sessionId: "model-switch",
        updatedAt: 1,
        label: "keep this label",
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      };
      await replaceSessionEntry(scope, initial);
      const apply = () =>
        operation === "clear"
          ? clearLiveModelSwitchPending({
              cfg,
              sessionKey: scope.sessionKey,
              agentId: "main",
              defaultProvider: "openai",
              defaultModel: "gpt-5.4",
              expectedSelection: { provider: "openai", model: "gpt-5.4" },
            })
          : consolidateLiveModelSwitchAfterRun({
              cfg,
              sessionKey: scope.sessionKey,
              agentId: "main",
              providerUsed: "openai",
              modelUsed: "gpt-5.4",
            });
      const sql = observeHostDataSql();
      try {
        await apply();
        expect(
          sql.queries.filter((query) =>
            /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: initial.sessionId,
        label: initial.label,
        modelOverride: initial.modelOverride,
      });
      expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();

      await replaceSessionEntry(scope, { ...initial, modelOverride: "gpt-5.5" });
      await apply();
      expect(loadSessionEntry(scope)).toMatchObject({
        liveModelSwitchPending: true,
        modelOverride: "gpt-5.5",
      });
      const readSql = observeHostDataSql();
      try {
        expect(
          await shouldSwitchToLiveModel({
            ...scope,
            cfg,
            agentId: "main",
            defaultProvider: "openai",
            defaultModel: "gpt-5.4",
            currentProvider: "openai",
            currentModel: "gpt-5.4",
          }),
        ).toMatchObject({ provider: "openai", model: "gpt-5.5" });
        expect(
          readSql.queries.filter((query) =>
            /session_nodes|session_entry_snapshots|session_participants|session_windows/i.test(
              query,
            ),
          ),
        ).toEqual([]);
      } finally {
        readSql.restore();
      }
    },
  );
});

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
