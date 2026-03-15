/**
 * Unit tests for src/agents/subagent-resume.ts
 *
 * Phase 1 subagent restart recovery — covers:
 *  - readTranscriptSessionId
 *  - transcriptHasAssistantTurn
 *  - resolveSubagentRunResumability (all 4 cases)
 *  - rehydrateSessionStoreEntries (synthesizes store entry from transcript)
 *  - routeResumedRun (dispatches to correct handler)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { store: undefined, mainKey: "main" },
    agents: {},
  }),
}));

// We will control the loadSessionStore output per-test via the spy.
const mockLoadSessionStore = vi.fn(
  (_storePath: string, _opts?: { skipCache?: boolean }): Record<string, unknown> => ({}),
);

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: Parameters<typeof mockLoadSessionStore>) =>
    mockLoadSessionStore(...args),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = (key ?? "").match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").toLowerCase() || "main";
  },
  resolveStorePath: (_store: unknown, opts?: { agentId?: string }) => {
    const agentId = opts?.agentId ?? "main";
    return `/tmp/octest/agents/${agentId}/sessions/sessions.json`;
  },
  resolveSessionFilePath: (
    sessionId: string,
    _entry?: unknown,
    opts?: { sessionsDir?: string },
  ) => {
    const dir = opts?.sessionsDir ?? "/tmp/octest/agents/main/sessions";
    return `${dir}/${sessionId}.jsonl`;
  },
  updateSessionStore: vi.fn(
    async (
      storePath: string,
      mutator: (store: Record<string, unknown>) => void | Promise<void>,
    ) => {
      const store: Record<string, unknown> = {};
      await mutator(store);
      try {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
      } catch {
        // best-effort
      }
    },
  ),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ status: "ok", runId: "new-run-id" })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./subagent-lifecycle-events.js", () => ({
  SUBAGENT_ENDED_REASON_COMPLETE: "subagent-complete",
  SUBAGENT_ENDED_REASON_ERROR: "subagent-error",
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
  },
}));

vi.mock("../config/agent-limits.js", () => ({
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH: 1,
}));

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => "mocked-system-prompt"),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: vi.fn(() => 1),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  readTranscriptSessionId,
  rehydrateSessionStoreEntries,
  resolveSubagentRunResumability,
  routeResumedRun,
  transcriptEndsWithCompletedAssistantTurn,
  transcriptHasAssistantTurn,
  transcriptLastCompletedAssistantTurnTimestamp,
} from "./subagent-resume.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const runId = overrides.runId ?? "run-test-1";
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "agent:main:main",
    task: overrides.task ?? "do something useful",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  };
}

/** Build the minimal JSONL content for a transcript session header. */
function sessionHeaderLine(sessionId: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: "/workspace",
  });
}

/** Build a JSONL line representing an assistant message turn. */
function assistantMessageLine(): string {
  return JSON.stringify({
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I have completed the task." }],
    },
  });
}

/** Build a JSONL line representing a user message turn. */
function userMessageLine(text = "do something useful"): string {
  return JSON.stringify({
    type: "message",
    id: "msg-0",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  });
}

/** Build a JSONL line representing an assistant turn that has a pending tool_use block. */
function assistantToolUseMessageLine(toolUseId = "toolu-1"): string {
  return JSON.stringify({
    type: "message",
    id: "msg-tool-call",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that for you." },
        { type: "tool_use", id: toolUseId, name: "read_file", input: { path: "/tmp/foo" } },
      ],
    },
  });
}

/** Build a JSONL line representing a user message that carries tool results. */
function toolResultMessageLine(toolUseId = "toolu-1"): string {
  return JSON.stringify({
    type: "message",
    id: "msg-tool-result",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "file contents here" }],
    },
  });
}

// ---------------------------------------------------------------------------
// readTranscriptSessionId
// ---------------------------------------------------------------------------

describe("readTranscriptSessionId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the session id from a valid transcript header", () => {
    const sessionId = "aaaa-bbbb-cccc-dddd";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, `${sessionHeaderLine(sessionId)}\n`);

    expect(readTranscriptSessionId(transcriptPath)).toBe(sessionId);
  });

  it("returns null when the file does not exist", () => {
    expect(readTranscriptSessionId(path.join(tmpDir, "missing.jsonl"))).toBeNull();
  });

  it("returns null when the first line is not a session header", () => {
    const transcriptPath = path.join(tmpDir, "bad.jsonl");
    fs.writeFileSync(transcriptPath, `${assistantMessageLine()}\n`);
    expect(readTranscriptSessionId(transcriptPath)).toBeNull();
  });

  it("returns null when the file is empty", () => {
    const transcriptPath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(transcriptPath, "");
    expect(readTranscriptSessionId(transcriptPath)).toBeNull();
  });

  it("returns null when the first line is malformed JSON", () => {
    const transcriptPath = path.join(tmpDir, "malformed.jsonl");
    fs.writeFileSync(transcriptPath, "not-json\n");
    expect(readTranscriptSessionId(transcriptPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transcriptHasAssistantTurn
// ---------------------------------------------------------------------------

describe("transcriptHasAssistantTurn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when transcript contains an assistant message line", () => {
    const sessionId = "sess-1";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantMessageLine()].join("\n"),
    );
    expect(transcriptHasAssistantTurn(transcriptPath)).toBe(true);
  });

  it("returns false when transcript has only session header (no turns)", () => {
    const sessionId = "sess-2";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, `${sessionHeaderLine(sessionId)}\n`);
    expect(transcriptHasAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when transcript has only user messages", () => {
    const sessionId = "sess-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, [sessionHeaderLine(sessionId), userMessageLine()].join("\n"));
    expect(transcriptHasAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when the file does not exist", () => {
    expect(transcriptHasAssistantTurn(path.join(tmpDir, "missing.jsonl"))).toBe(false);
  });

  it("returns false for an empty file", () => {
    const transcriptPath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(transcriptPath, "");
    expect(transcriptHasAssistantTurn(transcriptPath)).toBe(false);
  });

  it("skips malformed lines and still finds a valid assistant turn later", () => {
    const sessionId = "sess-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), "not-json", assistantMessageLine()].join("\n"),
    );
    expect(transcriptHasAssistantTurn(transcriptPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transcriptEndsWithCompletedAssistantTurn
// ---------------------------------------------------------------------------

describe("transcriptEndsWithCompletedAssistantTurn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when the last turn is an assistant text-only message", () => {
    const sessionId = "cft-1";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantMessageLine()].join("\n"),
    );
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(true);
  });

  it("returns true after a full tool round-trip ending in an assistant text reply", () => {
    const sessionId = "cft-2";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        sessionHeaderLine(sessionId),
        userMessageLine(),
        assistantToolUseMessageLine("toolu-a"),
        toolResultMessageLine("toolu-a"),
        // Final assistant reply with no tool_use — run is complete.
        assistantMessageLine(),
      ].join("\n"),
    );
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(true);
  });

  it("returns false when the last turn is an assistant message with tool_use blocks", () => {
    const sessionId = "cft-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    // Transcript ends mid-tool-use: assistant issued a tool call but the result
    // never came back (run was interrupted).
    fs.writeFileSync(
      transcriptPath,
      [
        sessionHeaderLine(sessionId),
        userMessageLine(),
        assistantToolUseMessageLine("toolu-b"),
      ].join("\n"),
    );
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when the last turn is a user tool-result message (mid-tool-use)", () => {
    const sessionId = "cft-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    // The tool result arrived but the assistant never replied — interrupted
    // between the tool result and the follow-up assistant turn.
    fs.writeFileSync(
      transcriptPath,
      [
        sessionHeaderLine(sessionId),
        userMessageLine(),
        assistantToolUseMessageLine("toolu-c"),
        toolResultMessageLine("toolu-c"),
      ].join("\n"),
    );
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when transcript has only session header (no turns)", () => {
    const sessionId = "cft-5";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, `${sessionHeaderLine(sessionId)}\n`);
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when transcript has only user messages", () => {
    const sessionId = "cft-6";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, [sessionHeaderLine(sessionId), userMessageLine()].join("\n"));
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(false);
  });

  it("returns false when the file does not exist", () => {
    expect(transcriptEndsWithCompletedAssistantTurn(path.join(tmpDir, "missing.jsonl"))).toBe(
      false,
    );
  });

  it("returns false for an empty file", () => {
    const transcriptPath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(transcriptPath, "");
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(false);
  });

  it("skips trailing malformed lines and evaluates the last valid message", () => {
    const sessionId = "cft-7";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    // Last valid line is a completed assistant turn; trailing garbage ignored.
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantMessageLine(), "not-json"].join(
        "\n",
      ),
    );
    expect(transcriptEndsWithCompletedAssistantTurn(transcriptPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSubagentRunResumability
// ---------------------------------------------------------------------------

describe("resolveSubagentRunResumability", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
    vi.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns resumable-announce-only when endedAt is set", () => {
    const entry = makeRun({ endedAt: Date.now() - 1_000 });
    // Even without a session store entry, endedAt short-circuits everything.
    mockLoadSessionStore.mockReturnValue({});
    expect(resolveSubagentRunResumability(entry)).toBe("resumable-announce-only");
  });

  it("returns orphaned when session store entry is missing", () => {
    const entry = makeRun();
    mockLoadSessionStore.mockReturnValue({});
    expect(resolveSubagentRunResumability(entry)).toBe("orphaned");
  });

  it("returns orphaned when session store entry exists but sessionId is empty", () => {
    const entry = makeRun();
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId: "  ", updatedAt: Date.now() },
    });
    expect(resolveSubagentRunResumability(entry)).toBe("orphaned");
  });

  it("returns resumable-replay when transcript has assistant turns", () => {
    const sessionId = "sess-replay";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantMessageLine()].join("\n"),
    );

    const entry = makeRun({ childSessionKey: "agent:main:subagent:replay-run" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath })).toBe("resumable-replay");
  });

  it("returns resumable-fresh when transcript exists but has no assistant turns", () => {
    const sessionId = "sess-fresh";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    // Only a session header — no turns at all.
    fs.writeFileSync(transcriptPath, `${sessionHeaderLine(sessionId)}\n`);

    const entry = makeRun({ childSessionKey: "agent:main:subagent:fresh-run" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath })).toBe("resumable-fresh");
  });

  it("returns resumable-fresh when transcript does not exist yet", () => {
    const sessionId = "sess-no-transcript";
    // No file written — transcript doesn't exist.
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    const entry = makeRun({ childSessionKey: "agent:main:subagent:no-transcript" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath })).toBe("resumable-fresh");
  });

  it("returns orphaned when childSessionKey is falsy", () => {
    const entry = makeRun({ childSessionKey: "" });
    mockLoadSessionStore.mockReturnValue({});
    expect(resolveSubagentRunResumability(entry)).toBe("orphaned");
  });

  it("returns resumable-fresh (not resumable-replay) when transcript ends mid-tool-use", () => {
    // The transcript has an assistant turn, but it ends with a pending tool_use
    // block — the run was interrupted before the tool result arrived.
    // Previously this would have returned resumable-replay (the bug); now it
    // must return resumable-fresh so the run is re-dispatched.
    const sessionId = "sess-mid-tool-use";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        sessionHeaderLine(sessionId),
        userMessageLine(),
        assistantToolUseMessageLine("toolu-x"),
      ].join("\n"),
    );

    const entry = makeRun({ childSessionKey: "agent:main:subagent:mid-tool-use" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath })).toBe("resumable-fresh");
  });

  it("returns resumable-fresh when transcript ends with a tool-result user turn (not final)", () => {
    // The tool result arrived but the assistant never replied — interrupted
    // between the tool result and the follow-up assistant turn.
    const sessionId = "sess-tool-result-only";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        sessionHeaderLine(sessionId),
        userMessageLine(),
        assistantToolUseMessageLine("toolu-y"),
        toolResultMessageLine("toolu-y"),
      ].join("\n"),
    );

    const entry = makeRun({ childSessionKey: "agent:main:subagent:tool-result-only" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath })).toBe("resumable-fresh");
  });

  it("returns resumable-fresh (not resumable-replay) when the last assistant turn pre-dates the current run start", () => {
    // Scenario: replaceSubagentRunAfterSteer was called, producing a new run
    // with a fresh startedAt.  The gateway restarted before the new run wrote
    // anything.  The transcript still ends with the OLD run's completed
    // assistant turn.  Without the boundary check this would incorrectly become
    // resumable-replay, replaying stale output.
    const sessionId = "sess-stale-post-steer";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // Build a transcript whose final assistant turn has a timestamp
    // well before the current run's startedAt.
    const priorRunEndMs = Date.now() - 10_000; // 10 seconds ago
    const staleAssistantLine = JSON.stringify({
      type: "message",
      id: "msg-stale",
      parentId: null,
      timestamp: new Date(priorRunEndMs).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Prior run completed." }],
      },
    });

    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), staleAssistantLine].join("\n"),
    );

    // The new (post-steer) run started 5 seconds ago — after the stale turn.
    const newRunStartMs = Date.now() - 5_000;
    const entry = makeRun({
      childSessionKey: "agent:main:subagent:stale-post-steer",
      startedAt: newRunStartMs,
      createdAt: newRunStartMs - 100,
    });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    // Provide explicit runStartMs override to be independent of wall-clock
    // drift during the test (uses entry.startedAt by default, but the override
    // makes the intent explicit).
    expect(
      resolveSubagentRunResumability(entry, { transcriptPath, runStartMs: newRunStartMs }),
    ).toBe("resumable-fresh");
  });

  it("returns resumable-replay when the last assistant turn post-dates the current run start", () => {
    // Normal completion scenario: the assistant turn was written AFTER the
    // current run started — it genuinely belongs to this run.
    const sessionId = "sess-current-run-replay";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    const runStartMs = Date.now() - 5_000; // run started 5 seconds ago
    const turnMs = Date.now() - 1_000; // turn written 1 second ago (after run start)

    const currentAssistantLine = JSON.stringify({
      type: "message",
      id: "msg-current",
      parentId: null,
      timestamp: new Date(turnMs).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Current run completed." }],
      },
    });

    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), currentAssistantLine].join("\n"),
    );

    const entry = makeRun({
      childSessionKey: "agent:main:subagent:current-run-replay",
      startedAt: runStartMs,
      createdAt: runStartMs - 100,
    });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    expect(resolveSubagentRunResumability(entry, { transcriptPath, runStartMs })).toBe(
      "resumable-replay",
    );
  });
});

// ---------------------------------------------------------------------------
// transcriptLastCompletedAssistantTurnTimestamp
// ---------------------------------------------------------------------------

describe("transcriptLastCompletedAssistantTurnTimestamp", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the epoch-ms timestamp of a completed assistant turn", () => {
    const sessionId = "lcat-1";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const expectedMs = Date.now() - 2_000;
    const line = JSON.stringify({
      type: "message",
      id: "msg-a",
      parentId: null,
      timestamp: new Date(expectedMs).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    });
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), line].join("\n"),
    );
    const result = transcriptLastCompletedAssistantTurnTimestamp(transcriptPath);
    // Allow 1-second tolerance for ISO round-trip rounding.
    expect(result).not.toBeNull();
    expect(Math.abs((result as number) - expectedMs)).toBeLessThan(1_000);
  });

  it("returns null when the last message has a pending tool_use block", () => {
    const sessionId = "lcat-2";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantToolUseMessageLine("t1")].join(
        "\n",
      ),
    );
    expect(transcriptLastCompletedAssistantTurnTimestamp(transcriptPath)).toBeNull();
  });

  it("returns null when the last message is a user turn", () => {
    const sessionId = "lcat-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, [sessionHeaderLine(sessionId), userMessageLine()].join("\n"));
    expect(transcriptLastCompletedAssistantTurnTimestamp(transcriptPath)).toBeNull();
  });

  it("returns null when the file does not exist", () => {
    expect(
      transcriptLastCompletedAssistantTurnTimestamp(path.join(tmpDir, "missing.jsonl")),
    ).toBeNull();
  });

  it("returns null for an empty file", () => {
    const transcriptPath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(transcriptPath, "");
    expect(transcriptLastCompletedAssistantTurnTimestamp(transcriptPath)).toBeNull();
  });

  it("accepts a numeric epoch-ms timestamp field", () => {
    const sessionId = "lcat-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const expectedMs = Date.now() - 3_000;
    const line = JSON.stringify({
      type: "message",
      id: "msg-b",
      parentId: null,
      timestamp: expectedMs, // numeric, not ISO string
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done (numeric ts)." }],
      },
    });
    fs.writeFileSync(
      transcriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), line].join("\n"),
    );
    const result = transcriptLastCompletedAssistantTurnTimestamp(transcriptPath);
    expect(result).toBe(expectedMs);
  });
});

// ---------------------------------------------------------------------------
// rehydrateSessionStoreEntries
// ---------------------------------------------------------------------------

describe("rehydrateSessionStoreEntries", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
    vi.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips entries that already have endedAt set", async () => {
    const entry = makeRun({ endedAt: Date.now() });
    const runs = new Map([[entry.runId, entry]]);

    // loadSessionStore should never be called for a completed run.
    mockLoadSessionStore.mockReturnValue({});
    await rehydrateSessionStoreEntries(runs);

    expect(mockLoadSessionStore).not.toHaveBeenCalled();
  });

  it("skips entries that already have a session-store entry", async () => {
    const entry = makeRun();
    const runs = new Map([[entry.runId, entry]]);

    // Return a store that already has the entry.
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId: "existing-sess", updatedAt: Date.now() },
    });
    await rehydrateSessionStoreEntries(runs);

    // Called once (for the skipCache read) — no write should occur.
    expect(mockLoadSessionStore).toHaveBeenCalledTimes(1);
  });

  it("synthesises a session-store entry from a transcript when the store entry is missing", async () => {
    const agentId = "main";

    // The global mock for resolveStorePath returns:
    //   /tmp/octest/agents/${agentId}/sessions/sessions.json
    // So we must create our sessions dir and transcript at that exact path.
    const sessionsDir = `/tmp/octest/agents/${agentId}/sessions`;
    const storePath = path.join(sessionsDir, "sessions.json");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "synth-session-id";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    // Write transcript so the scanner can find it.
    fs.writeFileSync(transcriptPath, `${sessionHeaderLine(sessionId)}\n`);

    const createdAt = Date.now() - 1_000; // 1 second ago (within the 5-min tolerance)
    const entry = makeRun({
      runId: "run-synth",
      childSessionKey: `agent:${agentId}:subagent:run-synth`,
      createdAt,
    });
    const runs = new Map([[entry.runId, entry]]);

    // First call (skipCache: true) returns no entry so the function falls
    // through to the directory scan and inject path.
    mockLoadSessionStore.mockReturnValue({});

    await rehydrateSessionStoreEntries(runs);

    // The store file should now exist with our synthetic entry (written by the
    // updateSessionStore mock, which simulates a real file write).
    const written = fs.existsSync(storePath)
      ? (JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, unknown>)
      : {};

    // The key is the lowercased childSessionKey.
    const normalizedKey = entry.childSessionKey.toLowerCase();
    const injected = written[normalizedKey] as Record<string, unknown> | undefined;
    expect(injected).toBeDefined();
    expect(injected?.sessionId).toBe(sessionId);
    expect(injected?.spawnedBy).toBe(entry.requesterSessionKey);
    // spawnDepth is now computed as getSubagentDepthFromSessionStore(requester) + 1.
    // The test mock returns 1 for all getSubagentDepthFromSessionStore calls, so the
    // child depth is 1 + 1 = 2 (validates dynamic computation, not hardcoded 1).
    expect(injected?.spawnDepth).toBe(2);

    // Cleanup the fixed path used by this test.
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
});

// ---------------------------------------------------------------------------
// routeResumedRun
// ---------------------------------------------------------------------------

describe("routeResumedRun", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-resume-test-"));
    vi.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false (fall-through) for orphaned runs", () => {
    const entry = makeRun();
    mockLoadSessionStore.mockReturnValue({});

    const onCompleteReplay = vi.fn();
    const onCompleteRedispatch = vi.fn();

    const result = routeResumedRun({
      runId: entry.runId,
      entry,
      waitTimeoutMs: 30_000,
      onCompleteReplay,
      onCompleteRedispatch,
    });

    expect(result).toBe(false);
    expect(onCompleteReplay).not.toHaveBeenCalled();
    expect(onCompleteRedispatch).not.toHaveBeenCalled();
  });

  it("returns false (fall-through) for resumable-announce-only runs", () => {
    // endedAt is set → resumable-announce-only is handled by the caller's
    // existing endedAt check, so routeResumedRun returns false to fall through.
    const entry = makeRun({ endedAt: Date.now() - 500 });
    mockLoadSessionStore.mockReturnValue({});

    const onCompleteReplay = vi.fn();
    const onCompleteRedispatch = vi.fn();

    const result = routeResumedRun({
      runId: entry.runId,
      entry,
      waitTimeoutMs: 30_000,
      onCompleteReplay,
      onCompleteRedispatch,
    });

    expect(result).toBe(false);
    expect(onCompleteReplay).not.toHaveBeenCalled();
    expect(onCompleteRedispatch).not.toHaveBeenCalled();
  });

  it("returns true and invokes onCompleteReplay for resumable-replay runs", async () => {
    const sessionId = "replay-sess";
    // Write the transcript at the path that resolveSubagentRunResumability will
    // derive via the mocked resolveStorePath / resolveSessionFilePath:
    //   sessionsDir = /tmp/octest/agents/main/sessions
    //   transcriptPath = /tmp/octest/agents/main/sessions/replay-sess.jsonl
    const mockSessionsDir = "/tmp/octest/agents/main/sessions";
    const mockTranscriptPath = path.join(mockSessionsDir, `${sessionId}.jsonl`);
    fs.mkdirSync(mockSessionsDir, { recursive: true });
    fs.writeFileSync(
      mockTranscriptPath,
      [sessionHeaderLine(sessionId), userMessageLine(), assistantMessageLine()].join("\n"),
    );

    const entry = makeRun({ childSessionKey: "agent:main:subagent:replay-run" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    const onCompleteReplay = vi.fn().mockResolvedValue(undefined);
    const onCompleteRedispatch = vi.fn();

    const result = routeResumedRun({
      runId: entry.runId,
      entry,
      waitTimeoutMs: 30_000,
      onCompleteReplay,
      onCompleteRedispatch,
    });

    expect(result).toBe(true);

    // recoverCompletedSubagentRunFromTranscript is called via `void`; wait for
    // the async chain to complete before asserting on the callback.
    await vi.waitUntil(() => onCompleteReplay.mock.calls.length > 0, { timeout: 500 });

    // onCompleteReplay must be called with the original runId and a numeric endedAt.
    expect(onCompleteReplay).toHaveBeenCalledWith(entry.runId, expect.any(Number));
    expect(onCompleteRedispatch).not.toHaveBeenCalled();

    // Cleanup the shared mock path.
    try {
      fs.rmSync(mockSessionsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns true and invokes onCompleteRedispatch for resumable-fresh runs", async () => {
    const sessionId = "fresh-sess";
    // Write only a session header (no assistant turns) at the mocked path.
    const mockSessionsDir = "/tmp/octest/agents/main/sessions";
    const mockTranscriptPath = path.join(mockSessionsDir, `${sessionId}.jsonl`);
    fs.mkdirSync(mockSessionsDir, { recursive: true });
    fs.writeFileSync(mockTranscriptPath, `${sessionHeaderLine(sessionId)}\n`);

    const entry = makeRun({ childSessionKey: "agent:main:subagent:fresh-run" });
    mockLoadSessionStore.mockReturnValue({
      [entry.childSessionKey]: { sessionId, updatedAt: Date.now() },
    });

    const onCompleteReplay = vi.fn();
    // callGateway is mocked to return { status: "ok", runId: "new-run-id" } for
    // both the `agent` and `agent.wait` calls made by redispatchSubagentRunAfterRestart.
    const onCompleteRedispatch = vi.fn().mockResolvedValue(undefined);

    const result = routeResumedRun({
      runId: entry.runId,
      entry,
      waitTimeoutMs: 30_000,
      onCompleteReplay,
      onCompleteRedispatch,
    });

    expect(result).toBe(true);

    // redispatchSubagentRunAfterRestart is called via `void`; wait for the async
    // chain (agent + agent.wait callGateway calls) to resolve.
    await vi.waitUntil(() => onCompleteRedispatch.mock.calls.length > 0, { timeout: 500 });

    // onCompleteRedispatch must be called with the original runId, a numeric
    // endedAt, and the outcome from agent.wait.
    expect(onCompleteRedispatch).toHaveBeenCalledWith(
      entry.runId,
      expect.any(Number),
      expect.objectContaining({ status: "ok" }),
    );
    expect(onCompleteReplay).not.toHaveBeenCalled();

    // Cleanup the shared mock path.
    try {
      fs.rmSync(mockSessionsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
