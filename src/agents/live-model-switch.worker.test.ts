import path from "node:path";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import { buildSessionTranscriptTurnExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import { promptReport } from "../config/sessions/system-prompt-report.test-support.js";
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

function modelGuardFixture() {
  const warnings = createWarnLogCapture("model-guard-read");
  onTestFinished(() => warnings.cleanup());
  const scope = {
    agentId: "main",
    storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
    sessionKey: "agent:main:model-guard",
  };
  replaceSessionEntrySync(scope, { sessionId: "model-guard-session", updatedAt: 1 });
  return { scope, warnings };
}

describe("live model switch worker persistence", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-model-switch-worker-");
  const selection = { provider: "openai", model: "gpt-5.4" };
  const initialSelection = {
    sessionId: "model-switch",
    updatedAt: 1,
    liveModelSwitchPending: true,
    providerOverride: selection.provider,
    modelOverride: selection.model,
  };
  function fixture() {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    return {
      scope: { storePath, sessionKey: "agent:main:model-switch" },
      params: {
        cfg: { session: { store: storePath } },
        agentId: "main",
        sessionKey: "agent:main:model-switch",
        defaultProvider: selection.provider,
        defaultModel: selection.model,
        providerUsed: selection.provider,
        modelUsed: selection.model,
      },
    };
  }

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
      return actor.completeTurn(
        {
          commandId,
          phaseId: "completion",
          expected: snapshot.version,
          bookkeeping: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision ?? null,
            writerRunId: entry.activeWriterRunId,
            expectedState: buildSessionTranscriptTurnExpectedState(entry),
          },
          reducers: [reducer],
        },
        authority,
      );
    });
  }

  it.each(["clear", "complete"] as const)(
    "%s consumes only the applied selection",
    async (operation) => {
      const { scope, params } = fixture();
      const initial = {
        ...initialSelection,
        label: "keep this label",
        skillsSnapshot: { prompt: "synthetic skill instructions".repeat(1200), skills: [] },
        systemPromptReport: promptReport(1, 1, 0),
        sessionDiffBaseline: {
          version: 1 as const,
          sessionId: initialSelection.sessionId,
          root: "/synthetic",
          files: [],
        },
      };
      await replaceSessionEntry(scope, initial);
      const apply = async () => {
        if (operation === "clear") {
          await clearLiveModelSwitchPending({
            ...params,
            expectedSelection: selection,
          });
          return;
        }
        await completeSelection(scope, "complete-selection", (entry) =>
          prepareLiveModelSwitchAfterRun({
            ...params,
            entry,
          }),
        );
      };
      await apply();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: initial.sessionId,
        label: initial.label,
        modelOverride: initial.modelOverride,
      });
      expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();
      expect(
        await shouldSwitchToLiveModel({
          ...params,
          currentProvider: selection.provider,
          currentModel: "gpt-5.5",
        }),
      ).toBeUndefined();

      const withoutPendingSwitch = loadSessionEntry(scope);
      await apply();
      expect(loadSessionEntry(scope)).toEqual(withoutPendingSwitch);

      await replaceSessionEntry(scope, { ...initial, modelOverride: "gpt-5.5" });
      await apply();
      expect(loadSessionEntry(scope)).toMatchObject({
        liveModelSwitchPending: true,
        modelOverride: "gpt-5.5",
      });
      const reads = observeHostDataSql();
      using _ = { [Symbol.dispose]: reads.restore };
      const transported = vi.spyOn(entryReads, "readSessionEntryReadOnlyInWorker");
      expect(
        await shouldSwitchToLiveModel({
          ...params,
          currentProvider: selection.provider,
          currentModel: selection.model,
        }),
      ).toMatchObject({ provider: "openai", model: "gpt-5.5" });
      expect(transported).toHaveBeenCalledOnce();
      const entry = await transported.mock.results[0]?.value;
      expect(entry).not.toHaveProperty("skillsSnapshot");
      expect(entry).not.toHaveProperty("systemPromptReport");
      expect(entry).not.toHaveProperty("sessionDiffBaseline");
      expect(
        reads.queries.filter((sql) =>
          /session_nodes|session_entry_snapshots|session_participants|session_windows/i.test(sql),
        ),
      ).toEqual([]);
      reads.restore();
      expect(loadSessionEntry(scope)?.skillsSnapshot).toEqual(initial.skillsSnapshot);
    },
  );

  it("keeps newer selections when a prepared terminal reducer reaches the actor", async () => {
    const { scope, params } = fixture();
    const initial = {
      ...initialSelection,
      agentRuntimeOverride: "openclaw",
      authProfileOverride: "profile-a",
      authProfileOverrideSource: "user" as const,
    };
    const reducer = prepareLiveModelSwitchAfterRun({
      ...params,
      entry: initial,
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
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, warnings } = modelGuardFixture();
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
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, warnings } = modelGuardFixture();
    const prepare = (sessionKey: string) =>
      createAgentPatchedSessionModelRunGuard({ ...scope, sessionKey, cfg: {} });
    for (const sessionKey of [scope.sessionKey, "agent:main:model-guard-missing"]) {
      await prepare(sessionKey);
    }
    expect(await warnings.findText("model rollback preparation unavailable")).toBeUndefined();

    const failure = new Error("model marker read unavailable");
    probe.admission(workerAdmission, () => {
      throw failure;
    });
    const guard = await prepare("agent:main:model-guard-unread");
    expect(await warnings.findText("model rollback preparation unavailable")).toContain(
      failure.message,
    );
    expect(guard.captureFailure(new Error("model not found"), "model_not_found")).toBe(false);
    await guard.finish(false);
  });
});
