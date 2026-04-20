#!/usr/bin/env node
/**
 * dispatch_acp.mjs — ACP gateway dispatcher for eng-codex
 *
 * Protocol:
 *   stdin  → JSON: { schema:1, prompt, agentId, timeoutSec, runId? }
 *   stdout → progress lines + one sentinel:
 *            @@DISPATCH_RESULT@@ {"schema":1,"ok":true|false,...}
 *
 * Exit codes:
 *   0 = ok:true
 *   1 = task-level error (agent_error, auth, preflight, transport, timeout)
 *   2 = config error (not_implemented, bad stdin)
 *   143 = SIGTERM (stopped)
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ── Sentinel ─────────────────────────────────────────────────────────────────
const SENTINEL = "@@DISPATCH_RESULT@@";

function emitResult(result) {
  process.stdout.write(`${SENTINEL} ${JSON.stringify(result)}\n`);
}

// ── Auth preflight ────────────────────────────────────────────────────────────
const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
if (!gatewayToken) {
  emitResult({
    schema: 1,
    ok: false,
    errorCode: "auth",
    error: "OPENCLAW_GATEWAY_TOKEN is not set — cannot dispatch to ACP gateway",
  });
  process.exit(1);
}

// ── Read stdin JSON ───────────────────────────────────────────────────────────
let inputJson = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  inputJson += chunk;
}

let input;
try {
  input = JSON.parse(inputJson.trim());
} catch {
  emitResult({
    schema: 1,
    ok: false,
    errorCode: "preflight",
    error: `Invalid JSON on stdin: ${inputJson.slice(0, 200)}`,
  });
  process.exit(2);
}

const { prompt, agentId = "eng", timeoutSec = 600 } = input;
if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
  emitResult({
    schema: 1,
    ok: false,
    errorCode: "preflight",
    error: "stdin.prompt is empty or missing",
  });
  process.exit(2);
}

const runId =
  typeof input.runId === "string" && input.runId.trim() ? input.runId.trim() : randomUUID();

process.stderr.write(`[dispatch_acp] runId=${runId} agentId=${agentId} timeout=${timeoutSec}s\n`);

// ── Spawn openclaw agent ──────────────────────────────────────────────────────
// Use spawn (no shell) so large prompts and shell metacharacters are safe.
const args = [
  "agent",
  "--message",
  prompt.trim(),
  "--agent",
  agentId,
  "--json",
  "--timeout",
  String(timeoutSec),
];

let child = null;
let stopped = false;

// SIGTERM handler: close gracefully, emit stopped
process.on("SIGTERM", () => {
  stopped = true;
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  emitResult({
    schema: 1,
    ok: false,
    errorCode: "stopped",
    runId,
    error: "dispatcher received SIGTERM",
  });
  process.exit(143);
});

child = spawn("openclaw", args, {
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
  process.stderr.write(chunk);
});

const exitCode = await new Promise((resolve) => {
  child.on("close", resolve);
  child.on("error", (err) => {
    stderrBuf += `\nspawn error: ${err.message}`;
    resolve(1);
  });
});

if (stopped) {
  process.exit(143);
}

// ── Parse CLI output ──────────────────────────────────────────────────────────
let parsedResult = null;
try {
  // openclaw agent --json outputs a JSON object on the last non-empty line
  const lines = stdoutBuf.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      parsedResult = JSON.parse(line);
      break;
    }
  }
} catch {
  // non-JSON output — treat as agent_error below
}

if (exitCode === 124 || exitCode === null) {
  // timeout(1) sends SIGKILL and exits 124; Node spawn returns null on signal
  emitResult({
    schema: 1,
    ok: false,
    errorCode: "timeout",
    runId,
    error: `Agent timed out after ${timeoutSec}s`,
  });
  process.exit(1);
}

if (exitCode !== 0 || !parsedResult) {
  const errorText = (stderrBuf || stdoutBuf).trim().slice(0, 500);
  // Classify common errors
  let errorCode = "agent_error";
  if (/auth|token|unauthorized|401/i.test(errorText)) errorCode = "auth";
  else if (/connect|ECONNREFUSED|WebSocket|transport/i.test(errorText)) errorCode = "transport";

  emitResult({
    schema: 1,
    ok: false,
    errorCode,
    runId,
    error: errorText || `openclaw agent exited with code ${exitCode}`,
  });
  process.exit(1);
}

emitResult({
  schema: 1,
  ok: true,
  runId,
  agentId,
  summary: parsedResult?.summary ?? parsedResult?.result?.payloads?.[0]?.text?.slice(0, 200) ?? "",
  meta: parsedResult?.meta,
});
process.exit(0);
