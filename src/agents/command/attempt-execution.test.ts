import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ClaudeCliFallbackSeed } from "../../gateway/cli-session-history.claude.js";
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

function formatClaudeCliFallbackPrelude(seed: ClaudeCliFallbackSeed) {
  mocks.readClaudeCliFallbackSeed.mockReturnValue(seed);
  return buildClaudeCliFallbackContextPrelude({ cliSessionId: "fixture-session" });
}
const turn = (role: "user" | "assistant", content: unknown) => ({ role, content });
const summaryPrelude = (summaryText: string) =>
  formatClaudeCliFallbackPrelude({ summaryText, recentTurns: [] });

it("emits the retry prompt with prelude even when sessionHasHistory is false (claude-cli case)", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";
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

describe("formatClaudeCliFallbackPrelude", () => {
  it("formats user/assistant turns and tags tool blocks with compact hints", async () => {
    const out = await formatClaudeCliFallbackPrelude({
      summaryText: "Earlier summary",
      recentTurns: [
        turn("user", "Earlier user question"),
        turn("assistant", [
          { type: "text", text: "Earlier assistant reply" },
          { type: "toolcall", name: "Bash" },
        ]),
        turn("user", [
          { type: "tool_result", tool_use_id: "toolu_x", content: "Earlier tool output" },
        ]),
      ],
    });
    for (const fragment of [
      "## Prior session context (from claude-cli)",
      "Summary of earlier conversation:\nEarlier summary",
      "Recent turns:",
      "user: Earlier user question",
      "assistant: Earlier assistant reply",
      "(tool call: Bash)",
      "(tool result: Earlier tool output)",
    ]) {
      expect(out).toContain(fragment);
    }
  });

  it("truncates an oversized summary instead of dropping it silently", async () => {
    const huge = "x ".repeat(10_000).trim();
    const out = await summaryPrelude(huge);
    expect(out).toContain("Summary of earlier conversation (truncated):");
    expect(out.length).toBeLessThan(8_000);
    expect(out).toMatch(/…$/);
  });

  it("preserves a surrogate boundary when truncating an oversized summary", async () => {
    const out = await summaryPrelude(`${"x".repeat(7_893)}😀${"y".repeat(100)}`);
    expect(out).toContain(`Summary of earlier conversation (truncated):\n${"x".repeat(7_893)} …`);
  });

  it("keeps the recent turn window contiguous when an adjacent turn is oversized", async () => {
    const out = await formatClaudeCliFallbackPrelude({
      recentTurns: [
        turn("user", "older small turn"),
        turn("assistant", `oversized adjacent turn ${"x".repeat(8_000)}`),
        turn("user", "newest small turn"),
      ],
    });

    expect(out).toContain("newest small turn");
    expect(out).not.toContain("oversized adjacent turn");
    expect(out).not.toContain("older small turn");
  });
});

it("returns empty string when the Claude session loader finds no seed", async () => {
  mocks.readClaudeCliFallbackSeed.mockReset();
  const params = {
    cliSessionId: "missing-session",
    homeDir: "/tmp/test-home",
  };
  expect(await buildClaudeCliFallbackContextPrelude(params)).toBe("");
  expect(mocks.readClaudeCliFallbackSeed).toHaveBeenCalledWith(params);
});

describe("sessionTranscriptHasContent", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "oc-transcript-probe-");
  let tmpDir: string;
  let target: NonNullable<Parameters<typeof sessionTranscriptHasContent>[0]>;

  beforeEach(async () => {
    tmpDir = sessionDirs.make();
    target = {
      agentId: "audit",
      sessionId: "fallback-history",
      sessionKey: "agent:audit:main",
      storePath: path.join(tmpDir, "openclaw-agent.sqlite"),
    };
    setRuntimeConfigSnapshot({ session: { store: target.storePath } });
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  });

  afterEach(clearRuntimeConfigSnapshot);

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

describe("Claude CLI transcript probes", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-session-test-"));
    workspaceDir = await fs.mkdtemp(path.join(tmpDir, "ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const message = (role: "user" | "assistant", content: unknown, isSidechain = false) => ({
    type: role,
    message: { role, content },
    ...(isSidechain ? { isSidechain: true } : {}),
  });

  async function writeJsonlSession(sessionId: string, lines: object[]) {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: tmpDir });
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
    return file;
  }

  const probe = (sessionId: string, orphan = false) =>
    (orphan ? claudeCliSessionTranscriptHasOrphanedToolUse : claudeCliSessionTranscriptHasContent)({
      sessionId,
      workspaceDir,
      homeDir: tmpDir,
    });

  const GRACE_MS = 250;

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
    const sessionId = "fs-flush-latency";
    const file = await writeJsonlSession(sessionId, [
      message("user", [{ type: "text", text: "hi" }]),
    ]);

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
    const pending = probe(sessionId);
    try {
      await Promise.race([graceStarted.promise, pending]);
      expect(graceFires).toBe(1);
      await fs.appendFile(
        file,
        `${JSON.stringify(message("assistant", [{ type: "text", text: "ack" }]))}\n`,
        "utf-8",
      );
      releaseGrace.resolve();
      expect(await pending).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      releaseGrace.resolve();
      await pending;
    }
  });
  const tool = (id: string, type = "tool_use") => ({ type, id, name: "Bash", input: {} });
  const result = (id: string, type = "tool_result") => ({ type, tool_use_id: id, content: "ok" });
  const longPrefix = Array.from({ length: 600 }, (_, i) => message("user", `ping ${i}`));

  it.each([
    [
      "hosted results inside the assistant message",
      false,
      [
        message("assistant", [
          tool("server", "server_tool_use"),
          result("server", "web_search_tool_result"),
          { type: "text", text: "found it" },
        ]),
      ],
    ],
    [
      "a string assistant superseding an orphan past record 500",
      false,
      [message("assistant", [tool("old")]), ...longPrefix, message("assistant", "moving on")],
    ],
    [
      "answered calls repeated by a request echo before the final reply",
      false,
      [
        message("assistant", [tool("spawn")]),
        message("user", [result("spawn")]),
        { type: "api-request-blob", message: { role: "assistant", content: [tool("spawn")] } },
        { type: "api-request" },
      ],
    ],
    [
      "an orphan followed only by a request echo",
      true,
      [
        message("assistant", [tool("orphan")]),
        { type: "api-request-blob", message: { role: "user", content: [result("orphan")] } },
      ],
    ],
    [
      "main-conversation orphans with sidechain results",
      true,
      [message("assistant", [tool("main")]), message("user", [result("main")], true)],
    ],
    [
      "a trailing orphan past record 500",
      true,
      [
        ...longPrefix,
        message("assistant", [tool("resolved")]),
        message("user", [result("resolved")]),
        message("assistant", [tool("orphan")]),
      ],
    ],
  ] satisfies [string, boolean, object[]][])("detects %s", async (_name, expected, lines) => {
    await writeJsonlSession("fixture", lines);
    expect(await probe("fixture", true)).toBe(expected);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    await writeJsonlSession("safe", []);
    expect(await probe("../safe", true)).toBe(false);
  });
});

describe("createAcpVisibleTextAccumulator", () => {
  const visible = (text: string, delta = text) => ({ text, delta });
  it.each(["snapshot", "delta"])("preserves %s text containing an attached sentinel", (mode) => {
    const acc = createAcpVisibleTextAccumulator();
    expect(acc.consume("NO_REPLYThe user")).toEqual(visible("NO_REPLYThe user"));
    expect(acc.consume(mode === "snapshot" ? "NO_REPLYThe user is saying" : " is saying")).toEqual(
      visible("NO_REPLYThe user is saying", " is saying"),
    );
    expect(acc.finalize()).toBe("NO_REPLYThe user is saying");
    expect(acc.finalizeRaw()).toBe("NO_REPLYThe user is saying");
    expect(acc.finalizeReplySnapshot()).toEqual({
      disposition: "visible",
      text: "NO_REPLYThe user is saying",
    });
  });

  it.each(["NO_REPLY", "no_reply", "No_Reply"])(
    "buffers chunked %s prefixes before emitting visible text",
    (token) => {
      const acc = createAcpVisibleTextAccumulator();

      expect(acc.consume(token.slice(0, 2))).toBeNull();
      expect(acc.consume(token.slice(0, 3))).toBeNull();
      expect(acc.consume(token.slice(0, 5))).toBeNull();
      expect(acc.consume(token)).toBeNull();
      expect(acc.consume("\nActual answer")).toEqual(visible("Actual answer"));
    },
  );

  it("releases an unfinished control prefix at ACP finalization", () => {
    const acc = createAcpVisibleTextAccumulator();
    acc.consume("NO_RE");
    expect(acc.finalizeReplySnapshot()).toEqual({ disposition: "visible", text: "NO_RE" });
  });
});
