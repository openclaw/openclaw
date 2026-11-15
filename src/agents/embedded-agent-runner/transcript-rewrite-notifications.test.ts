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
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage as assistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { textToolResult } from "../test-helpers/sparse-transcript.test-support.js";
import { handleEmbeddedAttemptMidTurnPrecheck as precheck } from "./run/attempt-prompt-preflight.js";
import { createToolResultPromptProjectionState as createProjectionState } from "./session-prompt-state.js";
import {
  repairRejectedCompactionReplayInSessionManager as repairCompaction,
  repairRejectedThinkingReplayInSessionManager as repairThinking,
} from "./thinking-replay-repair.js";
import { truncateOversizedToolResultsInSessionManager as truncateSession } from "./tool-result-truncation.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

const context = new AsyncLocalStorage<string>();
function observe(scope?: Parameters<typeof loadTranscriptEventsSync>[0]) {
  const internal: Array<{
    update: InternalSessionTranscriptUpdate;
    context: string | undefined;
    committedEvents: ReturnType<typeof loadTranscriptEventsSync> | undefined;
  }> = [];
  const external: Array<{ update: SessionTranscriptUpdate; context: string | undefined }> = [];
  const stopInternal = onInternalSessionTranscriptUpdate((update) => {
    internal.push({
      update,
      context: context.getStore(),
      committedEvents: scope ? loadTranscriptEventsSync(scope) : undefined,
    });
  });
  const stopPublic = onSessionTranscriptUpdate((update) =>
    external.push({ update, context: context.getStore() }),
  );
  return {
    internal,
    external,
    [Symbol.dispose]() {
      stopInternal();
      stopPublic();
    },
  };
}
function toolResult() {
  return { ...textToolResult("call", "read", oversizedOutput), isError: false, timestamp: 2 };
}

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
      const assistant = assistantMessage({
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
        message: kind === "mid-turn preflight" ? toolResult() : assistant,
      });
      const manager = SessionManager.open(scope);
      const before = loadTranscriptEventsSync(scope);
      using observed = observe(scope);
      const { internal, external } = observed;
      // Caller labels can lag a rebound manager; only its persisted target owns the update.
      const caller = {
        sessionFile: "sqlite:other:old-session:/synthetic/old-store.json",
        sessionId: "old-session",
        sessionKey: "agent:other:old-session",
        agentId: "other",
      };
      const repair = async () => {
        const params = { sessionManager: manager, ...caller };
        if (kind !== "mid-turn preflight") {
          return (
            await (kind === "thinking"
              ? repairThinking(params)
              : repairCompaction({ ...params, checkpoint }))
          ).repaired;
        }
        const outcome = await precheck({
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
          toolResultPromptProjectionState: createProjectionState(),
          prePromptMessageCount: 2,
          replaceSessionMessages: () => {},
        });
        return (
          outcome.preflightRecovery.handled === true &&
          (outcome.preflightRecovery.truncatedCount ?? 0) > 0
        );
      };
      await context.run("caller-context", async () => {
        expect(await withSessionManagerWrite(manager, repair)).toBe(true);
        expect(context.getStore()).toBe("caller-context");
      });
      const { storePath: _storePath, ...publicTarget } = scope;
      expect(internal).toEqual([
        {
          update: { sessionFile: caller.sessionFile, target: scope, ...publicTarget },
          context: "caller-context",
          committedEvents: loadTranscriptEventsSync(scope),
        },
      ]);
      expect(internal[0]?.committedEvents?.length).toBeGreaterThan(before.length);
      await vi.waitFor(() => expect(external).toHaveLength(1));
      expect(external).toEqual([
        { update: { target: publicTarget, ...publicTarget }, context: "caller-context" },
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
    },
  );

  it.each(["file-only", "identity-only"])(
    "retains %s notifications without a manager target",
    async (kind) => {
      const fileOnly = kind === "file-only";
      const manager = SessionManager.inMemory();
      manager.appendMessage(
        fileOnly
          ? assistantMessage({ content: [{ type: "thinking", thinking: "stale" }] })
          : toolResult(),
      );
      const target = {
        agentId: "main",
        sessionId: "explicit",
        sessionKey: "agent:main:explicit",
        storePath: "/synthetic/explicit/sessions.json",
      };
      const legacy = {
        sessionFile: "/synthetic/legacy.jsonl",
        sessionKey: "agent:main:legacy",
        agentId: "main",
      };
      using observed = observe();
      if (fileOnly) {
        await expect(repairThinking({ sessionManager: manager, ...legacy })).resolves.toMatchObject(
          { repaired: true },
        );
      } else {
        await expect(
          truncateSession({ sessionManager: manager, contextWindowTokens: 1_000, ...target }),
        ).resolves.toMatchObject({ truncated: true });
      }
      const { storePath: _storePath, ...identity } = target;
      expect(observed.internal.map(({ update }) => update)).toEqual([
        fileOnly ? legacy : { target, ...identity },
      ]);
      expect(observed.external).toHaveLength(fileOnly ? 0 : 1);
    },
  );
});
