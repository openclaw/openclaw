/**
 * End-to-end coverage for native compaction: a real `claude` subprocess, a real
 * compaction, the real lifecycle parser shipped by the Anthropic extension, and
 * the real no-output watchdog on the real clock. No fake timers, no injected
 * compaction getter, no hand-written records.
 *
 * Claude Code goes completely silent while it compacts. The silence is what kills
 * the turn on current main, so this case measures the silence it actually observes
 * and fails if that silence did not exceed the configured no-output budget. A
 * compaction that returned instantly would make the assertion vacuous.
 *
 * Opt in with:
 *   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CLAUDE_COMPACTION=1 \
 *     pnpm test:live -- src/agents/cli-runner/execute.compaction-watchdog.claude.live.test.ts
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CLAUDE_COMPACTION === "1";
const CLAUDE_BIN = process.env.OPENCLAW_LIVE_CLAUDE_BIN?.trim() || "claude";
const CLAUDE_MODEL = process.env.OPENCLAW_LIVE_CLAUDE_MODEL?.trim() || "claude-haiku-4-5-20251001";
/**
 * Production resolves this to 180s for a resumed turn. A real compaction is
 * seconds, not minutes, so the budget is compressed to keep the case runnable;
 * the seam under test is the same one either way.
 */
const NO_OUTPUT_TIMEOUT_MS = 5_000;

function claudeArgs(extra: string[]): string[] {
  return ["-p", ...extra, "--output-format", "stream-json", "--verbose", "--model", CLAUDE_MODEL];
}

/** Seeds a real session with enough transcript that compaction has work to do. */
async function seedSession(cwd: string, prompt: string): Promise<string> {
  const { stdout, code, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, claudeArgs([prompt]), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (exit) => {
      resolve({ stdout: out, stderr: err, code: exit });
    });
  });
  expect(code, `seed run failed: ${stderr}`).toBe(0);
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    const sessionId = (parsed as { session_id?: unknown }).session_id;
    if (typeof sessionId === "string") {
      return sessionId;
    }
  }
  throw new Error("seed run produced no session_id");
}

describe.skipIf(!LIVE)("claude cli compaction against the live no-output watchdog", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps the turn alive across a real compaction that outlasts the budget", async () => {
    // Resolved the way production resolves it, from the registered backend, so
    // this covers the parser the Anthropic plugin actually ships rather than a
    // copy of it. Reaching into extension sources from core is a graph boundary
    // violation; `resolveCliBackendConfig` is the supported seam.
    const claudeBackend = resolveCliBackendConfig("claude-cli");
    const parseJsonlLifecycleEvent = claudeBackend?.parseJsonlLifecycleEvent;
    expect(
      parseJsonlLifecycleEvent,
      "registered claude-cli backend declares no parseJsonlLifecycleEvent",
    ).toBeTypeOf("function");
    const cwd = tempDirs.make("openclaw-claude-compaction-e2e-");
    {
      const context = readFileSync(
        new URL("../../logging/diagnostic-run-activity.ts", import.meta.url),
        "utf8",
      );
      const sessionId = await seedSession(
        cwd,
        `Summarize the purpose of this module in one sentence.\n\n${context.slice(0, 24_000)}`,
      );

      const runContext = buildPreparedCliRunContext({
        runId: "compaction-live-e2e",
        sessionId: "compaction-live-e2e-session",
        sessionKey: "agent:main:compaction-live-e2e",
        agentId: "main",
        config: { plugins: { enabled: false } },
        timeoutMs: 600_000,
        backend: {
          command: process.execPath,
          sessionMode: "none",
          reliability: {
            watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
          },
        },
      });
      runContext.backendResolved.bundleMcp = false;
      runContext.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;

      const trace: Array<{ atMs: number; gapMs: number; line: string }> = [];
      let longestSilenceMs = 0;
      runContext.executionTarget = {
        kind: "plugin",
        async *execute(execution) {
          const child = spawn(CLAUDE_BIN, claudeArgs(["/compact", "--resume", sessionId]), {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const startedAt = Date.now();
          let previousAt = startedAt;
          // A watchdog abort must end this iterator and reap the child. Killing the
          // child closes stdout, which ends the line reader below. Without it the
          // run's own failure is masked by a plugin-close timeout and a real claude
          // process is left behind.
          const abortSignal = execution.abortSignal;
          const onAbort = () => {
            child.kill("SIGKILL");
          };
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          const lines = createInterface({
            input: child.stdout,
            crlfDelay: Number.POSITIVE_INFINITY,
          });
          try {
            for await (const line of lines) {
              if (abortSignal?.aborted) {
                return;
              }
              if (!line.trim()) {
                continue;
              }
              const at = Date.now();
              const gapMs = at - previousAt;
              previousAt = at;
              longestSilenceMs = Math.max(longestSilenceMs, gapMs);
              trace.push({ atMs: at - startedAt, gapMs, line: line.slice(0, 96) });
              yield JSON.parse(line) as Record<string, unknown>;
            }
            yield { type: "result", subtype: "success", result: "compaction survived" };
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
            lines.close();
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }
        },
      };

      let result: Awaited<ReturnType<typeof executePreparedCliRun>> | undefined;
      let runError: Error | undefined;
      try {
        result = await wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(runContext);
      } catch (error) {
        runError = error instanceof Error ? error : new Error(String(error));
      }

      // The trace is the evidence, so it is printed for a killed turn too.
      for (const row of trace) {
        console.info(`[live-compaction] +${row.atMs}ms gap=${row.gapMs}ms ${row.line}`);
      }
      console.info(`[live-compaction] longest silence ${longestSilenceMs}ms`);
      console.info(
        `[live-compaction] budget ${NO_OUTPUT_TIMEOUT_MS}ms outcome=${
          runError ? `rejected: ${runError.message}` : "resolved"
        }`,
      );
      if (runError) {
        throw runError;
      }

      // Without a real silence longer than the budget this case proves nothing.
      expect(longestSilenceMs).toBeGreaterThan(NO_OUTPUT_TIMEOUT_MS);
      expect(trace.some((row) => row.line.includes('"status":"compacting"'))).toBe(true);
      expect(trace.some((row) => row.line.includes('"compact_result":"success"'))).toBe(true);
      expect(result).toMatchObject({ text: "compaction survived" });
    }
  }, 900_000);
});
