import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  findTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistAcpTurnTranscript, persistCliTurnTranscript } from "./transcript-persistence.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-coordination-fallback-");

it.each(["CLI", "ACP"] as const)(
  "keeps the %s coordination fallback hidden after runtime persistence is unavailable",
  async (runtime) => {
    const cwd = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: `coordination-fallback-${runtime.toLowerCase()}`,
      sessionKey: `agent:main:coordination-fallback-${runtime.toLowerCase()}`,
      storePath: path.join(cwd, "openclaw-agent.sqlite"),
    };
    const sessionEntry = { sessionId: target.sessionId, updatedAt: Date.now() };
    await upsertSessionEntryCore(target, sessionEntry);
    const common = {
      ...target,
      body: "Review the worker result",
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool: "sessions_send",
        sourceRole: "subagent" as const,
      },
      sessionEntry,
      sessionStore: { [target.sessionKey]: sessionEntry },
      sessionAgentId: "main",
      sessionCwd: cwd,
      config: {},
    };
    if (runtime === "CLI") {
      await persistCliTurnTranscript({
        ...common,
        result: { payloads: [{ text: "Report received" }], meta: { durationMs: 0 } },
        skipUserTurn: true,
      });
    } else {
      await persistAcpTurnTranscript({
        ...common,
        finalText: "Report received",
        terminalOutcome: { reason: "completed", status: "ok" },
        prepareAssistantTranscriptMessage: (message) => ({ ...message, display: true }),
      });
    }
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toHaveLength(runtime === "CLI" ? 1 : 2);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Report received" }],
    });
    expect(messages.every((message) => Reflect.get(message, "display") === false)).toBe(true);
  },
);

it.each(["CLI", "ACP"] as const)(
  "recovers the complete %s answer for its run after a later turn",
  async (runtime) => {
    const cwd = sessionDirs.make();
    const runId = `run-${runtime.toLowerCase()}-final`;
    const target = {
      agentId: "main",
      sessionId: `run-owned-final-${runtime.toLowerCase()}`,
      sessionKey: `agent:main:subagent:run-owned-final-${runtime.toLowerCase()}`,
      storePath: path.join(cwd, "openclaw-agent.sqlite"),
    };
    const sessionEntry = { sessionId: target.sessionId, updatedAt: Date.now() };
    await upsertSessionEntryCore(target, sessionEntry);
    const finalText = `${"line of the child report\n".repeat(400)}END-MARKER`;
    const common = {
      ...target,
      body: "Write the report",
      sessionEntry,
      sessionStore: { [target.sessionKey]: sessionEntry },
      sessionAgentId: "main",
      sessionCwd: cwd,
      config: {},
    };
    for (const turn of [
      { runId, finalText },
      { runId: `${runId}-later`, finalText: "A different turn's answer" },
    ]) {
      if (runtime === "CLI") {
        await persistCliTurnTranscript({
          ...common,
          runId: turn.runId,
          result: { payloads: [{ text: turn.finalText }], meta: { durationMs: 0 } },
        });
      } else {
        await persistAcpTurnTranscript({
          ...common,
          ...turn,
          terminalOutcome: { reason: "completed", status: "ok" },
        });
      }
    }
    const found = await findTranscriptEvent(target, { kind: "visible-final", runId });
    expect(found?.event).toMatchObject({
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        __openclaw: { runId },
      },
    });
  },
);
