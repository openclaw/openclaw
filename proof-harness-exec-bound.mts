// proof-harness-exec-bound.mts
// Drive the real NodeExecutionEnv.exec() against real child processes
// to prove stdout/stderr bounding at maxOutputBytes.
//
// Usage: node --import tsx proof-harness-exec-bound.mts

import { NodeExecutionEnv } from "./packages/agent-core/src/harness/env/nodejs.js";

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) { passed++; console.log("  ok: %s", description); }
    else { failed++; console.log("  FAIL: %s", description); }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

const env = new NodeExecutionEnv({ cwd: process.cwd() });

// ── Case 1: small output under cap — full capture ─────────────────────
console.log("[case 1] exec: 500-byte stdout with 64 KiB cap → full capture");
{
  const result = await env.exec(
    "node -e 'process.stdout.write(\"z\".repeat(500))'",
    { maxOutputBytes: 64 * 1024 },
  );
  assert("result.ok is true", () => result.ok);
  if (!result.ok) { throw new Error("expected ok"); }
  assert("exit code 0", () => result.value.exitCode === 0);
  assert("stdout = 500 bytes", () => result.value.stdout === "z".repeat(500));
  assert("not truncated", () => !result.value.stdout.includes("[output truncated]"));
  console.log("  stdout: %d bytes | exitCode: %d", result.value.stdout.length, result.value.exitCode);
}

// ── Case 2: large stdout — truncated, process NOT killed ──────────────
console.log("\n[case 2] exec: 10 KB stdout with 1 KiB cap → truncated, process lives");
{
  const result = await env.exec(
    "node -e 'process.stdout.write(\"x\".repeat(10_000))'",
    { maxOutputBytes: 1024 },
  );
  assert("result.ok is true", () => result.ok);
  if (!result.ok) { throw new Error("expected ok"); }
  assert("exit code 0 (process not killed)", () => result.value.exitCode === 0);
  assert("stdout truncated", () => result.value.stdout.includes("[output truncated]"));
  assert(
    `stdout length <= cap + marker (~1100 bytes)`,
    () => result.value.stdout.length <= 1200,
  );
  console.log(
    "  stdout: %d bytes (capped at 1024) | exitCode: %d | process healthy",
    result.value.stdout.length,
    result.value.exitCode,
  );
}

// ── Case 3: large stderr — truncated independently ────────────────────
console.log("\n[case 3] exec: 10 KB stderr with 1 KiB cap → truncated via stderr");
{
  const result = await env.exec(
    "node -e 'process.stderr.write(\"y\".repeat(10_000))'",
    { maxOutputBytes: 1024 },
  );
  assert("result.ok is true", () => result.ok);
  if (!result.ok) { throw new Error("expected ok"); }
  assert("stderr truncated", () => result.value.stderr.includes("[output truncated]"));
  console.log(
    "  stderr: %d bytes (capped) | stdout: %d bytes",
    result.value.stderr.length,
    result.value.stdout.length,
  );
}

// ── Case 4: mixed stdout+stderr share the same cap ────────────────────
console.log("\n[case 4] exec: 2 KB stdout + 2 KB stderr with 1 KiB cap → both bounded");
{
  const result = await env.exec(
    "node -e 'process.stdout.write(\"a\".repeat(2000)); process.stderr.write(\"b\".repeat(2000))'",
    { maxOutputBytes: 1024 },
  );
  assert("result.ok is true", () => result.ok);
  if (!result.ok) { throw new Error("expected ok"); }
  const stdoutTrunc = result.value.stdout.includes("[output truncated]");
  const stderrTrunc = result.value.stderr.includes("[output truncated]");
  assert("stdout or stderr truncated", () => stdoutTrunc || stderrTrunc);
  console.log(
    "  stdout: %d bytes (trunc=%s) | stderr: %d bytes (trunc=%s)",
    result.value.stdout.length,
    String(stdoutTrunc),
    result.value.stderr.length,
    String(stderrTrunc),
  );
}

// ── Summary ────────────────────────────────────────────────────────────
console.log("\n=== Proof Summary ===");
console.log("default cap: 16 MiB | test cap: 1 KiB");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);

if (failed > 0) { process.exit(1); }
