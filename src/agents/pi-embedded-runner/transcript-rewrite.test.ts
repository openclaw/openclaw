import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  CURRENT_SESSION_VERSION,
  type SessionManager,
  type SessionEntry,
  type SessionHeader,
} from "../transcript/session-transcript-contract.js";
import {
  readTranscriptStateForSession,
  type TranscriptState,
} from "../transcript/transcript-state.js";

let rewriteTranscriptEntriesInSqliteTranscript: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSqliteTranscript;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const tmpDirs: string[] = [];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function getStateBranchMessages(state: TranscriptState): AgentMessage[] {
  return state
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function createTextContent(text: string) {
  return [{ type: "text", text }];
}

function createToolResultReplacement(toolName: string, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName,
    content: createTextContent(text),
    isError: false,
    timestamp,
  } as AgentMessage;
}

beforeAll(async () => {
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ rewriteTranscriptEntriesInSqliteTranscript } = await import("./transcript-rewrite.js"));
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-"));
  tmpDirs.push(dir);
  return dir;
}

async function seedSqliteRewriteSession(): Promise<{
  agentId: string;
  sessionId: string;
  toolResultEntryId: string;
}> {
  const dir = await makeTmpDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const agentId = "main";
  const sessionId = "rewrite-test";
  const header: SessionHeader = {
    type: "session",
    id: sessionId,
    version: CURRENT_SESSION_VERSION,
    timestamp: new Date(0).toISOString(),
    cwd: dir,
  };
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: asAppendMessage({
        role: "user",
        content: "run tool",
        timestamp: 1,
      }),
    },
    {
      type: "message",
      id: "tool-result-1",
      parentId: "user-1",
      timestamp: new Date(2).toISOString(),
      message: asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: createTextContent("before rewrite"),
        isError: false,
        timestamp: 2,
      }),
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "tool-result-1",
      timestamp: new Date(3).toISOString(),
      message: asAppendMessage({
        role: "assistant",
        content: createTextContent("summarized"),
        timestamp: 3,
      }),
    },
  ];
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId,
    events: [header, ...entries],
  });
  return { agentId, sessionId, toolResultEntryId: "tool-result-1" };
}

describe("rewriteTranscriptEntriesInSqliteTranscript", () => {
  it("emits transcript updates when the active SQLite branch changes without opening a manager", async () => {
    const { agentId, sessionId, toolResultEntryId } = await seedSqliteRewriteSession();

    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInSqliteTranscript({
        agentId,
        sessionId,
        sessionKey: "agent:main:test",
        request: {
          replacements: [
            {
              entryId: toolResultEntryId,
              message: createToolResultReplacement("exec", "[file_ref:file_abc]", 2),
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      expect(listener).toHaveBeenCalledWith({
        agentId,
        sessionId,
        sessionKey: "agent:main:test",
      });

      const rewrittenState = await readTranscriptStateForSession({ agentId, sessionId });
      const rewrittenToolResult = getStateBranchMessages(rewrittenState)[1] as Extract<
        AgentMessage,
        { role: "toolResult" }
      >;
      expect(rewrittenToolResult.content).toEqual([{ type: "text", text: "[file_ref:file_abc]" }]);
    } finally {
      cleanup();
    }
  });
});
