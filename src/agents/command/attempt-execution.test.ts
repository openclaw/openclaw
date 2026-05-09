import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  createAcpVisibleTextAccumulator,
  formatClaudeCliFallbackPrelude,
  resolveFallbackRetryPrompt,
  sessionTranscriptHasContent,
} from "./attempt-execution.helpers.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("returns original body on first attempt (isFallbackRetry=false)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
      }),
    ).toBe(originalBody);
  });

  it("prepends recovery prefix to original body on fallback retry with existing session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe(`[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`);
  });

  it("preserves original body for fallback retry when session has no history (subagent spawn)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry when sessionHasHistory is undefined", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
      }),
    ).toBe(originalBody);
  });

  it("returns original body on first attempt regardless of sessionHasHistory", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
      }),
    ).toBe(originalBody);

    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body on fallback retry without history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("prepends priorContextPrelude before the retry marker on fallback retry", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: true,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("emits the retry prompt with prelude even when sessionHasHistory is false (claude-cli case)", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: false,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("ignores empty/whitespace priorContextPrelude", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
        priorContextPrelude: "   \n  ",
      }),
    ).toBe(originalBody);
  });

  it("does not prepend prelude on non-fallback first attempts", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
        priorContextPrelude: "anything",
      }),
    ).toBe(originalBody);
  });
});

describe("formatClaudeCliFallbackPrelude", () => {
  it("returns empty string when seed has neither summary nor turns", () => {
    expect(formatClaudeCliFallbackPrelude({ recentTurns: [] })).toBe("");
  });

  it("emits summary alone when no turns are available", () => {
    const out = formatClaudeCliFallbackPrelude({
      summaryText: "User wants to ship a billing-aware fallback.",
      recentTurns: [],
    });
    expect(out).toContain("## Prior session context (from claude-cli)");
    expect(out).toContain("Summary of earlier conversation:");
    expect(out).toContain("User wants to ship a billing-aware fallback.");
    expect(out).not.toContain("Recent turns:");
  });

  it("formats user/assistant turns and tags tool blocks with compact hints", () => {
    const out = formatClaudeCliFallbackPrelude({
      recentTurns: [
        {
          role: "user",
          content: "Earlier user question",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Earlier assistant reply" },
            { type: "tool_use", name: "Bash" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: "Earlier tool output",
            },
          ],
        },
      ],
    });
    expect(out).toContain("## Prior session context (from claude-cli)");
    expect(out).toContain("Recent turns:");
    expect(out).toContain("user: Earlier user question");
    expect(out).toContain("assistant: Earlier assistant reply");
    expect(out).toContain("(tool call: Bash)");
    expect(out).toContain("(tool result: Earlier tool output)");
  });

  it("truncates an oversized summary instead of dropping it silently", () => {
    const huge = "x ".repeat(10_000).trim();
    const out = formatClaudeCliFallbackPrelude(
      { summaryText: huge, recentTurns: [] },
      { charBudget: 600 },
    );
    expect(out).toContain("Summary of earlier conversation (truncated):");
    expect(out.length).toBeLessThan(800);
    expect(out).toMatch(/…$/);
  });

  it("drops oldest turns first when the budget cannot fit all of them", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i + 1} ${"x".repeat(80)}`,
    }));
    const out = formatClaudeCliFallbackPrelude({ recentTurns: turns }, { charBudget: 350 });
    // Newest turn (turn 10) must be present; oldest (turn 1) must not be.
    expect(out).toContain("turn 10");
    expect(out).not.toContain("turn 1 ");
  });

  it("keeps the recent turn window contiguous when an adjacent turn is oversized", () => {
    const out = formatClaudeCliFallbackPrelude(
      {
        recentTurns: [
          { role: "user", content: "older small turn" },
          { role: "assistant", content: `oversized adjacent turn ${"x".repeat(500)}` },
          { role: "user", content: "newest small turn" },
        ],
      },
      { charBudget: 260 },
    );

    expect(out).toContain("newest small turn");
    expect(out).not.toContain("oversized adjacent turn");
    expect(out).not.toContain("older small turn");
  });
});

describe("buildClaudeCliFallbackContextPrelude", () => {
  it("returns empty string when no sessionId is provided", () => {
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: undefined })).toBe("");
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: "  " })).toBe("");
  });

  it("returns empty string when the Claude session file does not exist", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-prelude-"));
    try {
      expect(
        buildClaudeCliFallbackContextPrelude({
          cliSessionId: "missing-session",
          homeDir: tmpHome,
        }),
      ).toBe("");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("reads a real Claude JSONL fixture and emits a labeled prelude end-to-end", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-prelude-"));
    const sessionId = "e2e-session";
    const projectsDir = path.join(tmpHome, ".claude", "projects", "demo");
    try {
      await fs.mkdir(projectsDir, { recursive: true });
      const lines = [
        {
          type: "user",
          uuid: "u1",
          message: { role: "user", content: "prior question about deploys" },
        },
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "prior answer about blue-green" }],
          },
        },
      ];
      await fs.writeFile(
        path.join(projectsDir, `${sessionId}.jsonl`),
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf-8",
      );
      const prelude = buildClaudeCliFallbackContextPrelude({
        cliSessionId: sessionId,
        homeDir: tmpHome,
      });
      expect(prelude).toContain("## Prior session context (from claude-cli)");
      expect(prelude).toContain("user: prior question about deploys");
      expect(prelude).toContain("assistant: prior answer about blue-green");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("sessionTranscriptHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function scope(sessionId: string): { agentId: string; sessionId: string } {
    return { agentId: "main", sessionId };
  }

  function writeTranscript(sessionId: string, events: unknown[]): void {
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId,
      events: [{ type: "session", id: sessionId }, ...events],
    });
  }

  it("returns false for undefined transcript scope", async () => {
    expect(await sessionTranscriptHasContent(undefined)).toBe(false);
  });

  it("returns false when transcript scope has no SQLite rows", async () => {
    expect(await sessionTranscriptHasContent(scope("nonexistent"))).toBe(false);
  });

  it("returns false when transcript has no SQLite rows", async () => {
    expect(await sessionTranscriptHasContent(scope("empty"))).toBe(false);
  });

  it("returns false when transcript has only user message (no assistant flush)", async () => {
    const sessionId = "user-only";
    writeTranscript(sessionId, [{ type: "message", message: { role: "user", content: "hello" } }]);
    expect(await sessionTranscriptHasContent(scope(sessionId))).toBe(false);
  });

  it("returns true when transcript has assistant message (flushed)", async () => {
    const sessionId = "with-assistant";
    writeTranscript(sessionId, [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "hi" } },
    ]);
    expect(await sessionTranscriptHasContent(scope(sessionId))).toBe(true);
  });

  it("returns true when transcript has assistant message metadata", async () => {
    const sessionId = "spaced";
    writeTranscript(sessionId, [
      { type: "message", message: { role: "assistant", content: "hi" } },
    ]);
    expect(await sessionTranscriptHasContent(scope(sessionId))).toBe(true);
  });

  it("returns true when assistant message appears after large user content", async () => {
    const sessionId = "large-user";
    // Create a user message whose JSON line exceeds 256KB to ensure the
    // transcript parser finds the assistant record after large earlier content.
    const bigContent = "x".repeat(300 * 1024);
    writeTranscript(sessionId, [
      { type: "message", message: { role: "user", content: bigContent } },
      { type: "message", message: { role: "assistant", content: "done" } },
    ]);
    expect(await sessionTranscriptHasContent(scope(sessionId))).toBe(true);
  });

  it("returns false when transcript scope is incomplete", async () => {
    expect(await sessionTranscriptHasContent({ sessionId: "missing-agent" })).toBe(false);
  });
});

describe("claudeCliSessionTranscriptHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeClaudeProjectFile(sessionId: string, content: string) {
    const projectDir = path.join(tmpDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, content, "utf-8");
    return file;
  }

  it("returns false when the Claude project transcript is missing or empty", async () => {
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "missing-session",
        homeDir: tmpDir,
      }),
    ).toBe(false);

    await writeClaudeProjectFile("empty-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "empty-session",
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true when the Claude project transcript has an assistant message", async () => {
    await writeClaudeProjectFile(
      "session-with-assistant",
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      })}\n`,
    );

    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "session-with-assistant",
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    await writeClaudeProjectFile("safe-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "../safe-session",
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });
});

describe("createAcpVisibleTextAccumulator", () => {
  it("preserves cumulative raw snapshots after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume("NO_REPLYThe user is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });

    expect(acc.finalize()).toBe("The user is saying");
    expect(acc.finalizeRaw()).toBe("The user is saying");
  });

  it("keeps append-only deltas working after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume(" is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });
  });

  it("preserves punctuation-start text that begins with NO_REPLY-like content", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLY: explanation")).toEqual({
      text: "NO_REPLY: explanation",
      delta: "NO_REPLY: explanation",
    });

    expect(acc.finalize()).toBe("NO_REPLY: explanation");
  });

  it("buffers chunked NO_REPLY prefixes before emitting visible text", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO")).toBeNull();
    expect(acc.consume("NO_")).toBeNull();
    expect(acc.consume("NO_RE")).toBeNull();
    expect(acc.consume("NO_REPLY")).toBeNull();
    expect(acc.consume("Actual answer")).toEqual({
      text: "Actual answer",
      delta: "Actual answer",
    });
  });
});
