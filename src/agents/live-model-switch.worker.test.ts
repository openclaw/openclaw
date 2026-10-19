import path from "node:path";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  clearLiveModelSwitchPending,
  prepareLiveModelSwitchAfterRun,
  shouldSwitchToLiveModel,
} from "./live-model-switch.js";
import { createAgentPatchedSessionModelRunGuard } from "./session-model-auto-revert.js";

afterEach(() => vi.restoreAllMocks());

describe("live model switch worker persistence", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-model-switch-worker-");

  function completeSelection(
    scope: { storePath: string; sessionKey: string },
    commandId: string,
    selectReducer: (entry: SessionEntry) => ReturnType<typeof prepareLiveModelSwitchAfterRun>,
  ) {
    const authority = { assertCurrent() {}, authorize() {} };
    return withSessionActor(scope, { assertCurrent() {}, assertReadable() {} }, async (actor) => {
      const snapshot = actor.snapshot(authority) ?? (await actor.read(authority));
      const entry = snapshot.entry!;
      const reducer = selectReducer(entry);
      if (!reducer) {
        return undefined;
      }
      const outcome = await actor.completeTurn(
        {
          commandId,
          phaseId: "completion",
          expected: snapshot.version,
          bookkeeping: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision ?? null,
            writerRunId: entry.activeWriterRunId,
            expectedState: buildRestartRecoveryExpectedState(entry),
          },
          reducers: [reducer],
        },
        authority,
      );
      expect(outcome.kind).toBe("committed");
      return outcome;
    });
  }

  it.each(["clear", "complete"] as const)(
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
      const apply = async () => {
        if (operation === "clear") {
          await clearLiveModelSwitchPending({
            cfg,
            sessionKey: scope.sessionKey,
            agentId: "main",
            defaultProvider: "openai",
            defaultModel: "gpt-5.4",
            expectedSelection: { provider: "openai", model: "gpt-5.4" },
          });
          return;
        }
        await completeSelection(scope, "complete-selection", (entry) =>
          prepareLiveModelSwitchAfterRun({
            cfg,
            sessionKey: scope.sessionKey,
            agentId: "main",
            providerUsed: "openai",
            modelUsed: "gpt-5.4",
            entry,
          }),
        );
      };
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

      const withoutPendingSwitch = loadSessionEntry(scope);
      const writeGrants: string[] = [];
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const observeAdmission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              writeGrants.push(request.stage);
            }
            callback(request, grant);
          }, attachment),
        );
      try {
        await apply();
        expect(writeGrants).toEqual([]);
        expect(loadSessionEntry(scope)).toEqual(withoutPendingSwitch);
      } finally {
        observeAdmission.mockRestore();
      }

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

  it("keeps newer selections when a prepared terminal reducer reaches the actor", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const scope = { storePath, sessionKey: "agent:main:model-switch" };
    const cfg = { session: { store: storePath } };
    const initial = {
      sessionId: "model-switch",
      updatedAt: 1,
      liveModelSwitchPending: true,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      agentRuntimeOverride: "openclaw",
      authProfileOverride: "profile-a",
      authProfileOverrideSource: "user" as const,
    };
    const reducer = prepareLiveModelSwitchAfterRun({
      cfg,
      sessionKey: scope.sessionKey,
      entry: initial,
      providerUsed: "openai",
      modelUsed: "gpt-5.4",
    });
    if (!reducer) {
      throw new Error("Expected applied model selection");
    }
    for (const newer of [
      { providerOverride: "other-provider" },
      { modelOverride: "gpt-5.5" },
      { agentRuntimeOverride: "codex" },
      { authProfileOverride: "profile-b" },
      { authProfileOverrideSource: "auto" as const },
    ]) {
      await replaceSessionEntry(scope, { ...initial, ...newer });
      const outcome = await completeSelection(scope, "prepared-selection", () => reducer);
      expect(outcome).toMatchObject({
        kind: "committed",
        receipt: { reducers: [{ kind: "live-model", changed: false }] },
      });
      expect(loadSessionEntry(scope)).toMatchObject({ liveModelSwitchPending: true, ...newer });
    }
  });
});

it("propagates model-guard read cancellation instead of treating it as missing metadata", async () => {
  const warnings = createWarnLogCapture("model-guard-read-cancel");
  onTestFinished(() => warnings.cleanup());
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
    probe.admission(workerAdmission, (request, grant, callback) => {
      cancelledAtAdmission = true;
      controller.abort(reason);
      callback(request, grant);
    });
    await expect(
      createAgentPatchedSessionModelRunGuard({
        ...scope,
        cfg: {},
        assertReadCurrent: () => controller.signal.throwIfAborted(),
      }),
    ).rejects.toBe(reason);
    expect(cancelledAtAdmission).toBe(true);
    expect(await warnings.findText("model rollback preparation unavailable")).toBeUndefined();
  });
});

it("warns when model rollback preparation fails, not when its marker is absent", async () => {
  const warnings = createWarnLogCapture("model-guard-read-failure");
  onTestFinished(() => warnings.cleanup());
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:model-guard-read-error",
    };
    replaceSessionEntrySync(scope, { sessionId: "model-guard-session", updatedAt: 1 });
    for (const sessionKey of [scope.sessionKey, "agent:main:model-guard-missing"]) {
      await createAgentPatchedSessionModelRunGuard({ ...scope, sessionKey, cfg: {} });
    }
    expect(await warnings.findText("model rollback preparation unavailable")).toBeUndefined();

    const failure = new Error("model marker read unavailable");
    probe.admission(workerAdmission, () => {
      throw failure;
    });
    const guard = await createAgentPatchedSessionModelRunGuard({
      ...scope,
      sessionKey: "agent:main:model-guard-unread",
      cfg: {},
    });
    expect(await warnings.findText("model rollback preparation unavailable")).toContain(
      failure.message,
    );
    expect(guard.captureFailure(new Error("model not found"), "model_not_found")).toBe(false);
    await guard.finish(false);
  });
});
