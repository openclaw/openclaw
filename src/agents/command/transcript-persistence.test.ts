import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistAcpTurnTranscript, persistCliTurnTranscript } from "./transcript-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

it.each(["CLI", "ACP"] as const)(
  "keeps the %s coordination fallback hidden after runtime persistence is unavailable",
  async (runtime) => {
    const cwd = tempDirs.make("openclaw-coordination-fallback-");
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
