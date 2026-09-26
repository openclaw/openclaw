/**
 * Live coverage for the producer half of the native compaction seam.
 *
 * `parseClaudeCliJsonlLifecycleEvent` is the only thing that turns Claude Code's
 * own records into compaction lifecycle events, and every other test in this repo
 * feeds it records written by hand. This case runs a real `claude` session through
 * a real compaction and asserts the real records still map to start and end, so a
 * silent change to Claude Code's status vocabulary fails here instead of quietly
 * disarming the CLI no-output watchdog in production.
 *
 * Opt in with:
 *   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CLAUDE_COMPACTION=1 \
 *     pnpm test:live -- extensions/anthropic/cli-output.compaction.live.test.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CLAUDE_COMPACTION === "1";
const CLAUDE_BIN = process.env.OPENCLAW_LIVE_CLAUDE_BIN?.trim() || "claude";
// A compaction summary is model work; the cheapest available model is enough.
const CLAUDE_MODEL = process.env.OPENCLAW_LIVE_CLAUDE_MODEL?.trim() || "claude-haiku-4-5-20251001";

type ClaudeRun = { stdout: string; stderr: string; code: number | null };

/** Runs one real print-mode Claude turn with the stream-json output production reads. */
async function runClaude(args: string[], cwd: string): Promise<ClaudeRun> {
  return await new Promise<ClaudeRun>((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      ["-p", ...args, "--output-format", "stream-json", "--verbose", "--model", CLAUDE_MODEL],
      // stdin stays closed: print mode otherwise waits on it before starting.
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

function readSessionId(stdout: string): string {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { session_id?: unknown }).session_id === "string"
    ) {
      return (parsed as { session_id: string }).session_id;
    }
  }
  throw new Error("live claude run produced no session_id");
}

/**
 * Projects a real transcript through the parser the backend registers, dropping
 * non-lifecycle lines. Going through the backend rather than the bare export also
 * proves the plugin still advertises the parser at all.
 */
function lifecycleEvents(stdout: string) {
  const backend = buildAnthropicCliBackend();
  const ctx = { backendId: backend.id, backend: backend.config };
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => backend.parseJsonlLifecycleEvent?.(line, ctx) ?? null)
    .filter((event) => event !== null);
}

describe.skipIf(!LIVE)("claude cli native compaction records", () => {
  it("maps a real compaction to lifecycle start and end events", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-compaction-live-"));
    try {
      const seed = await runClaude(["Reply with exactly: ok"], cwd);
      expect(seed.code, `seed run failed: ${seed.stderr}`).toBe(0);
      const sessionId = readSessionId(seed.stdout);
      // A seeded turn has content to compact, so /compact does real work here.
      expect(lifecycleEvents(seed.stdout)).toEqual([]);

      const compaction = await runClaude(["/compact", "--resume", sessionId], cwd);
      expect(compaction.code, `compaction run failed: ${compaction.stderr}`).toBe(0);

      expect(lifecycleEvents(compaction.stdout)).toEqual([
        { kind: "compaction", phase: "start" },
        { kind: "compaction", phase: "end", completed: true },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 600_000);
});
