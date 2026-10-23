import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import {
  captureRuntimeConfigAsyncReader,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach } from "vitest";
import { assistantMessage } from "./test-support.js";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

export function setupSessionHistoryFixtures() {
  const tempDirs: string[] = [];
  const memorySessions: Array<Parameters<typeof deleteSessionEntry>[0]> = [];

  afterEach(async () => {
    for (const session of memorySessions.splice(0)) {
      await deleteSessionEntry(session);
    }
    for (const dir of tempDirs.splice(0)) {
      await closeOpenClawAgentDatabasesAsync(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
    clearRuntimeConfigSnapshot();
  });

  async function writeSession(
    records: unknown[],
    headerOverrides: Record<string, unknown> = {},
  ): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "codex-session",
      timestamp: "2026-06-15T00:00:00.000Z",
      cwd: dir,
      ...headerOverrides,
    };
    await fs.writeFile(
      sessionFile,
      [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    return sessionFile;
  }

  async function writeSqliteSession(
    params: { storedSessionFile?: string; incognito?: boolean; sessionKey?: string } = {},
  ) {
    await captureRuntimeConfigAsyncReader()();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-sqlite-"));
    tempDirs.push(dir);
    const env = params.incognito ? { OPENCLAW_STATE_DIR: dir } : undefined;
    const storePath = params.incognito
      ? path.join(dir, "agents", "main", "agent", "incognito-openclaw-agent.sqlite")
      : path.join(dir, "openclaw-agent.sqlite");
    const sessionId = params.incognito
      ? `codex-sqlite-${path.basename(dir)}`
      : "codex-sqlite-session";
    const sessionKey =
      params.sessionKey ??
      (params.incognito
        ? `agent:main:dashboard:incognito-${path.basename(dir)}`
        : "agent:main:codex-sqlite");
    const marker = `sqlite:main:${sessionId}:${storePath}`;
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      ...(env ? { env } : {}),
    };
    if (params.incognito) {
      memorySessions.push(scope);
    }
    await upsertSessionEntry({
      ...scope,
      entry: {
        sessionFile: params.storedSessionFile ?? marker,
        ...(params.incognito ? { incognito: true } : {}),
        sessionId,
        updatedAt: 1,
      },
    });
    const append = (
      message: Parameters<typeof appendSessionTranscriptMessageByIdentity>[0]["message"],
    ) => appendSessionTranscriptMessageByIdentity({ ...scope, message });
    await append({ role: "user", content: "sqlite prompt", timestamp: 1 });
    await append({ role: "assistant", content: "sqlite answer", timestamp: 2 });
    const target = { ...scope, sessionTarget: scope, sessionFile: marker };
    return { marker, sessionKey, sessionTarget: scope, target, append };
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
        ...assistantMessage("", 207),
        content: [{ type: "toolCall", id: "sent", name: "message", arguments: {} }],
        api: "openai-responses",
        model: "synthetic",
        stopReason: "toolUse",
      },
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
