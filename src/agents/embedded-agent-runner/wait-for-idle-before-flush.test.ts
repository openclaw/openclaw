import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it.each(["idle", "aborted", "retargeted", "empty"] as const)(
  "admits only pending tool-result cleanup behind the current database writer (%s)",
  async (scenario) => {
    const dir = tempDirs.make("openclaw-tool-flush-admission-");
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const target = {
      agentId: "main",
      sessionId: "pending-tool",
      sessionKey: "agent:main:pending-tool",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const replacement = {
      ...target,
      sessionId: "replacement",
      sessionKey: "agent:main:replacement",
    };
    await upsertSessionEntryCore(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
    const manager = guardSessionManager(SessionManager.open(target, dir));
    if (scenario !== "empty") {
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "pending-call", name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
    }
    const before = loadTranscriptEventsSync(target);
    const replacementBefore = loadTranscriptEventsSync(replacement);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const idle = createDeferredCore();
    const heldWriter = runOpenClawAgentWorkerWrite(
      toDatabaseOptions(resolveSqliteReadScope(target)),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let flush: Promise<void> | undefined;
    let settled = false;
    try {
      await entered.promise;
      flush = flushPendingToolResultsAfterIdle({
        agent: { waitForIdle: () => idle.promise },
        sessionManager: manager,
        ...(scenario === "idle" || scenario === "empty" ? {} : { timeoutMs: 0 }),
      });
      void flush.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      if (scenario === "empty") {
        await yieldToEventLoop();
        expect(settled).toBe(false);
      }
      idle.resolve();
      await yieldToEventLoop();
      expect(loadTranscriptEventsSync(target)).toEqual(before);
      expect(settled).toBe(scenario === "empty");
      if (scenario === "retargeted") {
        manager.setSessionTarget(replacement);
      }
      release.resolve();
      await heldWriter;
      if (scenario === "retargeted") {
        await expect(flush).rejects.toThrow("Session manager identity changed");
        expect(loadTranscriptEventsSync(target)).toEqual(before);
        expect(loadTranscriptEventsSync(replacement)).toEqual(replacementBefore);
      } else if (scenario === "empty") {
        await flush;
        expect(loadTranscriptEventsSync(target)).toEqual(before);
      } else {
        await flush;
        const after = loadTranscriptEventsSync(target);
        expect(after).toHaveLength(before.length + 1);
        expect(after.at(-1)).toMatchObject({
          type: "message",
          message: { role: "toolResult", toolCallId: "pending-call", isError: true },
        });
        await flushPendingToolResultsAfterIdle({
          agent: undefined,
          sessionManager: manager,
          timeoutMs: 0,
        });
        expect(loadTranscriptEventsSync(target)).toEqual(after);
      }
    } finally {
      idle.resolve();
      release.resolve();
      await Promise.allSettled([heldWriter, flush]);
    }
  },
);
