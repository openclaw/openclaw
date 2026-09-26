import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
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
import {
  recordOpenClawDatabaseQuarantine,
  clearOpenClawDatabaseQuarantine,
} from "../../state/openclaw-quarantine-store.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistApprovedCliUserTurnTranscript } from "./cli-run-transcript.js";
import {
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

it("leaves cold CLI history absent until the approved user-turn writer creates it", async () => {
  await withOpenClawTestState({ label: "cli-cold-history" }, async ({ stateDir }) => {
    const target = {
      agentId: "main",
      sessionId: "cold-cli",
      sessionKey: "agent:main:cold-cli",
      storePath: path.join(stateDir, "agents", "main", "openclaw-agent.sqlite"),
    };
    const params = { sessionTarget: target };
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
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...target, sessionEntry: undefined },
      input: { text, timestamp: 17 },
      updateMode: "none",
    });
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
    expect(await loadCliSessionContextEngineMessages(params)).toMatchObject([
      { role: "user", content: text },
    ]);
    const before = loadTranscriptEventsSync(target);
    await loadCliSessionPromptContext(params);
    expect(loadTranscriptEventsSync(target)).toEqual(before);
  });
});

it.each(["schema", "table", "owner"] as const)(
  "does not hide missing %s storage as empty history",
  async (kind) => {
    await withOpenClawTestState({ label: `cli-history-${kind}` }, async ({ stateDir }) => {
      const target = targetIn(stateDir);
      if (kind === "schema") {
        fs.mkdirSync(path.dirname(target.storePath), { recursive: true });
        new DatabaseSync(target.storePath).close();
      } else {
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        if (kind === "table") {
          openOpenClawAgentDatabase({ agentId: "main", path: target.storePath }).db.exec(
            "DROP TABLE transcript_events",
          );
        }
        if (kind === "owner") {
          openOpenClawAgentDatabase({ agentId: "main", path: target.storePath }).db.exec(
            "UPDATE schema_meta SET agent_id = 'different' WHERE meta_key = 'primary'",
          );
        }
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
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
          const spy = vi.spyOn(historyLane.pool, "run").mockImplementationOnce((input, options) => {
            spy.mockRestore();
            let pause = false;
            return historyLane.pool
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

it("refuses quarantined runtime history through both async manager entries and CLI", async () => {
  await withOpenClawTestState({ label: "cli-history-quarantine" }, async (state) => {
    const target = targetIn(state.stateDir);
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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
        reason: "synthetic quarantine",
      }),
    ).toBe(true);
    try {
      for (const read of [
        () => SessionManager.openAsync(target),
        () => SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 }),
        () => loadCliSessionContextEngineMessages({ sessionTarget: target }),
      ]) {
        await expect(read()).rejects.toThrow("synthetic quarantine");
      }
    } finally {
      clearOpenClawDatabaseQuarantine(target.storePath, { env: state.env });
    }
  });
});

it("refuses an admitted transcript whose database disappeared", async () => {
  await withOpenClawTestState({ label: "cli-history-admitted-missing" }, async ({ stateDir }) => {
    const target = targetIn(stateDir);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...target, sessionEntry: undefined },
      input: { text: "admitted", timestamp: 1 },
      updateMode: "none",
    });
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
        const recorder = createUserTurnTranscriptRecorder({
          target: { ...target, sessionEntry: undefined },
          input: { text, timestamp: 1 },
          updateMode: "none",
        });
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

it("refuses process-local quarantine even when no persisted quarantine row exists", async () => {
  await withOpenClawTestState({ label: "cli-history-terminal-quarantine" }, async (state) => {
    const target = targetIn(state.stateDir);
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const failure = new Error("synthetic process-local quarantine");
    expect(recordOpenClawAgentDatabaseOpenFailure(target.storePath, failure)).toBe(true);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    try {
      await expect(
        SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 }),
      ).rejects.toThrow(failure.message);
      await expect(loadCliSessionContextEngineMessages({ sessionTarget: target })).rejects.toThrow(
        failure.message,
      );
    } finally {
      clearOpenClawAgentDatabaseOpenFailure(target.storePath, { env: state.env });
    }
  });
});

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
