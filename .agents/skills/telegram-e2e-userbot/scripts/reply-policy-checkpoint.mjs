// Runs as a scenario command under the canonical runner's live lease.
// Query the real Gateway; never infer child/settle identity from cached mock state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [output, cell, runToken] = process.argv.slice(2);
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const marker = (kind) => "REPLY_POLICY_" + kind + "_" + cell + "_" + runToken;
const text = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
const runId = (message) => message?.["__openclaw"]?.runId ?? message?.runId;
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const port = config.gateway?.port;
const facts = { complete: false, checks: {} };
const require = (condition, code) => {
  facts.checks[code] = Boolean(condition);
  if (!condition) {
    throw new Error(code);
  }
};
function rpc(method, params) {
  const raw = execFileSync(
    process.execPath,
    [
      path.resolve("dist/entry.js"),
      "gateway",
      "call",
      method,
      "--port",
      String(port),
      "--expect-url",
      "ws://127.0.0.1:" + port,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      "10000",
    ],
    {
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(raw);
}
try {
  require(config.gateway.bind === "loopback" &&
    config.gateway.auth.mode === "none", "ISOLATED_GATEWAY");
  const listed = rpc("sessions.list", { limit: 10, excludeSubagents: true });
  const parents = [];
  for (const row of listed.sessions ?? []) {
    const history = rpc("sessions.get", { key: row.key, limit: 100 });
    if (history.messages?.some((m) => m.role === "user" && text(m).includes(marker("REQUEST")))) {
      parents.push({ row, history });
    }
  }
  require(parents.length === 1, "ONE_REQUESTER_SESSION");
  const { row, history } = parents[0];
  const parent = history.messages;
  const calls = parent.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content.filter((p) => p.type === "toolCall")
      : [],
  );
  const spawns = calls.filter((c) => c.name === "sessions_spawn");
  require(spawns.length === 1, "ONE_SPAWN_CALL");
  const spawn = spawns[0];
  require(spawn.arguments.context === "isolated" &&
    spawn.arguments.completionTarget === "parent", "PRIVATE_ISOLATED_SPAWN");
  const outputs = parent.filter((m) => m.role === "toolResult" && m.toolCallId === spawn.id);
  require(outputs.length === 1 && outputs[0].isError === false, "SPAWN_RECEIPT_CORRELATED");
  const accepted = JSON.parse(text(outputs[0]));
  require(accepted.status === "accepted" &&
    Boolean(accepted.runId) &&
    Boolean(accepted.childSessionKey), "SPAWN_ACCEPTED");
  const yieldCalls = calls.filter((c) => c.name === "sessions_yield");
  require(yieldCalls.length === 1, "ONE_YIELD_CALL");
  const yields = parent.filter((m) => m.role === "toolResult" && m.toolCallId === yieldCalls[0].id);
  require(yields.length === 1 &&
    yields[0].isError === false &&
    JSON.parse(text(yields[0])).status === "yielded", "YIELD_RECEIPT_CORRELATED");
  const before = rpc("sessions.describe", { key: accepted.childSessionKey }).session;
  const child = rpc("sessions.get", { key: accepted.childSessionKey, limit: 100 });
  const after = rpc("sessions.describe", { key: accepted.childSessionKey }).session;
  require(before?.key === accepted.childSessionKey &&
    Boolean(before.sessionId) &&
    before.sessionId === after?.sessionId, "CHILD_CANONICAL_IDENTITY_STABLE");
  const finals =
    child.messages?.filter(
      (m) => m.role === "assistant" && text(m).trim() === marker("PRIVATE_CHILD"),
    ) ?? [];
  require(finals.length === 1 &&
    runId(finals[0]) === accepted.runId, "CHILD_FINAL_RUN_MATCHES_ACCEPTED");
  const parentFinal = parent.filter(
    (m) =>
      m.role === "assistant" &&
      text(m).trim() === (cell === "message-tool-send" ? "NO_REPLY" : marker("FINAL")),
  );
  const prefix = "announce:requester-settle:main:" + row.key + ":" + accepted.runId + ":yield-";
  const settlement = parentFinal.filter((m) => runId(m)?.startsWith(prefix));
  require(settlement.length > 0, "PARENT_FINAL_FROM_MATCHED_REQUESTER_SETTLE");
  require(parent.some((m) =>
    text(m).includes(marker("PRIVATE_CHILD")),
  ), "CHILD_RESULT_IN_PARENT_HISTORY");
  const terminalRuns = [...new Set(settlement.map((m) => runId(m)))];
  const terminal = terminalRuns.map((id) => rpc("agent.wait", { runId: id, timeoutMs: 1000 }));
  require(terminal.every(
    (outcome, index) =>
      outcome.runId === terminalRuns[index] &&
      outcome.status === "ok" &&
      !outcome.yielded &&
      Number.isFinite(outcome.endedAt) &&
      outcome.endedAt > 0,
  ), "MATCHED_SETTLEMENT_TERMINAL");
  facts.settlement = {
    endedAtUnixMs: Math.max(...terminal.map((outcome) => outcome.endedAt)),
    terminalRunCount: terminal.length,
    statuses: terminal.map((outcome) => outcome.status),
  };
  facts.identities = {
    parent: hash(row.key),
    childSession: hash(accepted.childSessionKey),
    childCanonicalSession: hash(before.sessionId),
    childRun: hash(accepted.runId),
    spawnCall: hash(spawn.id.split("|")[0]),
    yieldCall: hash(yieldCalls[0].id.split("|")[0]),
    childFinal: hash(finals[0]["__openclaw"]?.id),
    settleRuns: [...new Set(settlement.map((m) => hash(runId(m))))],
  };
  facts.complete = true;
} catch (error) {
  facts.error = /^[A-Z_]+$/.test(error.message) ? error.message : "CHECKPOINT_RPC_OR_SHAPE_FAILURE";
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(facts, null, 2) + "\n", { mode: 0o600 });
}
