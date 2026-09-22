import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { handleEmbeddedAttemptMidTurnPrecheck } from "./run/attempt-prompt-preflight.js";
import { createToolResultPromptProjectionState } from "./session-prompt-state.js";
import {
  repairRejectedCompactionReplayInSessionManager,
  repairRejectedThinkingReplayInSessionManager,
} from "./thinking-replay-repair.js";
import { truncateOversizedToolResultsInSessionManager } from "./tool-result-truncation.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

const checkpoint = { data: "rejected-checkpoint", id: "cmp_rejected" };
const oversizedOutput = "synthetic oversized tool output ".repeat(3_000);

describe("committed transcript rewrite notifications", () => {
  it.each(["thinking", "compaction", "mid-turn preflight"] as const)(
    "publishes the SQLite manager owner exactly once after %s repair",
    async (kind) => {
      const scope = {
        agentId: "main",
        sessionId: "notification-owner",
        sessionKey: "agent:main:notification-owner",
        storePath: join(tempDirs.make("openclaw-rewrite-notification-"), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "synthetic question", timestamp: 1 },
      });
      const assistant = makeAgentAssistantMessage({
        content:
          kind === "thinking"
            ? [
                { type: "thinking", thinking: "stale reasoning", thinkingSignature: "rejected" },
                { type: "text", text: "visible answer" },
              ]
            : [{ type: "text", text: "visible answer" }],
      });
      if (kind === "compaction") {
        assistant.providerReplay = {
          v: 1,
          type: "openai-responses-compaction",
          ...checkpoint,
          replayIndex: 0,
          provider: assistant.provider,
          api: assistant.api,
          model: assistant.model,
          baseUrlHash: "ozhevd1smnk8s",
        };
      }
      await appendTranscriptMessage(scope, {
        message:
          kind === "mid-turn preflight"
            ? {
                role: "toolResult",
                toolCallId: "synthetic-call",
                toolName: "read",
                content: [{ type: "text", text: oversizedOutput }],
                isError: false,
                timestamp: 2,
              }
            : assistant,
      });
      const manager = SessionManager.open(scope);
      const before = loadTranscriptEventsSync(scope);
      const context = new AsyncLocalStorage<string>();
      const internal: Array<{
        update: InternalSessionTranscriptUpdate;
        context: string | undefined;
        committedEvents: ReturnType<typeof loadTranscriptEventsSync>;
      }> = [];
      const external: Array<{ update: SessionTranscriptUpdate; context: string | undefined }> = [];
      const stopInternal = onInternalSessionTranscriptUpdate((update) => {
        internal.push({
          update,
          context: context.getStore(),
          committedEvents: loadTranscriptEventsSync(scope),
        });
      });
      const stopPublic = onSessionTranscriptUpdate((update) => {
        external.push({ update, context: context.getStore() });
      });
      // Caller labels can lag a rebound manager; only its persisted target owns the update.
      const caller = {
        sessionFile: "sqlite:other:old-session:/synthetic/old-store.json",
        sessionId: "old-session",
        sessionKey: "agent:other:old-session",
        agentId: "other",
      };
      const repair = () => {
        if (kind === "thinking") {
          return repairRejectedThinkingReplayInSessionManager({
            sessionManager: manager,
            ...caller,
          }).repaired;
        }
        if (kind === "compaction") {
          return repairRejectedCompactionReplayInSessionManager({
            sessionManager: manager,
            ...caller,
            checkpoint,
          }).repaired;
        }
        const outcome = handleEmbeddedAttemptMidTurnPrecheck({
          attempt: { ...caller, provider: "openai", modelId: "gpt-5.5", contextTokenBudget: 1_000 },
          request: {
            route: "truncate_tool_results_only",
            estimatedPromptTokens: 20_000,
            promptBudgetBeforeReserve: 900,
            overflowTokens: 19_100,
            toolResultReducibleChars: oversizedOutput.length,
            effectiveReserveTokens: 100,
          },
          sessionAgentId: caller.agentId,
          sessionManager: manager,
          toolResultPromptProjectionState: createToolResultPromptProjectionState(),
          prePromptMessageCount: 2,
          replaceSessionMessages: () => {},
        });
        return (
          outcome.preflightRecovery.handled === true &&
          (outcome.preflightRecovery.truncatedCount ?? 0) > 0
        );
      };
      try {
        await context.run("caller-context", async () => {
          expect(await withSessionManagerWrite(manager, repair)).toBe(true);
          expect(context.getStore()).toBe("caller-context");
        });
        expect(internal).toHaveLength(1);
        expect(internal[0]?.update).toEqual({
          sessionFile: caller.sessionFile,
          target: scope,
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        });
        expect(internal[0]?.context).toBe("caller-context");
        expect(internal[0]?.committedEvents.length).toBeGreaterThan(before.length);
        expect(internal[0]?.committedEvents).toEqual(loadTranscriptEventsSync(scope));
        await vi.waitFor(() => expect(external).toHaveLength(1));
        const { storePath: _storePath, ...publicTarget } = scope;
        expect(external).toEqual([
          {
            update: { target: publicTarget, ...publicTarget },
            context: "caller-context",
          },
        ]);
        const messages = SessionManager.open(scope).buildSessionContext().messages;
        if (kind === "thinking") {
          expect(messages.at(-1)).toMatchObject({
            content: [{ type: "text", text: "visible answer" }],
          });
        } else if (kind === "compaction") {
          expect(messages.at(-1)).not.toHaveProperty("providerReplay");
        } else {
          expect(JSON.stringify(messages)).not.toContain(oversizedOutput);
        }
        expect(await withSessionManagerWrite(manager, repair)).toBe(false);
        expect(internal).toHaveLength(1);
        expect(external).toHaveLength(1);
      } finally {
        stopInternal();
        stopPublic();
      }
    },
  );

  it("retains a file-only replay notification without a persisted manager target", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(
      makeAgentAssistantMessage({ content: [{ type: "thinking", thinking: "stale" }] }),
    );
    const internal = vi.fn();
    const external = vi.fn();
    const stopInternal = onInternalSessionTranscriptUpdate(internal);
    const stopPublic = onSessionTranscriptUpdate(external);
    try {
      expect(
        repairRejectedThinkingReplayInSessionManager({
          sessionManager: manager,
          sessionFile: "/synthetic/legacy.jsonl",
          sessionKey: "agent:main:legacy",
          agentId: "main",
        }).repaired,
      ).toBe(true);
      expect(internal).toHaveBeenCalledExactlyOnceWith({
        sessionFile: "/synthetic/legacy.jsonl",
        sessionKey: "agent:main:legacy",
        agentId: "main",
      });
      expect(external).not.toHaveBeenCalled();
    } finally {
      stopInternal();
      stopPublic();
    }
  });

  it("retains explicit identity-only truncation notification without a manager target", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: oversizedOutput }],
      isError: false,
      timestamp: 1,
    });
    const target = {
      agentId: "main",
      sessionId: "explicit",
      sessionKey: "agent:main:explicit",
      storePath: "/synthetic/explicit/sessions.json",
    };
    const internal = vi.fn();
    const external = vi.fn();
    const stopInternal = onInternalSessionTranscriptUpdate(internal);
    const stopPublic = onSessionTranscriptUpdate(external);
    try {
      expect(
        truncateOversizedToolResultsInSessionManager({
          sessionManager: manager,
          contextWindowTokens: 1_000,
          ...target,
        }).truncated,
      ).toBe(true);
      expect(internal).toHaveBeenCalledExactlyOnceWith({
        target,
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
      });
      expect(external).toHaveBeenCalledTimes(1);
    } finally {
      stopInternal();
      stopPublic();
    }
  });
});
