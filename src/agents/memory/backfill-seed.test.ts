// Seed driver (04-02): replay live transcripts into durable `turns`. Proves live-only
// enumeration (trajectory/archive decoys excluded), cross-file chronological merge under
// the unified agent:{id}:main session_key, and free resumability (re-run inserts 0 via the
// idempotency_key dedup + seed cursor). Pure DI: transcripts dir + DB env are injected; the
// runtime is never booted (agents test guardrails).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { listLiveTranscripts, runBackfillSeed } from "./backfill-seed.js";
import { getTurns } from "./turns-store.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function env(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

function headerLine(id: string): string {
  return JSON.stringify({
    type: "session",
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  });
}

// A durable user/assistant message entry; msgTs drives both the anchor and the merge order.
function messageLine(opts: {
  id: string;
  role: "user" | "assistant";
  text: string;
  msgTs: number;
}): string {
  return JSON.stringify({
    type: "message",
    id: opts.id,
    parentId: null,
    timestamp: new Date(opts.msgTs).toISOString(),
    message: {
      role: opts.role,
      content: [{ type: "text", text: opts.text }],
      timestamp: opts.msgTs,
    },
  });
}

function writeTranscript(dir: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`, "utf8");
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("listLiveTranscripts", () => {
  it("returns only live .jsonl files, excluding trajectory/deleted/reset", () => {
    const dir = tempDir("openclaw-seed-list-");
    writeTranscript(dir, "a.jsonl", [headerLine("a")]);
    writeTranscript(dir, "b.jsonl", [headerLine("b")]);
    writeTranscript(dir, "a.trajectory.jsonl", [headerLine("a")]);
    writeTranscript(dir, "c.deleted.jsonl", [headerLine("c")]);
    writeTranscript(dir, "d.reset.jsonl", [headerLine("d")]);
    writeTranscript(dir, "notes.txt", ["nope"]);
    expect(listLiveTranscripts(dir)).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("returns [] for a missing directory", () => {
    expect(listLiveTranscripts(path.join(os.tmpdir(), "openclaw-seed-does-not-exist-xyz"))).toEqual(
      [],
    );
  });
});

describe("runBackfillSeed", () => {
  it("merges live transcripts chronologically and dedups on re-run", () => {
    const transcriptsDir = tempDir("openclaw-seed-src-");
    const stateDir = tempDir("openclaw-seed-state-");
    // Two live files whose messages interleave in time; a trajectory decoy that must NOT seed.
    writeTranscript(transcriptsDir, "fileA.jsonl", [
      headerLine("fileA"),
      messageLine({ id: "a1", role: "user", text: "alpha", msgTs: 100 }),
      messageLine({ id: "a2", role: "assistant", text: "gamma", msgTs: 300 }),
    ]);
    writeTranscript(transcriptsDir, "fileB.jsonl", [
      headerLine("fileB"),
      messageLine({ id: "b1", role: "user", text: "beta", msgTs: 200 }),
    ]);
    writeTranscript(transcriptsDir, "fileA.trajectory.jsonl", [
      headerLine("fileA"),
      messageLine({ id: "x1", role: "user", text: "should-not-appear", msgTs: 999 }),
    ]);

    const first = runBackfillSeed({ agentId: AGENT_ID, env: env(stateDir), transcriptsDir });
    expect(first.sessionKey).toBe(SESSION_KEY);
    expect(first.filesProcessed).toBe(2);
    expect(first.inserted).toBe(3);

    const turns = getTurns({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) });
    // Cross-file chronological merge: 100 < 200 < 300 → alpha, beta, gamma in seq order.
    expect(turns.map((t) => t.content)).toEqual(["alpha", "beta", "gamma"]);
    expect(turns.map((t) => t.content)).not.toContain("should-not-appear");

    // Re-run is idempotent: completed files are skipped and nothing new is inserted.
    const second = runBackfillSeed({ agentId: AGENT_ID, env: env(stateDir), transcriptsDir });
    expect(second.inserted).toBe(0);
    expect(second.filesSkipped).toBe(2);
    expect(second.warnings).toEqual([]);
    const after = getTurns({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) });
    expect(after).toHaveLength(3);
  });

  it("warns when a later run seeds content older than already-backfilled history", () => {
    const transcriptsDir = tempDir("openclaw-seed-order-src-");
    const stateDir = tempDir("openclaw-seed-order-state-");
    // First run seeds a newer transcript; no warning.
    writeTranscript(transcriptsDir, "newer.jsonl", [
      headerLine("newer"),
      messageLine({ id: "n1", role: "user", text: "newer", msgTs: 500 }),
    ]);
    const first = runBackfillSeed({ agentId: AGENT_ID, env: env(stateDir), transcriptsDir });
    expect(first.warnings).toEqual([]);

    // An OLDER transcript dropped in later appends after existing turns (higher seqs) — surfaced.
    writeTranscript(transcriptsDir, "older.jsonl", [
      headerLine("older"),
      messageLine({ id: "o1", role: "user", text: "older", msgTs: 100 }),
    ]);
    const second = runBackfillSeed({ agentId: AGENT_ID, env: env(stateDir), transcriptsDir });
    expect(second.inserted).toBe(1);
    expect(second.warnings.length).toBeGreaterThan(0);
    expect(second.warnings[0]).toContain("older");
  });
});
