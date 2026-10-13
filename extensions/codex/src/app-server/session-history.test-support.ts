import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach } from "vitest";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

export function setupSessionHistoryFixtures() {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await closeOpenClawAgentDatabasesAsync(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function writeSession(records: unknown[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "codex-session",
      timestamp: "2026-06-15T00:00:00.000Z",
      cwd: dir,
    };
    await fs.writeFile(
      sessionFile,
      [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    return sessionFile;
  }

  async function writeSqliteSession(
    params: { storedSessionFile?: string; incognito?: boolean } = {},
  ): Promise<{
    marker: string;
    sessionKey: string;
    sessionTarget: {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    };
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-sqlite-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sessionId = params.incognito
      ? `codex-sqlite-${path.basename(dir)}`
      : "codex-sqlite-session";
    const sessionKey = params.incognito
      ? `agent:main:dashboard:incognito-${path.basename(dir)}`
      : "agent:main:codex-sqlite";
    const marker = `sqlite:main:${sessionId}:${storePath}`;
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
    };
    await upsertSessionEntry({
      ...scope,
      entry: {
        sessionFile: params.storedSessionFile ?? marker,
        ...(params.incognito ? { incognito: true } : {}),
        sessionId,
        updatedAt: 1,
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "sqlite prompt", timestamp: 1 },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "sqlite answer", timestamp: 2 },
    });
    return { marker, sessionKey, sessionTarget: scope };
  }

  return { tempDirs, writeSession, writeSqliteSession };
}

export function settledFixture() {
  const upstreamPrompt = "Native context\nSend the synthetic update.";
  const settledMessages: AgentMessage[] = [
    attachUpstreamUserText(
      attachCodexMirrorIdentity(
        { role: "user", content: "Send the synthetic update.", timestamp: 206 },
        "settled:prompt",
      ),
      upstreamPrompt,
    ),
    attachCodexMirrorIdentity(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "sent", name: "message", arguments: {} }],
        api: "openai-responses",
        provider: "openai",
        model: "synthetic",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 207,
      } satisfies AssistantMessage,
      "settled:tool:sent:call",
    ),
    attachCodexMirrorIdentity(
      {
        role: "toolResult",
        toolCallId: "sent",
        toolName: "message",
        isError: false,
        content: [{ type: "text", text: "Synthetic update sent." }],
        timestamp: 208,
      },
      "settled:tool:sent:result",
    ),
  ];

  return { upstreamPrompt, settledMessages };
}
