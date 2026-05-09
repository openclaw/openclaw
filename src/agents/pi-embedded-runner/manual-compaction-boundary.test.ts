import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../../config/sessions/test-helpers/transcript-locator.js";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { AssistantMessage } from "../pi-ai-contract.js";
import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  type SessionHeader,
} from "../transcript/session-transcript-contract.js";
import { TranscriptState } from "../transcript/transcript-state.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";

let tmpDir = "";
let sessionCounter = 0;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manual-compaction-boundary-"));
  return tmpDir;
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = "";
  }
});

function createAssistantTextMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  };
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join(" ");
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function messageEntry(params: {
  id: string;
  parentId: string | null;
  message: AgentMessage | AssistantMessage;
  timestamp: number;
}): SessionEntry {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: timestamp(params.timestamp),
    message: params.message,
  };
}

function compactionEntry(params: {
  id: string;
  parentId: string | null;
  summary: string;
  firstKeptEntryId: string;
  timestamp: number;
  tokensBefore: number;
}): SessionEntry {
  return {
    type: "compaction",
    id: params.id,
    parentId: params.parentId,
    timestamp: timestamp(params.timestamp),
    summary: params.summary,
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: params.tokensBefore,
  };
}

async function seedSession(entries: SessionEntry[]): Promise<{
  transcriptLocator: string;
  sessionId: string;
}> {
  const dir = await makeTmpDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const sessionId = `manual-compaction-${++sessionCounter}`;
  const transcriptLocator = createSqliteSessionTranscriptLocator({ agentId: "main", sessionId });
  const header: SessionHeader = {
    type: "session",
    id: sessionId,
    version: CURRENT_SESSION_VERSION,
    timestamp: timestamp(0),
    cwd: dir,
  };
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId,
    events: [header, ...entries],
  });
  return { transcriptLocator, sessionId };
}

function loadState(sessionId: string): TranscriptState {
  const events = loadSqliteSessionTranscriptEvents({ agentId: "main", sessionId }).map(
    (entry) => entry.event,
  );
  const header =
    events.find((event): event is SessionHeader =>
      Boolean(
        event && typeof event === "object" && (event as { type?: unknown }).type === "session",
      ),
    ) ?? null;
  const entries = events.filter((event): event is SessionEntry =>
    Boolean(event && typeof event === "object" && (event as { type?: unknown }).type !== "session"),
  );
  return new TranscriptState({ header, entries });
}

describe("hardenManualCompactionBoundary", () => {
  it("turns manual compaction into a true checkpoint for rebuilt context", async () => {
    const latestCompactionId = "compact-2";
    const { sessionId } = await seedSession([
      messageEntry({
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "old question", timestamp: 1 },
        timestamp: 1,
      }),
      messageEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: createAssistantTextMessage("very long old answer", 2),
        timestamp: 2,
      }),
      compactionEntry({
        id: "compact-1",
        parentId: "assistant-1",
        summary: "old summary",
        firstKeptEntryId: "assistant-1",
        timestamp: 3,
        tokensBefore: 100,
      }),
      messageEntry({
        id: "user-2",
        parentId: "compact-1",
        message: { role: "user", content: "new question", timestamp: 4 },
        timestamp: 4,
      }),
      messageEntry({
        id: "assistant-2",
        parentId: "user-2",
        message: createAssistantTextMessage(
          "detailed new answer that should be summarized away",
          5,
        ),
        timestamp: 5,
      }),
      compactionEntry({
        id: latestCompactionId,
        parentId: "assistant-2",
        summary: "fresh summary",
        firstKeptEntryId: "assistant-2",
        timestamp: 6,
        tokensBefore: 200,
      }),
    ]);

    const beforeTexts = loadState(sessionId)
      .buildSessionContext()
      .messages.map((message) => messageText(message));
    expect(beforeTexts.join("\n")).toContain("detailed new answer");

    const hardened = await hardenManualCompactionBoundary({ agentId: "main", sessionId });
    expect(hardened.applied).toBe(true);
    expect(hardened.firstKeptEntryId).toBe(latestCompactionId);
    expect(hardened.messages.map((message) => message.role)).toEqual(["compactionSummary"]);

    const reopened = loadState(sessionId);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.firstKeptEntryId).toBe(latestCompactionId);

    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId,
      events: [
        reopened.getHeader()!,
        ...reopened.getEntries(),
        messageEntry({
          id: "user-3",
          parentId: latestCompactionId,
          message: { role: "user", content: "what was happening?", timestamp: 7 },
          timestamp: 7,
        }),
      ],
    });
    const after = loadState(sessionId);
    const afterTexts = after.buildSessionContext().messages.map((message) => messageText(message));
    expect(after.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
    expect(afterTexts.join("\n")).not.toContain("detailed new answer");
  });

  it("keeps the upstream recent tail when requested", async () => {
    const keepId = "assistant-1";
    const latestCompactionId = "compact-1";
    const { sessionId } = await seedSession([
      messageEntry({
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "old question", timestamp: 1 },
        timestamp: 1,
      }),
      messageEntry({
        id: keepId,
        parentId: "user-1",
        message: createAssistantTextMessage("old answer", 2),
        timestamp: 2,
      }),
      compactionEntry({
        id: latestCompactionId,
        parentId: keepId,
        summary: "fresh summary",
        firstKeptEntryId: keepId,
        timestamp: 3,
        tokensBefore: 200,
      }),
    ]);

    const hardened = await hardenManualCompactionBoundary({
      agentId: "main",
      sessionId,
      preserveRecentTail: true,
    });
    expect(hardened.applied).toBe(false);
    expect(hardened.firstKeptEntryId).toBe(keepId);

    const reopened = loadState(sessionId);
    const latest = reopened.getLeafEntry();
    expect(latest?.type).toBe("compaction");
    if (!latest || latest.type !== "compaction") {
      throw new Error("expected latest leaf to be a compaction entry");
    }
    expect(latest.id).toBe(latestCompactionId);
    expect(latest.firstKeptEntryId).toBe(keepId);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
    ]);
  });

  it("is a no-op when the latest leaf is not a compaction entry", async () => {
    const { sessionId } = await seedSession([
      messageEntry({
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "hello", timestamp: 1 },
        timestamp: 1,
      }),
      messageEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: createAssistantTextMessage("hi", 2),
        timestamp: 2,
      }),
    ]);

    const result = await hardenManualCompactionBoundary({ agentId: "main", sessionId });
    expect(result.applied).toBe(false);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
