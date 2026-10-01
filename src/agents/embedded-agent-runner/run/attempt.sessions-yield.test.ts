import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { UserMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";

const interruptType = "openclaw.sessions_yield_interrupt";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const user = {
  role: "user",
  content: [{ type: "text", text: "continue" }],
  timestamp: 1,
} satisfies UserMessage;

function interrupt(): AgentMessage {
  return {
    role: "custom",
    customType: interruptType,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: 3,
  };
}

function seed(sessionManager: SessionManager, assistantCount: number, includeInterrupt = true) {
  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 1,
  };
  const assistants = Array.from({ length: assistantCount }, (_, index) =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text: `assistant ${index}` }],
      stopReason: index === assistantCount - 1 ? "aborted" : "stop",
      timestamp: index + 2,
    }),
  );
  for (const entry of [toolResult, ...assistants]) {
    sessionManager.appendMessage(entry);
  }
  if (includeInterrupt) {
    sessionManager.appendCustomMessageEntry(interruptType, "[sessions_yield interrupt]", false);
  }
  return { toolResult, assistants };
}

function buildSession(messages: AgentMessage[], sessionManager: SessionManager) {
  return { messages, agent: { state: { messages: [...messages] } }, sessionManager };
}

async function persistentSession(label: string) {
  const dir = tempDirs.make(`openclaw-sessions-yield-${label}-`);
  const scope = {
    agentId: "main",
    sessionId: `sessions-yield-${label}`,
    sessionKey: `agent:main:sessions-yield-${label}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return { dir, scope, sessionManager: SessionManager.open(scope, dir) };
}

describe("stripSessionsYieldArtifacts", () => {
  it("leaves a continuable suffix unchanged", () => {
    const session = buildSession([user], SessionManager.inMemory());
    stripSessionsYieldArtifacts(session);
    expect(session.agent.state.messages).toEqual([user]);
  });

  it.each([false, true])(
    "caps persisted assistant removal independently of persisted interrupt=%s",
    (includeInterrupt) => {
      const sessionManager = SessionManager.inMemory();
      const { toolResult, assistants } = seed(sessionManager, 4, includeInterrupt);
      const session = buildSession(
        [toolResult, ...assistants.slice(-2), ...(includeInterrupt ? [] : [interrupt()])],
        sessionManager,
      );
      stripSessionsYieldArtifacts(session);
      expect(session.agent.state.messages).toEqual([toolResult]);
      const branch = sessionManager.getBranch();
      expect(
        branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
      ).toHaveLength(2);
      expect(
        branch.some(
          (entry) => entry.type === "custom_message" && entry.customType === interruptType,
        ),
      ).toBe(false);
    },
  );

  it("keeps live and durable histories unchanged when concurrent persistence wins", async () => {
    const { dir, scope, sessionManager } = await persistentSession("concurrent");
    const { toolResult, assistants } = seed(sessionManager, 1);
    const marker = interrupt();
    const session = buildSession([toolResult, ...assistants, marker], sessionManager);
    await appendTranscriptMessage(scope, { cwd: dir, eventId: "concurrent", message: user });
    expect(() => stripSessionsYieldArtifacts(session)).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(session.agent.state.messages).toEqual([toolResult, ...assistants, marker]);
    expect(SessionManager.open(scope, dir).buildSessionContext().messages).toMatchObject([
      toolResult,
      ...assistants,
      { role: "custom", customType: interruptType },
      user,
    ]);
  });

  it("keeps SQLite history and trailing metadata available after multi-turn yield cleanup", async () => {
    const { dir, scope, sessionManager } = await persistentSession("sqlite");
    const { toolResult, assistants } = seed(sessionManager, 3);
    sessionManager.appendCustomEntry("plugin-state", { enabled: true });
    const generationBefore = readSessionTranscriptWatermark(scope).generation;
    const session = buildSession([toolResult, ...assistants, interrupt()], sessionManager);
    stripSessionsYieldArtifacts(session);
    expect(session.agent.state.messages).toEqual([toolResult]);
    expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
    const reopened = SessionManager.open(scope, dir);
    expect(reopened.buildSessionContext().messages).toEqual([toolResult]);
    expect(reopened.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "plugin-state",
          data: { enabled: true },
        }),
      ]),
    );
    expect(await loadTranscriptEvents(scope)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "custom_message", customType: interruptType }),
      ]),
    );
  });
});
