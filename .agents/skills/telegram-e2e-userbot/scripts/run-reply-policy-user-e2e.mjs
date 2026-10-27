#!/usr/bin/env node
// Opt-in, real Telegram Test Server regression. Not a per-PR unit test.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const rows = (file) =>
  fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const cells = ["message-tool-ordinary", "automatic-ordinary", "message-tool-send"];
let runToken;
const marker = (cell, kind) => "REPLY_POLICY_" + kind + "_" + cell + "_" + runToken;
if (process.argv[2] === "--target") {
  // The scenario command runs in the canonical runner's leased context. Do not
  // put its account identity in a model decision log or a public receipt.
  const config = read(process.env.OPENCLAW_CONFIG_PATH);
  const targets = config.channels.telegram.allowFrom;
  if (targets.length !== 1) {
    throw new Error("Expected exactly one leased QA sender");
  }
  save(process.env.E2E_REPLY_POLICY_TARGET_FILE, { target: String(targets[0]) });
} else if (process.argv[2] === "--verify") {
  const verdict = verify(process.argv[3], process.argv[4]);
  console.log(JSON.stringify(verdict));
  process.exitCode = verdict.fixtureFailures.length ? 2 : verdict.assertionFailures.length ? 1 : 0;
} else {
  const output = process.argv[2],
    gatewayPort = Number(process.argv[3]),
    mockPort = Number(process.argv[4]);
  if (
    !output ||
    !Number.isInteger(gatewayPort) ||
    !Number.isInteger(mockPort) ||
    gatewayPort === mockPort
  ) {
    throw new Error("Usage: run-reply-policy-user-e2e.mjs PRIVATE_OUTPUT GATEWAY_PORT MOCK_PORT");
  }
  const selectedCells = process.argv[5] ? [process.argv[5]] : cells;
  if (selectedCells.some((cell) => !cells.includes(cell))) {
    throw new Error("Unknown selected cell");
  }
  const root = path.resolve(output);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const verdicts = [];
  runToken = randomUUID().replaceAll("-", "").slice(0, 12);
  for (const cell of selectedCells) {
    const dir = path.join(root, cell);
    // Never overwrite a previous uncertain send, lease, or failed-run evidence.
    fs.mkdirSync(dir, { mode: 0o700 });
    const scenario = {
      actions: [
        {
          type: "command",
          argv: [process.execPath, fileURLToPath(import.meta.url), "--target"],
          cwd: "repo",
        },
        {
          type: "send",
          atMs: 1000,
          text: marker(cell, "REQUEST") + ". Delegate privately, yield, then finish.",
        },
        {
          type: "command",
          atMs: 70000,
          argv: [
            process.execPath,
            path.join(here, "reply-policy-checkpoint.mjs"),
            path.join(dir, "identity.json"),
            cell,
            runToken,
          ],
          cwd: "repo",
          timeoutMs: 24000,
        },
      ],
    };
    save(path.join(dir, "scenario.json"), scenario);
    const env = {
      ...process.env,
      E2E_REPLY_POLICY_CELL: cell,
      E2E_REPLY_POLICY_RUN: runToken,
      E2E_TELEGRAM_PROVIDER_API: "openai-responses",
      E2E_REPLY_POLICY_TARGET_FILE: path.join(dir, "target.private.json"),
      E2E_MOCK_SERVER_PATH: path.join(here, "reply-policy-mock.mjs"),
      E2E_ROOT_CONFIG_PATCH: JSON.stringify({
        messages: { visibleReplies: cell === "automatic-ordinary" ? "automatic" : "message_tool" },
        tools: { profile: "full", codeMode: false, toolSearch: false },
      }),
    };
    const stdout = fs.openSync(path.join(dir, "runner.stdout"), "wx", 0o600);
    const stderr = fs.openSync(path.join(dir, "runner.stderr"), "wx", 0o600);
    const start = Date.now();
    const run = spawnSync(
      process.execPath,
      [
        path.join(here, "run-mock-sut-user-e2e.mjs"),
        "--dm",
        "--gateway-port",
        String(gatewayPort),
        "--mock-port",
        String(mockPort),
        "--timeout-ms",
        "95000",
        "--scenario",
        path.join(dir, "scenario.json"),
        "--record",
        path.join(dir, "events.ndjson"),
        "--output",
        path.join(dir, "summary.json"),
      ],
      { env, stdio: ["ignore", stdout, stderr] },
    );
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    save(path.join(dir, "execution.json"), {
      source,
      runToken,
      exitCode: run.status,
      signal: run.signal,
      durationMs: Date.now() - start,
      finishedAt: Date.now(),
    });
    if (run.status !== 0 && !fs.existsSync(path.join(dir, "summary.json"))) {
      const failure = {
        cell,
        fixtureFailures: ["CANONICAL_RUNNER_FAILED"],
        assertionFailures: [],
        runnerExit: run.status,
      };
      save(path.join(dir, "verdict.json"), failure);
      verdicts.push(failure);
      break; // Do not rotate unchanged fixtures or credentials to hunt for green.
    }
    const verdict = verify(dir, cell);
    save(path.join(dir, "verdict.json"), verdict);
    verdicts.push(verdict);
    if (verdict.fixtureFailures.length) {
      break;
    }
    // A policy assertion failure does not prevent running the independent controls.
  }
  save(path.join(root, "verdicts.json"), verdicts);
  console.log(JSON.stringify(verdicts));
  process.exitCode = verdicts.some((v) => v.fixtureFailures.length)
    ? 2
    : verdicts.some((v) => v.assertionFailures.length)
      ? 1
      : 0;
}
function verify(dir, cell) {
  if (!cells.includes(cell)) {
    throw new Error("Unknown cell");
  }
  const summary = read(path.join(dir, "summary.json"));
  const model = rows(path.join(dir, "mock-openai-requests.ndjson"));
  const events = rows(path.join(dir, "events.ndjson"));
  const config = read(path.join(dir, "sut-config.json"));
  const report = read(path.join(dir, "runner.stdout"));
  const execution = read(path.join(dir, "execution.json"));
  runToken = execution.runToken;
  if (!/^[a-f0-9]{12}$/.test(runToken ?? "")) {
    throw new Error("Run marker missing");
  }
  const identity = fs.existsSync(path.join(dir, "identity.json"))
    ? read(path.join(dir, "identity.json"))
    : { complete: false };
  const fixtureFailures = [],
    assertionFailures = [];
  const require = (condition, code) => {
    if (!condition) {
      fixtureFailures.push(code);
    }
  };
  const check = (condition, code) => {
    if (!condition) {
      assertionFailures.push(code);
    }
  };
  const sent = events.find(
    (e) => e.kind === "action" && e.actionType === "send" && e.status === "completed",
  );
  require(Boolean(sent) && Boolean(summary.sentMessageId), "CONFIRMED_USER_SEND_MISSING");
  require(sent?.text ===
    marker(cell, "REQUEST") +
      ". Delegate privately, yield, then finish.", "USER_SEND_MARKER_MISMATCH");
  require(sent?.messageId === summary.sentMessageId, "USER_SEND_IDENTITY_MISMATCH");
  const observed = events.filter((e) => e.isSut && e.elapsedMs >= (sent?.elapsedMs ?? 0));
  const receipts = model.flatMap((row) => row.receipts ?? []);
  const accepted = receipts.filter((r) => r.tool === "sessions_spawn" && r.status === "accepted");
  const childRuns = new Set(accepted.map((r) => r.childRun));
  require(childRuns.size === 1 && !childRuns.has(undefined), "ACCEPTED_SPAWN_IDENTITY_MISSING");
  require(identity.complete &&
    childRuns.has(identity.identities?.childRun) &&
    accepted.some(
      (r) =>
        r.childSession === identity.identities?.childSession &&
        r.callId === identity.identities?.spawnCall,
    ), "INDEPENDENT_CHILD_AND_SETTLE_IDENTITIES_MISSING");
  require(receipts.some(
    (r) => r.tool === "sessions_yield" && r.status === "yielded",
  ), "ACCEPTED_YIELD_MISSING");
  require(model.some(
    (m) => m.kind === "child" && m.emittedText === marker(cell, "PRIVATE_CHILD"),
  ), "CHILD_OUTPUT_MISSING");
  const settled = model.filter((m) => m.kind.startsWith("settle-"));
  require(settled.length > 0 &&
    settled.every(
      (m) => m.receivedChildResult && childRuns.has(m.childRun),
    ), "PARENT_CHILD_RESULT_CORRELATION_MISSING");
  require(model
    .filter((m) => !["side", "child"].includes(m.kind))
    .every((m) => m.messageToolAvailable), "MESSAGE_TOOL_NOT_AVAILABLE");
  require(!model.some((m) => m.kind === "fixture-error"), "MOCK_FIXTURE_ERROR");
  const expected = cell === "automatic-ordinary" ? "automatic" : "message_tool";
  require(config.messages?.visibleReplies === expected, "EFFECTIVE_CONFIG_MISMATCH");
  require(summary.recordingComplete === true, "RECORDING_INCOMPLETE");
  require(report.scratchRemovedAfterExit === true &&
    execution.exitCode === 0, "RUNNER_CLEANUP_UNCONFIRMED");
  const logs = fs.readFileSync(path.join(dir, "gateway.log"), "utf8");
  const settleIds = [...new Set(logs.match(/announce:requester-settle:[^\s"\\]+/g) ?? [])];
  const settleIdentity = settleIds.map((id) => {
    const match = id.match(/:([0-9a-f-]{36}):yield-(\d+)(?::retry-(\d+))?$/);
    return {
      id: hash(id),
      childMatchesAccepted: Boolean(match) && childRuns.has(hash(match[1])),
      generation: match ? Number(match[2]) : undefined,
      retry: match?.[3] ? Number(match[3]) : 0,
    };
  });
  // The authoritative checkpoint owns identity proof; logs are additional diagnostics.
  const final = observed.filter(
    (e) => ["message", "edit"].includes(e.kind) && e.text?.includes(marker(cell, "FINAL")),
  );
  const ids = new Map();
  const alias = (id) => {
    if (!id) {
      return undefined;
    }
    if (!ids.has(id)) {
      ids.set(id, "message-" + (ids.size + 1));
    }
    return ids.get(id);
  };
  const firstSettleAt = settled[0]?.at;
  const apiLog = summary.scenario?.telegramApiRequestLog ?? [];
  require(apiLog
    .filter((r) => ["sendMessage", "editMessageText", "deleteMessage"].includes(r.method))
    .every((r) => r.chat === "private"), "OUTBOUND_CHAT_NOT_ORIGINAL_DM");
  const lastEventMs = Math.max(...events.map((e) => e.elapsedMs ?? 0));
  // Use the canonical recorder clock and the matched Gateway terminal receipt,
  // including genuine silence. Process exit and Gateway teardown are not observation.
  const recorderStartedAt = summary.scenario?.recorderReady?.startedAtUnixMs;
  const settlementEndedAt = identity.settlement?.endedAtUnixMs;
  require(Number.isFinite(recorderStartedAt) && recorderStartedAt > 0, "RECORDER_CLOCK_MISSING");
  require(Number.isFinite(settlementEndedAt) &&
    settlementEndedAt >= firstSettleAt, "SETTLEMENT_TERMINAL_CLOCK_MISSING");
  const observationStart = Math.max(
    settlementEndedAt,
    ...final.map((event) => recorderStartedAt + event.elapsedMs),
  );
  const observedRecoveryMs = recorderStartedAt + 95000 - observationStart;
  require(Number.isFinite(observedRecoveryMs) &&
    observedRecoveryMs >= 60000, "RECOVERY_OBSERVATION_WINDOW_TOO_SHORT");
  check(
    !observed.some((e) => e.text?.includes(marker(cell, "PRIVATE_CHILD"))),
    "PRIVATE_CHILD_RESULT_LEAKED",
  );
  check(!observed.some((e) => e.text?.trim() === "NO_REPLY"), "SILENCE_TOKEN_VISIBLE");
  // waiting-status.ts emits this nonterminal status when sessions_yield leaves
  // the initial request otherwise silent. It is progress, not a second final.
  const isProgress = (e) =>
    /^Working(?:\n(?:Subagent|Message) \([a-z]+\))*$/.test(e.text ?? "") ||
    e.text === "I’m continuing this work and will send the result when it is ready.";
  const unexpected = observed.filter(
    (e) =>
      ["message", "edit"].includes(e.kind) &&
      !e.text?.includes(marker(cell, "FINAL")) &&
      !isProgress(e),
  );
  check(unexpected.length === 0, "UNEXPECTED_VISIBLE_REPLY");
  const finalIds = new Set(final.map((e) => e.messageId));
  if (cell === "message-tool-ordinary") {
    require(settled.some(
      (m) => m.emittedText === marker(cell, "FINAL"),
    ), "ORDINARY_FINAL_NOT_EMITTED");
    require(!model.some((m) => m.emittedTool === "message"), "NEGATIVE_CELL_CALLED_MESSAGE");
    check(final.length === 0, "TOOL_ONLY_ORDINARY_FINAL_VISIBLE");
  } else {
    check(
      finalIds.size === 1 &&
        observed.filter((e) => e.kind === "message" && finalIds.has(e.messageId)).length === 1,
      "EXPECTED_EXACTLY_ONE_FINAL",
    );
    check(!observed.some((e) => e.kind === "delete" && finalIds.has(e.messageId)), "FINAL_DELETED");
    const finalState = observed.findLast(
      (e) => ["message", "edit"].includes(e.kind) && finalIds.has(e.messageId),
    );
    check(finalState?.text?.includes(marker(cell, "FINAL")) === true, "FINAL_NOT_RETAINED");
    if (cell === "message-tool-send") {
      require(model.some(
        (m) => m.emittedTool === "message" && m.messageFinal === false,
      ), "EXPLICIT_SEND_CONTINUATION_NOT_REQUESTED");
      require(receipts.some(
        (r) => r.tool === "message" && (r.ok === true || r.status === "sent"),
      ), "REAL_MESSAGE_SEND_NOT_ACCEPTED");
      require(settled.some((m) => m.emittedText === "NO_REPLY"), "POST_SEND_NO_REPLY_MISSING");
    } else {
      require(settled.some(
        (m) => m.emittedText === marker(cell, "FINAL"),
      ), "AUTOMATIC_FINAL_NOT_EMITTED");
    }
  }
  const timeline = observed.map((e) => ({
    elapsedMs: e.elapsedMs,
    kind: e.kind,
    id: alias(e.messageId),
    content: e.text?.includes(marker(cell, "FINAL"))
      ? "FINAL"
      : e.text?.includes(marker(cell, "PRIVATE_CHILD"))
        ? "PRIVATE_CHILD"
        : isProgress(e)
          ? "progress"
          : e.text
            ? "other:" + e.text.length
            : undefined,
  }));
  return {
    cell,
    source: execution.source,
    requestedVisibleReplies: expected,
    effectiveVisibleReplies: config.messages.visibleReplies,
    fixtureFailures,
    assertionFailures,
    readiness: read(path.join(dir, "readiness.json")),
    cleanup: { canonicalFinalizerCompleted: report.scratchRemovedAfterExit },
    recordingComplete: summary.recordingComplete,
    durationMs: execution.durationMs,
    lastEventMs,
    sent: { confirmed: Boolean(sent), elapsedMs: sent?.elapsedMs },
    model,
    identity,
    settleIdentity,
    timeline,
    finalMessages: final.filter((e) => e.kind === "message").length,
    finalEdits: final.filter((e) => e.kind === "edit").length,
    unexpectedVisibleReplies: unexpected.length,
    immediateFinalEvents: final.filter((e) => e.elapsedMs < (sent?.elapsedMs ?? 0) + 30000).length,
    laterFinalEvents: final.filter((e) => e.elapsedMs >= (sent?.elapsedMs ?? 0) + 30000).length,
    botEventCounts: Object.fromEntries(
      [...new Set(observed.map((e) => e.kind))].map((kind) => [
        kind,
        observed.filter((e) => e.kind === kind).length,
      ]),
    ),
    apiLog,
    observationAfterFirstSettleMs: execution.finishedAt - firstSettleAt,
    observedRecoveryMs,
    laterModelRequests: model.filter((m) => m.at >= firstSettleAt + 30000).length,
  };
}
