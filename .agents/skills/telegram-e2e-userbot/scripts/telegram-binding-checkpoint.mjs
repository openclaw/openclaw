import { execFileSync } from "node:child_process";
// Private scenario checkpoint: native readiness precedes authoritative installed-Gateway RPCs.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [phase, parentKey, runId, output, sourceRoot, baselinePath] = process.argv.slice(2);
const conditionBudgetMs = 90000;
const verificationBudgetMs = 60000;
const beganAt = Date.now();
let deadline = performance.now() + conditionBudgetMs;
let budgetPhase = "native-readiness";
let stage = "input-admission";
let attempts = 0;
let lastMissing = [];
let rpcFacts;
class CheckpointFailure extends Error {
  constructor(code, facts = {}) {
    super(code);
    this.facts = facts;
  }
}
const fail = (code, facts) => {
  throw new CheckpointFailure(code, facts);
};
function save(path, value) {
  const temporary = `${path}.next`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
function diagnostic(status, facts = {}) {
  save(`${output}.diagnostic.json`, {
    status,
    phase,
    stage,
    attempts,
    elapsedMs: Date.now() - beganAt,
    conditionBudgetMs,
    verificationBudgetMs,
    budgetPhase,
    missing: lastMissing,
    ...(rpcFacts ? { rpc: rpcFacts } : {}),
    ...facts,
  });
}
const safeAtom = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
function text(message) {
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
    : typeof message?.content === "string"
      ? message.content
      : "";
}
function currentText(message) {
  const value = text(message);
  if (
    value.includes("[Chat messages since your last reply - for context]") ||
    value.includes("[Recent chat messages - for context]")
  ) {
    const boundary = "\n[Current message - respond to this]\n";
    const index = value.lastIndexOf(boundary);
    return index < 0 ? "" : value.slice(index + boundary.length);
  }
  return value;
}
function ordinaryUser(message) {
  return (
    message?.role === "user" &&
    message.runtimeContextCarrier !== true &&
    !(
      text(message).startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n") &&
      text(message).endsWith("\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
    )
  );
}
const hasMarker = (message, marker) =>
  new RegExp(`(^|[^A-Za-z0-9_-])${marker}($|[^A-Za-z0-9_-])`, "u").test(currentText(message));
const messageFact = ({ __openclaw: metadata, timestamp }) => ({
  id: metadata?.id,
  seq: metadata?.seq,
  timestamp,
});
const remaining = () => Math.floor(deadline - performance.now());

async function main() {
  if (
    !["spawn", "before", "after"].includes(phase) ||
    !/^[a-z][a-z0-9_-]{0,46}$/.test(runId ?? "") ||
    !/^agent:main:telegram:group:-\d+:topic:[1-9]\d*$/.test(parentKey ?? "") ||
    !isAbsolute(output ?? "") ||
    !isAbsolute(sourceRoot ?? "") ||
    realpathSync(process.cwd()) !== realpathSync(sourceRoot)
  ) {
    fail("INVALID_CHECKPOINT_INPUTS");
  }
  if (existsSync(output)) {
    fail("CHECKPOINT_OUTPUT_ALREADY_EXISTS");
  }
  diagnostic("running");
  stage = "installed-provenance";
  const provenanceBytes = readFileSync(join(dirname(output), "upgrade-input.json"));
  const upgrade = JSON.parse(provenanceBytes);
  const input = phase === "spawn" ? upgrade.baseline : upgrade.candidate;
  const installedRoot = realpathSync(upgrade.packageRoot);
  const installed = JSON.parse(
    readFileSync(join(dirname(output), "installed-runtime.json"), "utf8"),
  );
  const entryDigest = input.runtimeHashes["dist/entry.js"];
  function assertInstalled() {
    if (
      installed.packageRoot !== installedRoot ||
      installed.build.buildId !== input.buildInfo.buildId ||
      JSON.parse(readFileSync(join(installedRoot, "dist/build-info.json"), "utf8")).buildId !==
        input.buildInfo.buildId ||
      Object.entries(input.runtimeHashes).some(
        ([file, digest]) =>
          createHash("sha256")
            .update(readFileSync(join(installedRoot, file)))
            .digest("hex") !== digest,
      )
    ) {
      fail("INSTALLED_RUNTIME_CHANGED_DURING_CHECKPOINT");
    }
  }
  assertInstalled();
  stage = "owned-runtime-admission";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!configPath || !stateDir || !process.env.TELEGRAM_E2E_TEST_API_ROOT) {
    fail("RUNNER_CONTEXT_MISSING");
  }
  const ownedRoot = dirname(resolve(configPath));
  if (
    !ownedRoot.split("/").at(-1).startsWith("openclaw-tg-user-mock-sut-") ||
    resolve(stateDir) !== resolve(ownedRoot, "state")
  ) {
    fail("RUNNER_STATE_OWNER_MISMATCH");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const port = config.gateway?.port;
  if (
    config.gateway?.bind !== "loopback" ||
    config.gateway?.auth?.mode !== "none" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    fail("ISOLATED_LOOPBACK_GATEWAY_REQUIRED");
  }
  stage = "compiled-diagnostic-redactor";
  const { redactSensitiveText } = await import(
    pathToFileURL(resolve(installedRoot, "dist/plugin-sdk/logging-core.js"))
  );
  const scrub = (value) =>
    redactSensitiveText(String(value ?? ""), { mode: "tools" })
      .replaceAll(parentKey, "<parent-session>")
      .replaceAll(ownedRoot, "<owned-root>")
      .replaceAll(sourceRoot, "<source-root>")
      .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gu, "<url>")
      .slice(-4000);
  const runtime = {
    sourceRoot: realpathSync(sourceRoot),
    nodeExecutable: realpathSync(process.execPath),
    stateDir: realpathSync(stateDir),
    mode: "compiled",
    entrySha256: entryDigest,
    installedCommit: installed.build.commit,
    installedRoot,
    artifactManifestSha256: createHash("sha256").update(provenanceBytes).digest("hex"),
    fixtureSha256: createHash("sha256")
      .update(readFileSync(resolve(sourceRoot, "scripts/e2e/lib/telegram-binding-scenario.mjs")))
      .digest("hex"),
  };
  const baseline =
    phase === "spawn"
      ? undefined
      : (() => {
          if (!isAbsolute(baselinePath ?? "")) {
            fail("PREVIOUS_PHASE_CHECKPOINT_REQUIRED");
          }
          const value = JSON.parse(readFileSync(baselinePath, "utf8"));
          if (
            value.status !== "READ_CHECKPOINT_ONLY" ||
            value.phase !== (phase === "before" ? "spawn" : "before") ||
            value.runId !== runId ||
            value.parentKey !== parentKey ||
            [
              "sourceRoot",
              "nodeExecutable",
              "stateDir",
              "mode",
              "installedRoot",
              "artifactManifestSha256",
              "fixtureSha256",
            ].some((key) => value.runtime?.[key] !== runtime[key]) ||
            value.runtime?.installedCommit !==
              (phase === "before"
                ? upgrade.baseline.buildInfo.commit
                : upgrade.candidate.buildInfo.commit)
          ) {
            fail("PREVIOUS_PHASE_IDENTITY_OR_RUNTIME_MISMATCH");
          }
          return value;
        })();
  const expectedArgs = {
    task: `TELEGRAM_BINDING_CHILD_${runId}. Reply with the child fixture acknowledgment.`,
    taskName: `telegram-binding-${runId}`,
    runtime: "subagent",
    thread: true,
    mode: "session",
    cleanup: "keep",
    context: "isolated",
  };
  const fixture = JSON.parse(readFileSync(join(dirname(output), "fixture.json"), "utf8"));
  if (
    fixture.runId !== runId ||
    parentKey !== `agent:main:telegram:group:${fixture.chatId}:topic:${fixture.topicId}` ||
    resolve(fixture.eventsPath) !== join(dirname(output), "events.ndjson")
  ) {
    fail("FIXTURE_SCOPE_MISMATCH");
  }
  function rpc(label, method, params) {
    stage = label;
    const left = remaining();
    if (left < 1000) {
      fail("VERIFICATION_DEADLINE", { deadlineAtRpc: true });
    }
    const timeoutMs = Math.min(15000, left - 250);
    rpcFacts = { method, timeoutMs, processTimeoutMs: left, status: "running" };
    diagnostic("running");
    // CLI bootstrap precedes its RPC timer; the existing verification deadline bounds both.
    const processBeganAt = performance.now();
    let result;
    try {
      result = execFileSync(
        process.execPath,
        [
          resolve(installedRoot, "dist/entry.js"),
          "gateway",
          "call",
          method,
          "--port",
          String(port),
          "--expect-url",
          `ws://127.0.0.1:${port}`,
          "--params",
          JSON.stringify(params),
          "--json",
          "--timeout",
          String(timeoutMs),
        ],
        {
          cwd: installedRoot,
          env: process.env,
          encoding: "utf8",
          timeout: left,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      rpcFacts = {
        method,
        timeoutMs,
        processTimeoutMs: left,
        status: "failed",
        exitCode: Number.isInteger(error.status) ? error.status : null,
        signal: safeAtom(error.signal),
        processCode: safeAtom(error.code),
        stdout: scrub(error.stdout),
        stderr: scrub(error.stderr),
      };
      // Keep typed failure facts plus bounded text through the compiled public redactor.
      try {
        const envelope = JSON.parse(String(error.stdout ?? ""));
        rpcFacts.remoteType = safeAtom(envelope.error?.type);
        rpcFacts.remoteCode = safeAtom(envelope.error?.code);
      } catch {
        /* Non-JSON process output remains an RPC failure, never a wait. */
      }
      fail("CHECKPOINT_RPC_FAILED", { timedOut: error.code === "ETIMEDOUT" });
    }
    rpcFacts = {
      method,
      timeoutMs,
      processTimeoutMs: left,
      status: "completed",
      exitCode: 0,
      processElapsedMs: Math.round(performance.now() - processBeganAt),
    };
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      fail("CHECKPOINT_RPC_JSON_INVALID");
    }
    if (parsed?.error || parsed?.ok === false) {
      rpcFacts.remoteMessage = scrub(parsed.error?.message);
      fail("CHECKPOINT_RPC_ERROR_ENVELOPE");
    }
    return parsed;
  }
  function nativeEvents() {
    stage = "native-failure-inspection";
    const eventsPath = fixture.eventsPath;
    if (statSync(eventsPath).size > 128 * 1024 * 1024) {
      fail("NATIVE_EVIDENCE_OVER_BOUND");
    }
    const bytes = readFileSync(eventsPath, "utf8");
    // The recorder flushes complete lines. Only its unfinished final line is deferred.
    const complete = bytes.slice(0, bytes.lastIndexOf("\n") + 1);
    const events = complete
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          return fail("MALFORMED_RECORDER_EVENT", { lineNumber: index + 1 });
        }
      });
    if (events.some((event) => event.kind === "action" && event.status === "failed")) {
      fail("NATIVE_ACTION_FAILED");
    }
    if (
      events.some(
        (event) => event.isSut === true && event.text?.startsWith("TELEGRAM_BINDING_FAIL_"),
      )
    ) {
      fail("NATIVE_FIXTURE_REPORTED_FAILURE");
    }
    return events;
  }
  function nativeReadiness(events) {
    const missing = [];
    const names =
      phase === "spawn"
        ? ["PARENT", "CHILD"]
        : phase === "before"
          ? ["PARENT", "CHILD", "BEFORE"]
          : ["PARENT", "CHILD", "BEFORE", "AFTER"];
    for (const name of names) {
      const trigger = name === "PARENT" || name === "CHILD" ? "SPAWN" : name;
      const sent = events.find(
        (event) =>
          event.kind === "action" &&
          event.actionType === "send" &&
          event.status === "completed" &&
          hasMarker({ content: event.text }, `TELEGRAM_BINDING_${trigger}_${runId}`),
      );
      if (!sent) {
        missing.push(`${trigger}_NATIVE_SEND_RECEIPT`);
        continue;
      }
      if (
        !events.some(
          (event) =>
            event.isSut === true &&
            ["message", "edit"].includes(event.kind) &&
            event.text?.trim() === `TELEGRAM_BINDING_ACK_${name}_${runId}` &&
            event.elapsedMs >= sent.elapsedMs &&
            event.topicType === "messageTopicForum" &&
            event.topicId === fixture.topicId &&
            (event.raw?.message?.chat_id ?? event.raw?.chat_id) === Number(fixture.chatId),
        )
      ) {
        missing.push(`${name}_NATIVE_ACK`);
      }
    }
    return [...new Set(missing)];
  }
  function inspect() {
    const missing = [];
    const parent = rpc("parent-history", "sessions.get", { key: parentKey, limit: 100 });
    if (!Array.isArray(parent.messages)) {
      fail("PARENT_HISTORY_SHAPE_INVALID");
    }
    const calls = parent.messages.flatMap((message, index) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content
            .filter((part) => part?.type === "toolCall" && part.name === "sessions_spawn")
            .map((call) => ({ call, index }))
        : [],
    );
    if (!calls.length) {
      if (baseline) {
        fail("ACCEPTED_PARENT_CALL_DISAPPEARED");
      }
      return { missing: ["PARENT_SPAWN_CALL"] };
    }
    if (calls.length !== 1) {
      fail("MULTIPLE_PARENT_SPAWN_CALLS");
    }
    const { call, index: callIndex } = calls[0];
    if (
      !call.arguments ||
      Object.keys(call.arguments).length !== Object.keys(expectedArgs).length ||
      Object.keys(expectedArgs).some((key) => call.arguments[key] !== expectedArgs[key])
    ) {
      fail("SPAWN_ARGUMENTS_MISMATCH");
    }
    const owner = parent.messages.slice(0, callIndex).findLast(ordinaryUser);
    if (!owner || !hasMarker(owner, `TELEGRAM_BINDING_SPAWN_${runId}`)) {
      fail("SPAWN_USER_TURN_MISMATCH");
    }
    const toolCallId = call.id;
    const callId = typeof toolCallId === "string" ? toolCallId.split("|")[0] : "";
    if (!/^call_mock_sessions_spawn_[0-9a-f]{10}$/.test(callId)) {
      fail("MOCK_CALL_ID_MISMATCH");
    }
    const allResults = parent.messages
      .slice(callIndex + 1)
      .filter((message) => message.role === "toolResult" && message.toolName === "sessions_spawn");
    if (!allResults.length) {
      if (baseline) {
        fail("ACCEPTED_SPAWN_RESULT_DISAPPEARED");
      }
      return { missing: ["SPAWN_TOOL_RESULT"] };
    }
    if (allResults.length !== 1 || allResults[0].toolCallId !== toolCallId) {
      fail("SPAWN_RESULT_ID_MISMATCH");
    }
    const resultMessage = allResults[0];
    const receipt = JSON.parse(text(resultMessage));
    if (resultMessage.isError !== false || receipt.status !== "accepted") {
      fail("SPAWN_NOT_ACCEPTED", { resultStatus: safeAtom(receipt.status) });
    }
    if (
      receipt.taskName !== expectedArgs.taskName ||
      receipt.mode !== "session" ||
      receipt.context !== "isolated" ||
      typeof receipt.childSessionKey !== "string" ||
      !receipt.childSessionKey.startsWith("agent:main:subagent:")
    ) {
      fail("ACCEPTED_SPAWN_CONTRACT_MISMATCH");
    }
    const childKey = receipt.childSessionKey;
    const following = parent.messages.slice(parent.messages.indexOf(resultMessage) + 1);
    const nextUser = following.findIndex(ordinaryUser);
    const parentTurn = nextUser < 0 ? following : following.slice(0, nextUser);
    const acks = parentTurn.filter(
      (message) =>
        message.role === "assistant" &&
        text(message).trim() === `TELEGRAM_BINDING_ACK_PARENT_${runId}`,
    );
    if (acks.length > 1) {
      fail("DUPLICATE_PARENT_ACK");
    }
    if (!acks.length) {
      if (baseline) {
        fail("PRIOR_PARENT_ACK_DISAPPEARED");
      }
      missing.push("PARENT_TRANSCRIPT_ACK");
    }
    const identity = (label) => {
      const { session } = rpc(label, "sessions.describe", { key: childKey });
      if (
        session?.key !== childKey ||
        typeof session.sessionId !== "string" ||
        !session.sessionId
      ) {
        fail("CHILD_CANONICAL_IDENTITY_MISSING");
      }
      return session.sessionId;
    };
    const sessionId = identity("child-identity-before");
    if (
      baseline &&
      (baseline.childKey !== childKey ||
        baseline.sessionId !== sessionId ||
        baseline.toolCallId !== toolCallId)
    ) {
      fail("CHILD_IDENTITY_CHANGED");
    }
    const child = rpc("child-history", "sessions.get", { key: childKey, limit: 100 });
    if (!Array.isArray(child.messages)) {
      fail("CHILD_HISTORY_SHAPE_INVALID");
    }
    if (identity("child-identity-after") !== sessionId) {
      fail("CHILD_IDENTITY_CHANGED_DURING_READ");
    }
    stage = "phase-conditions";
    const required =
      phase === "spawn"
        ? ["CHILD"]
        : phase === "before"
          ? ["CHILD", "BEFORE"]
          : ["CHILD", "BEFORE", "AFTER"];
    const phases = {};
    for (const name of required) {
      const matches = child.messages.flatMap((message, index) =>
        ordinaryUser(message) && hasMarker(message, `TELEGRAM_BINDING_${name}_${runId}`)
          ? [{ message, index }]
          : [],
      );
      if (matches.length > 1) {
        fail("DUPLICATE_CHILD_PHASE_USER", { missingPhase: name });
      }
      if (!matches.length) {
        if (baseline?.phases?.[name]) {
          fail("PRIOR_CHILD_PHASE_DISAPPEARED", { missingPhase: name });
        }
        missing.push(`${name}_TRANSCRIPT_USER`);
        continue;
      }
      const sent = matches[0];
      const later = child.messages.slice(sent.index + 1);
      const end = later.findIndex(ordinaryUser);
      const turn = end < 0 ? later : later.slice(0, end);
      const replies = turn.filter(
        (message) =>
          message.role === "assistant" &&
          text(message).trim() === `TELEGRAM_BINDING_ACK_${name}_${runId}`,
      );
      if (replies.length > 1) {
        fail("DUPLICATE_CHILD_PHASE_ACK", { missingPhase: name });
      }
      if (!replies.length) {
        if (baseline?.phases?.[name]) {
          fail("PRIOR_CHILD_ACK_DISAPPEARED", { missingPhase: name });
        }
        missing.push(`${name}_TRANSCRIPT_ACK`);
        continue;
      }
      phases[name] = { user: messageFact(sent.message), assistant: messageFact(replies[0]) };
    }
    for (const early of phase === "spawn"
      ? ["BEFORE", "AFTER"]
      : phase === "before"
        ? ["AFTER"]
        : []) {
      if (
        child.messages.some(
          (message) =>
            ordinaryUser(message) && hasMarker(message, `TELEGRAM_BINDING_${early}_${runId}`),
        )
      ) {
        fail("FOLLOWUP_PRECEDED_CHECKPOINT", { earlyPhase: early });
      }
    }
    return {
      missing,
      childKey,
      sessionId,
      toolCallId,
      callId,
      spawn: {
        args: call.arguments,
        user: messageFact(owner),
        result: messageFact(resultMessage),
        ...(acks[0] ? { ack: messageFact(acks[0]) } : {}),
      },
      phases,
    };
  }
  for (;;) {
    if (remaining() < 1000) {
      fail("CONDITION_DEADLINE");
    }
    attempts++;
    lastMissing = nativeReadiness(nativeEvents());
    if (!lastMissing.length) {
      break;
    }
    stage = "waiting-for-explicit-condition";
    diagnostic("waiting");
    if (remaining() <= 1000) {
      fail("CONDITION_DEADLINE");
    }
    await delay(Math.min(1000, remaining() - 1));
  }
  // Wire ACKs are readiness only. Perform the authoritative read contract once;
  // missing/failed RPC state is never converted back into a wait.
  budgetPhase = "authoritative-verification";
  deadline = performance.now() + verificationBudgetMs;
  const snapshot = inspect();
  lastMissing = snapshot.missing;
  if (lastMissing.length) {
    fail("AUTHORITATIVE_CHECKPOINT_STATE_MISSING");
  }
  stage = "final-artifact-check";
  assertInstalled();
  save(output, {
    status: "READ_CHECKPOINT_ONLY",
    phase,
    runId,
    runtime,
    parentKey,
    ...snapshot,
    capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - beganAt,
    attempts,
    limitations:
      "Requires final scenario, native/provider evidence and cleanup judgment; no real model-quality claim.",
  });
  diagnostic("completed");
  console.log(JSON.stringify({ phase, checkpoint: "captured", attempts }));
}
try {
  await main();
} catch (error) {
  const facts = {
    code: error instanceof CheckpointFailure ? error.message : "CHECKPOINT_PROGRAM_ERROR",
    errorName: safeAtom(error?.name),
    processCode: safeAtom(error?.code),
    ...(error instanceof CheckpointFailure ? error.facts : {}),
  };
  if (isAbsolute(output ?? "")) {
    diagnostic("failed", facts);
  }
  console.error(JSON.stringify({ phase, stage, ...facts }));
  process.exitCode = 1;
}
