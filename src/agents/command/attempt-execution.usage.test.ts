import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { persistCliTurnTranscript } from "./transcript-persistence.js";

describe("CLI transcript usage persistence", () => {
  let rootDir = "";
  let storePath = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-usage-test-"));
    storePath = path.join(rootDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("persists terminal CLI usage while keeping last-call context", async () => {
    const sessionKey = "agent:main:subagent:cli-turn-usage";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-turn-usage",
      updatedAt: Date.now(),
    };
    const lastCallUsage = { input: 2, output: 1, cacheRead: 27_376, total: 27_379 };
    const result: EmbeddedAgentRunResult = {
      payloads: [{ text: "turn reply" }],
      meta: {
        durationMs: 5,
        finalAssistantVisibleText: "turn reply",
        agentMeta: {
          sessionId: sessionEntry.sessionId,
          cliSessionBinding: { sessionId: sessionEntry.sessionId },
          provider: "claude-cli",
          model: "opus",
          usage: lastCallUsage,
          lastCallUsage,
          diagnosticUsage: { input: 6, output: 77, cacheRead: 54_631, total: 54_714 },
        },
        executionTrace: {
          winnerProvider: "claude-cli",
          winnerModel: "opus",
          fallbackUsed: false,
          runner: "cli",
        },
      },
    };

    await persistCliTurnTranscript({
      body: "run tools",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      storePath,
      sessionAgentId: "main",
      sessionCwd: rootDir,
      config: {},
    });

    const messages = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath,
      })
    ).flatMap((event) =>
      typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
    );
    const assistant = messages.at(-1) as { usage?: unknown } | undefined;
    expect(assistant?.usage).toMatchObject({
      input: 6,
      output: 77,
      cacheRead: 54_631,
      totalTokens: 54_714,
      contextUsage: { state: "available", promptTokens: 27_378, totalTokens: 27_379 },
    });
  });
});
