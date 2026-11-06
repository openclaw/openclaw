import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

const tempDirs = useSessionStoreTempDirs(afterEach, "openclaw-tool-flush-admission-");
afterEach(() => vi.unstubAllEnvs());

async function createTarget(dir: string, sessionId: string) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
}

it.each(["retargeted", "empty", "cancel-during-idle", "cancel-during-write"] as const)(
  "admits only pending tool-result cleanup behind the current database writer (%s)",
  async (scenario) => {
    const dir = tempDirs.make();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const target = await createTarget(dir, "pending-tool");
    const replacement = await createTarget(dir, "replacement");
    const manager = guardSessionManager(await SessionManager.openAsync(target, dir));
    if (scenario !== "empty") {
      await manager.appendMessageAsync(
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
    const cancellation = new AbortController();
    const heldWriter = runOpenClawAgentWorkerWrite(
      toDatabaseOptions(resolveSqliteReadScope(target)),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let flush: Promise<void> | undefined;
    const settled = vi.fn();
    try {
      await entered.promise;
      flush = flushPendingToolResultsAfterIdle({
        agent: { waitForIdle: () => idle.promise },
        sessionManager: manager,
        abortSignal: cancellation.signal,
        ...(scenario === "retargeted" ? { timeoutMs: 0 } : {}),
      });
      void flush.then(settled, settled);
      if (scenario === "empty") {
        await yieldToEventLoop();
        expect(settled).not.toHaveBeenCalled();
      }
      if (scenario === "cancel-during-idle") {
        cancellation.abort();
      } else {
        idle.resolve();
      }
      await yieldToEventLoop();
      if (scenario === "cancel-during-write") {
        cancellation.abort();
        await yieldToEventLoop();
      }
      expect(loadTranscriptEventsSync(target)).toEqual(before);
      expect(settled).toHaveBeenCalledTimes(scenario === "empty" ? 1 : 0);
      if (scenario === "retargeted") {
        manager.setSessionTarget(replacement);
      }
      release.resolve();
      await heldWriter;
      if (scenario === "retargeted") {
        await expect(flush).rejects.toThrow("Session manager identity changed");
      } else {
        await flush;
      }
      if (scenario === "retargeted" || scenario === "empty") {
        expect(loadTranscriptEventsSync(target)).toEqual(before);
        expect(loadTranscriptEventsSync(replacement)).toEqual(replacementBefore);
      } else {
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
