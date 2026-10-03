// Covers attempt-execution helper behavior around retries, Claude CLI
// transcripts, and ACP visible text accumulation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const mocks = vi.hoisted(() => ({
  readClaudeCliFallbackSeed: vi.fn(),
}));

vi.mock("../cli-runner/log.js", () => ({
  cliBackendLog: { warn: vi.fn() },
}));

vi.mock("../../gateway/cli-session-history.claude.js", () => ({
  readClaudeCliFallbackSeed: mocks.readClaudeCliFallbackSeed,
}));

import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  createAcpVisibleTextAccumulator,
  resolveFallbackRetryPrompt,
  sessionTranscriptHasContent,
} from "./attempt-execution.helpers.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

function formatClaudeCliFallbackPrelude(
  seed: NonNullable<
    ReturnType<
      typeof import("../../gateway/cli-session-history.claude.js").readClaudeCliFallbackSeed
    >
  >,
  options?: { charBudget?: number },
) {
  mocks.readClaudeCliFallbackSeed.mockReturnValue(seed);
  return buildClaudeCliFallbackContextPrelude({ cliSessionId: "fixture-session", ...options });
}

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

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
});

describe("formatClaudeCliFallbackPrelude", () => {
  it("formats user/assistant turns and tags tool blocks with compact hints", () => {
    // Tool-use blocks are represented as compact hints because fallback prompts
    // should preserve intent without replaying full tool schemas or outputs.
    const out = formatClaudeCliFallbackPrelude({
      summaryText: "Earlier summary",
      recentTurns: [
        {
          role: "user",
          content: "Earlier user question",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Earlier assistant reply" },
            { type: "toolcall", name: "Bash" },
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
    expect(out).toContain("Summary of earlier conversation:\nEarlier summary");
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

  it.each([["a surrogate boundary", `${"x".repeat(21)}😀${"y".repeat(100)}`, "x".repeat(21)]])(
    "preserves %s when truncating an oversized summary",
    (_label, summaryText, expected) => {
      const out = formatClaudeCliFallbackPrelude(
        { summaryText, recentTurns: [] },
        { charBudget: 128 },
      );

      expect(out).toContain(`Summary of earlier conversation (truncated):\n${expected} …`);
    },
  );

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
  beforeEach(() => {
    mocks.readClaudeCliFallbackSeed.mockReset();
  });

  it("returns empty string when the Claude session loader finds no seed", () => {
    mocks.readClaudeCliFallbackSeed.mockReturnValue(undefined);

    expect(
      buildClaudeCliFallbackContextPrelude({
        cliSessionId: "missing-session",
        homeDir: "/tmp/test-home",
      }),
    ).toBe("");
    expect(mocks.readClaudeCliFallbackSeed).toHaveBeenCalledWith({
      cliSessionId: "missing-session",
      homeDir: "/tmp/test-home",
    });
  });
});

describe("sessionTranscriptHasContent", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "oc-transcript-probe-");
  let tmpDir: string;
  let target: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };

  beforeEach(async () => {
    tmpDir = sessionDirs.make();
    target = {
      agentId: "audit",
      sessionId: "fallback-history",
      sessionKey: "agent:audit:main",
      storePath: path.join(tmpDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  });

  const assistantMessage = () =>
    buildAssistantMessage({
      model: { api: "test", provider: "test", id: "test-assistant-model" },
      content: [{ type: "text", text: "persisted answer" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
      timestamp: 2,
    });

  it("marks fallback history only after SQLite contains an assistant turn", async () => {
    expect(await sessionTranscriptHasContent(undefined)).toBe(false);
    expect(await sessionTranscriptHasContent(target)).toBe(false);
    const manager = SessionManager.open(target, tmpDir);
    manager.appendMessage({ role: "user", content: "x".repeat(300 * 1024), timestamp: 1 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);
    manager.appendMessage(assistantMessage());
    manager.flushPendingPersistence();

    const sessionHasHistory = await sessionTranscriptHasContent(target);
    expect(sessionHasHistory).toBe(true);
    expect(
      resolveFallbackRetryPrompt({ body: "continue", isFallbackRetry: true, sessionHasHistory }),
    ).toBe("[Retry after the previous model attempt failed or timed out]\n\ncontinue");
  });

  it("ignores abandoned assistants and clears history at reset boundaries", async () => {
    const manager = SessionManager.open(target, tmpDir);
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    manager.appendMessage(assistantMessage());
    manager.branch(root);
    manager.appendMessage({ role: "user", content: "active branch", timestamp: 3 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);

    manager.appendMessage(assistantMessage());
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(true);
    manager.appendResetBoundary("new");
    manager.appendMessage({ role: "user", content: "fresh turn", timestamp: 4 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);
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

  async function makeWorkspace() {
    const workspaceDir = await fs.mkdtemp(path.join(tmpDir, "ws-"));
    return workspaceDir;
  }

  async function writeClaudeProjectFile(workspaceDir: string, sessionId: string, content: string) {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: tmpDir });
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, content, "utf-8");
    return file;
  }

  const GRACE_MS = 250;

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    const workspaceDir = await makeWorkspace();
    await writeClaudeProjectFile(workspaceDir, "safe-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "../safe-session",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when workspaceDir is missing (path cannot be computed)", async () => {
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "any-session",
        workspaceDir: undefined,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true on the second scan when the assistant message lands during the grace window", async () => {
    const workspaceDir = await makeWorkspace();
    const sessionId = "fs-flush-latency";
    const file = await writeClaudeProjectFile(
      workspaceDir,
      sessionId,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );

    const graceStarted = createDeferred();
    const releaseGrace = createDeferred();
    const schedule = globalThis.setTimeout;
    let graceFires = 0;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler, delay, ...args) => {
        if (delay !== GRACE_MS) {
          return schedule(handler, delay, ...args);
        }
        // Hold only this probe's grace sleep; worker completion must retain native timers.
        setTimeoutSpy.mockRestore();
        graceFires += 1;
        graceStarted.resolve();
        return schedule(() => {
          void releaseGrace.promise.then(() => handler(...args));
        }, delay);
      });
    const probe = claudeCliSessionTranscriptHasContent({
      sessionId,
      workspaceDir,
      homeDir: tmpDir,
    });
    try {
      await Promise.race([graceStarted.promise, probe]);
      expect(graceFires).toBe(1);
      await fs.appendFile(
        file,
        `${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
        })}\n`,
        "utf-8",
      );
      releaseGrace.resolve();
      expect(await probe).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      releaseGrace.resolve();
      await probe;
    }
  });
});

describe("claudeCliSessionTranscriptHasOrphanedToolUse", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-orphan-test-"));
    workspaceDir = await fs.mkdtemp(path.join(tmpDir, "ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeJsonlSession(sessionId: string, lines: object[]) {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir,
      homeDir: tmpDir,
    });
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  const message = (role: "user" | "assistant", content: unknown, isSidechain = false) => ({
    type: role,
    message: { role, content },
    ...(isSidechain ? { isSidechain: true } : {}),
  });
  const tool = (id: string, type = "tool_use") => ({ type, id, name: "Bash", input: {} });
  const result = (id: string, type = "tool_result") => ({ type, tool_use_id: id, content: "ok" });
  const longPrefix = Array.from({ length: 600 }, (_, i) => message("user", `ping ${i}`));

  it.each([
    {
      name: "Claude-specific answered calls",
      expected: false,
      lines: [
        message("assistant", [tool("server", "server_tool_use"), tool("mcp", "mcp_tool_use")]),
        message("user", [
          result("server", "web_search_tool_result"),
          result("mcp", "mcp_tool_result"),
        ]),
      ],
    },
    {
      name: "hosted results inside the assistant message",
      expected: false,
      lines: [
        message("assistant", [
          tool("server", "server_tool_use"),
          result("server", "web_search_tool_result"),
          { type: "text", text: "found it" },
        ]),
      ],
    },
    {
      name: "a string assistant superseding an orphan past record 500",
      expected: false,
      lines: [
        message("assistant", [tool("old")]),
        ...longPrefix,
        message("assistant", "moving on"),
      ],
    },
    {
      name: "main-conversation orphans with sidechain results",
      expected: true,
      lines: [message("assistant", [tool("main")]), message("user", [result("main")], true)],
    },
    {
      name: "a trailing orphan past record 500",
      expected: true,
      lines: [
        ...longPrefix,
        message("assistant", [tool("resolved")]),
        message("user", [result("resolved")]),
        message("assistant", [tool("orphan")]),
      ],
    },
  ])("detects $name", async ({ lines, expected }) => {
    await writeJsonlSession("fixture", lines);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "fixture",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(expected);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    await writeJsonlSession("safe", []);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "../safe",
        workspaceDir,
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
    expect(acc.finalizeReplySnapshot()).toEqual({
      disposition: "visible",
      text: "The user is saying",
    });
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
    expect(acc.finalizeReplySnapshot()).toEqual({
      disposition: "visible",
      text: "NO_REPLY: explanation",
    });
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

  it.each([
    { name: "exact silence", chunks: ["NO_REPLY"], expected: { disposition: "silent" } },
    { name: "partial control prefix", chunks: ["NO_RE"], expected: { disposition: "empty" } },
  ])("classifies $name at ACP finalization", ({ chunks, expected }) => {
    const acc = createAcpVisibleTextAccumulator();
    for (const chunk of chunks) {
      acc.consume(chunk);
    }
    expect(acc.finalizeReplySnapshot()).toEqual(expected);
  });
});
