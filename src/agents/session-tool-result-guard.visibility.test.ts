import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { applyInputProvenanceToUserMessage } from "../sessions/input-provenance.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const listeners: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  for (const unsubscribe of listeners.splice(0)) {
    unsubscribe();
  }
  closeOpenClawAgentDatabasesForTest();
});

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-transcript-visibility-");
  const target = {
    agentId: "main",
    sessionId: "visibility-session",
    sessionKey: "agent:main:visibility-session",
    storePath: path.join(root, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  return { target, sessionManager: SessionManager.open(target, root) };
}

describe("guardSessionManager transcript visibility", () => {
  it.each([
    { label: "memory maintenance", trigger: "memory", inputProvenance: undefined, hidden: true },
    {
      label: "subagent coordination",
      trigger: "user",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceRole: "subagent",
      },
      hidden: true,
    },
    {
      label: "parent completion synthesis",
      trigger: "user",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceRole: "subagent",
      },
      hidden: false,
    },
  ] as const)(
    "preserves $label in model context with its display policy",
    async ({ trigger, inputProvenance, hidden }) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

      const { sessionManager: sm, target } = await openPersistedSessionManager();

      const guarded = guardSessionManager(sm, {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        trigger,
        inputProvenance,
      });
      guarded.appendMessage(makeUserMessage("Review the worker result", 1));
      guarded.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "read-result", name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 2,
        }),
      );
      guarded.appendMessage({
        role: "toolResult",
        toolCallId: "read-result",
        toolName: "read",
        content: [{ type: "text", text: "The regression is fixed" }],
        isError: false,
        timestamp: 3,
      });
      guarded.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "The repair passed validation" }],
          timestamp: 4,
        }),
      );

      const persisted = SessionManager.open(target).buildSessionContext().messages;
      expect(persisted).toMatchObject([
        { role: "user", content: "Review the worker result" },
        { role: "assistant", content: [{ type: "toolCall", id: "read-result" }] },
        { role: "toolResult", content: [{ type: "text", text: "The regression is fixed" }] },
        { role: "assistant", content: [{ type: "text", text: "The repair passed validation" }] },
      ]);
      expect(persisted.map((message) => Reflect.get(message, "display") === false)).toEqual(
        Array(4).fill(hidden),
      );
      expect(updates.length).toBeGreaterThan(0);
      expect(
        updates.every((update) => (Reflect.get(update.message!, "display") === false) === hidden),
      ).toBe(true);
    },
  );

  it("hides a steered child input without hiding parent answers across reused runs", async () => {
    const { sessionManager, target } = await openPersistedSessionManager();
    const childProvenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      sourceRole: "subagent" as const,
    };
    const parent = guardSessionManager(sessionManager, { runId: "human-run" });
    parent.appendMessage(
      applyInputProvenanceToUserMessage(
        makeUserMessage("Worker finished the reproduction", 1),
        childProvenance,
      ),
    );
    parent.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "I found the cause of your bug" }],
        timestamp: 2,
      }),
    );
    guardSessionManager(sessionManager, {
      runId: "coordination-run",
      inputProvenance: childProvenance,
    }).appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Report received" }],
        timestamp: 3,
      }),
    );
    guardSessionManager(sessionManager, {
      runId: "completion-run",
      inputProvenance: { ...childProvenance, sourceTool: "subagent_announce" },
    }).appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Your bug is fixed and tested" }],
        timestamp: 4,
      }),
    );

    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toHaveLength(4);
    expect(messages.map((message) => Reflect.get(message, "display") === false)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(messages[0]).toMatchObject({
      content: "Worker finished the reproduction",
      provenance: childProvenance,
    });
  });

  it("keeps the user-turn recorder attached when hiding memory maintenance", () => {
    const sm = SessionManager.inMemory();
    const markRuntimePersisted = vi.fn();
    const recorder = {
      markBlocked: vi.fn(),
      markRuntimePersisted,
    } as unknown as UserTurnTranscriptRecorder;
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: "Pre-compaction memory flush",
        timestamp: Date.now(),
      },
      {
        message: {
          role: "user",
          content: "Pre-compaction memory flush",
          timestamp: Date.now(),
        },
        recorder,
      },
    );
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:memory",
      trigger: "memory",
    });

    guarded.appendMessage(runtimeMessage as Parameters<typeof guarded.appendMessage>[0]);

    expect(markRuntimePersisted).toHaveBeenCalledTimes(1);
    expect(markRuntimePersisted.mock.calls[0]?.[0]).toMatchObject({
      display: false,
      role: "user",
    });
    expect(markRuntimePersisted.mock.calls[0]?.[2]).toEqual({ appended: true });
  });

  it("does not hide ordinary messages that mention memory flushes", () => {
    const sm = SessionManager.inMemory();
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:user",
      trigger: "user",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "user",
      content: "Why did the memory flush leak?",
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(persisted?.message).not.toHaveProperty("display", false);
  });
});
