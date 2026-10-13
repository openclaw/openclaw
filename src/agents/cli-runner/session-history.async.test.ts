import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendTranscriptMessageSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { targetDiscoveryLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import {
  recordOpenClawDatabaseQuarantine,
  clearOpenClawDatabaseQuarantine,
} from "../../state/openclaw-quarantine-store.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistApprovedCliUserTurnTranscript } from "./cli-run-transcript.js";
import {
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionPromptContext,
} from "./session-history.js";

function targetIn(stateDir: string) {
  return {
    agentId: "main",
    sessionId: "cold-cli",
    sessionKey: "agent:main:cold-cli",
    storePath: path.join(stateDir, "agents", "main", "openclaw-agent.sqlite"),
  };
}

function createRecorder(target: ReturnType<typeof targetIn>, text: string, timestamp = 1) {
  return createUserTurnTranscriptRecorder({
    target: { ...target, sessionEntry: undefined },
    input: { text, timestamp },
    updateMode: "none",
  });
}

it("reads CLI presence after an earlier admitted transcript write settles", async ({ signal }) => {
  await withOpenClawTestState({ label: "cli-presence-admission" }, async ({ stateDir }) => {
    const target = targetIn(stateDir);
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const queued = createDeferredCore();
    const admit = agentWriteAdmission.runOpenClawAgentWriteAdmission;
    const writing = admit({ agentId: target.agentId, path: target.storePath }, async () => {
      entered.resolve();
      await withinTest(resume.promise, signal);
      const appended = appendTranscriptMessageSync(target, {
        eventId: "earlier-admitted-user-turn",
        parentId: null,
        message: { role: "user", content: "Earlier admitted user turn" },
      });
      expect(appended.ok).toBe(true);
    });
    let reading: Promise<boolean> | undefined;
    let restore = () => {};
    try {
      await withinTest(entered.promise, signal);
      const admission = vi
        .spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation((...args) => {
          const pending = admit(...args);
          queued.resolve();
          return pending;
        });
      restore = () => admission.mockRestore();
      reading = hasCliSessionTranscript({ sessionTarget: target });
      await withinTest(
        awaitGateBeforeSettlement(
          queued.promise,
          reading,
          "CLI presence bypassed the earlier admitted writer",
        ),
        signal,
      );
      restore();
      resume.resolve();
      await withinTest(writing, signal);
      await expect(reading).resolves.toBe(true);
    } finally {
      restore();
      resume.resolve();
      await Promise.allSettled([reading, writing]);
    }
  });
});

it("leaves cold CLI history absent until the approved user-turn writer creates it", async () => {
  await withOpenClawTestState({ label: "cli-cold-history" }, async ({ stateDir }) => {
    const target = targetIn(stateDir);
    const params = { sessionTarget: target };
    const absentSql = observeHostDataSql();
    try {
      await expect(hasCliSessionTranscript(params)).resolves.toBe(false);
      expect(absentSql.queries).toEqual([]);
    } finally {
      absentSql.restore();
    }
    expect(await loadCliSessionContextEngineMessages(params)).toEqual([]);
    expect(
      await loadCliSessionPromptContext({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: "missing-transcript",
      }),
    ).toEqual({ reseedMessages: [], durableContext: undefined });
    expect(fs.existsSync(resolveSessionTranscriptDatabasePath(target))).toBe(false);
    const text = "Exact user bytes:  spaced\nsecond line 🦞";
    const recorder = createRecorder(target, text, 17);
    expect(
      await persistApprovedCliUserTurnTranscript({
        ...target,
        ...params,
        sessionFile: `sqlite://agents/main/${target.sessionId}`,
        workspaceDir: stateDir,
        prompt: text,
        provider: "claude-cli",
        runId: "cold-cli-run",
        timeoutMs: 1000,
        userTurnTranscriptRecorder: recorder,
      }),
    ).toBe(true);
    const presentSql = observeHostDataSql();
    try {
      await expect(hasCliSessionTranscript(params)).resolves.toBe(true);
      expect(presentSql.queries).toEqual([]);
    } finally {
      presentSql.restore();
    }
    expect(await loadCliSessionContextEngineMessages(params)).toMatchObject([
      { role: "user", content: text },
    ]);
    const before = loadTranscriptEventsSync(target);
    await loadCliSessionPromptContext(params);
    expect(loadTranscriptEventsSync(target)).toEqual(before);
  });
});

it.each(["schema", "owner"] as const)(
  "does not hide missing %s storage as empty history",
  async (kind) => {
    await withOpenClawTestState({ label: `cli-history-${kind}` }, async ({ stateDir }) => {
      const target = targetIn(stateDir);
      if (kind === "schema") {
        fs.mkdirSync(path.dirname(target.storePath), { recursive: true });
        new DatabaseSync(target.storePath).close();
      } else {
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        fs.renameSync(target.storePath, `${target.storePath}.template`);
        fs.copyFileSync(
          `${target.storePath}.template`,
          target.storePath,
          fs.constants.COPYFILE_EXCL,
        );
        const database = new DatabaseSync(target.storePath);
        database.exec("UPDATE schema_meta SET agent_id = 'different' WHERE meta_key = 'primary'");
        database.close();
      }
      await expect(
        loadCliSessionContextEngineMessages({ sessionTarget: target }),
      ).rejects.toThrow();
    });
  },
);

it.each(["run", "read-resource"] as const)(
  "does not publish absence after the %s owner is revoked",
  async (kind) => {
    await withOpenClawTestState({ label: `cli-history-revoked-${kind}` }, async ({ stateDir }) => {
      const target = targetIn(stateDir);
      const received = createDeferredCore();
      const release = createDeferredCore();
      let active = true;
      let restoreSpy = () => {};
      let pausedKind: unknown;
      const pauseReply = async <Reply>(reply: Reply) => {
        received.resolve();
        await release.promise;
        return reply;
      };
      const interceptNext = () => {
        if (kind === "read-resource") {
          const spy = vi
            .spyOn(targetDiscoveryLane.pool, "run")
            .mockImplementationOnce((input, options) => {
              spy.mockRestore();
              let pause = false;
              return targetDiscoveryLane.pool
                .run(async () => {
                  const request = typeof input === "function" ? await input() : input;
                  pause = request.kind === "transcript-hydration";
                  if (pause) {
                    pausedKind = request.kind;
                  } else {
                    interceptNext();
                  }
                  return request;
                }, options)
                .then((reply) => (pause ? pauseReply(reply) : reply));
            });
          restoreSpy = () => spy.mockRestore();
          return;
        }
        const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(function (
          this: WorkerTaskPool<unknown, unknown>,
          input,
          options,
        ) {
          spy.mockRestore();
          return this.run(async () => {
            const request = typeof input === "function" ? await input() : input;
            const requestKind =
              request && typeof request === "object" && "kind" in request
                ? request.kind
                : undefined;
            pausedKind = requestKind;
            return request;
          }, options).then(pauseReply);
        });
        restoreSpy = () => spy.mockRestore();
      };
      interceptNext();
      const pending = withSessionTranscriptWriteAssertion(
        target,
        () => {
          if (!active) {
            throw new Error("CLI history run revoked");
          }
        },
        () => loadCliSessionContextEngineMessages({ sessionTarget: target }),
      );
      const refused = expect(pending).rejects.toThrow("revoked");
      try {
        await Promise.race([
          received.promise,
          refused.then(() => {
            throw new Error("CLI history settled before the intercepted reply");
          }),
        ]);
        expect(pausedKind).toBe(kind === "run" ? "sqlite-target" : "transcript-hydration");
        if (kind === "run") {
          active = false;
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        }
        release.resolve();
        await refused;
        expect(fs.existsSync(target.storePath)).toBe(false);
      } finally {
        release.resolve();
        restoreSpy();
        await Promise.allSettled([pending]);
      }
    });
  },
);

it.each(["persisted", "process-local"] as const)(
  "refuses %s quarantine through async manager entries and CLI",
  async (kind) => {
    await withOpenClawTestState({ label: `cli-history-quarantine-${kind}` }, async (state) => {
      const target = targetIn(state.stateDir);
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const reason = "synthetic quarantine";
      if (kind === "persisted") {
        SessionManager.open(target).appendMessage({
          role: "user",
          content: "retained bytes",
          timestamp: 1,
        });
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        expect(
          recordOpenClawDatabaseQuarantine({
            env: state.env,
            kind: "agent",
            path: target.storePath,
            reason,
          }),
        ).toBe(true);
      } else {
        expect(recordOpenClawAgentDatabaseOpenFailure(target.storePath, new Error(reason))).toBe(
          true,
        );
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      }
      try {
        const readers = [
          () => SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 }),
          () => loadCliSessionContextEngineMessages({ sessionTarget: target }),
        ];
        if (kind === "persisted") {
          await expect(SessionManager.openAsync(target)).rejects.toThrow(reason);
        }
        for (const read of readers) {
          await expect(read()).rejects.toThrow(reason);
        }
      } finally {
        if (kind === "persisted") {
          clearOpenClawDatabaseQuarantine(target.storePath, { env: state.env });
        } else {
          clearOpenClawAgentDatabaseOpenFailure(target.storePath, { env: state.env });
        }
      }
    });
  },
);

it("refuses an admitted transcript whose database disappeared", async () => {
  await withOpenClawTestState({ label: "cli-history-admitted-missing" }, async ({ stateDir }) => {
    const target = targetIn(stateDir);
    const recorder = createRecorder(target, "admitted");
    await recorder.persistApproved();
    const receipt = recorder.getAdmissionReceipt();
    expect(receipt).toBeDefined();
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    fs.renameSync(target.storePath, `${target.storePath}.held`);
    await expect(
      runWithSessionTranscriptReadFence(receipt, () =>
        loadCliSessionContextEngineMessages({ sessionTarget: target }),
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(target.storePath)).toBe(false);
  });
});

it.each(["main", "worker"] as const)(
  "hydrates the cold CLI branch for logical %s with fenced history and opaque bytes intact",
  async (logicalAgent) => {
    await withOpenClawTestState({ label: "cli-history-cold-payload" }, async (state) => {
      const target = {
        ...targetIn(state.stateDir),
        agentId: logicalAgent,
        sessionKey: `agent:${logicalAgent}:cold-cli`,
        ...(logicalAgent === "worker" ? { storePath: path.join(state.root, "shared.sqlite") } : {}),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const persist = async (text: string) => {
        const recorder = createRecorder(target, text);
        await recorder.persistApproved();
        return recorder;
      };
      await persist("earlier");
      await appendTranscriptEvent(target, {
        type: "future-metadata",
        id: "opaque-row",
        parentId: null,
        future: "exact opaque payload",
      });
      await persist("retained");
      const admitted = (await persist("current turn")).getAdmissionReceipt();
      if (!admitted) {
        throw new Error("Expected persisted admission receipt");
      }
      await persist("later turn");
      const raw = () =>
        openOpenClawAgentDatabase({ agentId: "main", path: target.storePath })
          .db.prepare("SELECT event_json FROM transcript_events ORDER BY seq")
          .all();
      const original = raw();
      expect(original.some((row) => String(row.event_json).includes("exact opaque payload"))).toBe(
        true,
      );
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      const sql = observeHostDataSql();
      try {
        const history = await runWithSessionTranscriptReadFence(admitted, () =>
          loadCliSessionContextEngineMessages({ sessionTarget: target }),
        );
        expect(history).toContainEqual(
          expect.objectContaining({ role: "user", content: "retained" }),
        );
        expect(JSON.stringify(history)).not.toContain("current turn");
        expect(JSON.stringify(history)).not.toContain("later turn");
        const prepared = sql.calls[0]!.mock.calls.map((call) => String(call[0]));
        // Restoration still checks metadata locally; transcript payload hydration belongs to the worker.
        expect(prepared.some((statement) => statement.includes("event_json"))).toBe(false);
      } finally {
        sql.restore();
      }
      expect(raw()).toEqual(original);
    });
  },
);

it.each(["full", "bounded", "cli"] as const)(
  "preserves required-table unavailability and its SQLite cause through the %s worker caller",
  async (entry) => {
    await withOpenClawTestState({ label: `cli-history-typed-${entry}` }, async (state) => {
      const target = targetIn(state.stateDir);
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      openOpenClawAgentDatabase({ agentId: "main", path: target.storePath }).db.exec(
        "DROP TABLE transcript_events",
      );
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      const read =
        entry === "full"
          ? SessionManager.openAsync(target)
          : entry === "bounded"
            ? SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 })
            : loadCliSessionContextEngineMessages({ sessionTarget: target });
      const failure: unknown = await read.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionMetadataUnavailableError);
      expect(failure).toMatchObject({
        reason: "table-missing",
        missingTables: expect.arrayContaining(["transcript_events"]),
        cause: { code: "ERR_SQLITE_ERROR", errcode: 1 },
      });
    });
  },
);
