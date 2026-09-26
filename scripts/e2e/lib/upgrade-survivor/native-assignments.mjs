// The published Gateway owns every assignment write; this helper only reads the resulting SQLite state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { inspectNpmPackageTarball } from "../../../prepublish-plugin-registry-artifact.mjs";
import { readTcpPortEnv } from "../env-limits.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const SESSION_KEY = "agent:native-proof:upgrade-native-proof";
const MODEL = "openai/gpt-5.6-luna";
const RUNNING = "codex-thread:native-upgrade-running";
const COMPLETED = "codex-thread:native-upgrade-complete";
const HISTORY_MARKER = "NATIVE_UPGRADE_RETAINED_HISTORY";
const RESULT_MARKER = "NATIVE_UPGRADE_PENDING_RESULT";
let gatewayAddressArgs;

function required(name) {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
}

function artifact(name) {
  return path.join(required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(name, data) {
  fs.writeFileSync(artifact(name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function assessEligibility(candidateTarball) {
  const candidate = inspectNpmPackageTarball(candidateTarball);
  if (
    Object.hasOwn(candidate.packageJson.exports ?? {}, "./plugin-sdk/agent-harness-task-runtime")
  ) {
    writeJson("native-assignment-eligibility.json", {
      status: "not-applicable",
      reason: "candidate retains the Task runtime SDK",
    });
    process.stdout.write("0\n");
    return;
  }
  const registryRoot = required("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR");
  const registry = readJson(path.join(registryRoot, "prepublish-plugin-registry.json"));
  const codex = registry.packages.find((entry) => entry.name === "@openclaw/codex");
  assert(codex, "retirement candidate omitted its Codex companion archive");
  assert.equal(codex.version, candidate.packageJson.version);
  assert.equal(path.basename(codex.tarball), codex.tarball);
  const archive = path.join(registryRoot, codex.tarball);
  assert.equal(createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), codex.sha256);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/openclaw.plugin.json"], { encoding: "utf8" }),
  );
  assert(
    manifest.doctorContract?.stateMigrations?.some(
      (entry) => entry.id === "codex-native-task-assignments",
    ),
    "retirement companion did not register native assignment migration",
  );
  writeJson("native-assignment-eligibility.json", {
    status: "required",
    candidateVersion: candidate.packageJson.version,
    candidateSha256: candidate.sha256,
    companionSha256: codex.sha256,
    companionIntegrity: `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`,
    sourceSha: registry.sourceSha,
  });
  process.stdout.write("1\n");
}

function cli(args, label) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(artifact(`native-${label}.out`), result.stdout ?? "");
  fs.writeFileSync(artifact(`native-${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed; inspect native proof output`);
  return result.stdout;
}

function rpc(method, params, label = method) {
  if (!gatewayAddressArgs) {
    const help = cli(["gateway", "call", "--help"], "gateway-call-help");
    const url = `ws://127.0.0.1:${readTcpPortEnv("OPENCLAW_GATEWAY_PORT", 18789)}`;
    // Select the published 9.4 versus current address contract before sending any mutation.
    gatewayAddressArgs = help.includes("--expect-url")
      ? ["--expect-url", url]
      : ["--url", url, "--token", required("GATEWAY_AUTH_TOKEN_REF")];
  }
  const output = cli(
    [
      "gateway",
      "call",
      method,
      ...gatewayAddressArgs,
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    label,
  );
  const start = output.search(/^\s*\{/mu);
  assert(start >= 0, `${label} omitted its JSON response`);
  return JSON.parse(output.slice(start));
}

function setPhase(phase) {
  writeJson("native-assignment-phase.json", { phase });
}

function runParent(phase, wait = true) {
  setPhase(phase);
  const result = rpc(
    "agent",
    {
      sessionKey: SESSION_KEY,
      idempotencyKey: randomUUID(),
      agentId: "native-proof",
      message:
        phase === "seed-assignments"
          ? "Spawn two native child agents for this synthetic upgrade fixture."
          : `Continue the synthetic native upgrade fixture: ${phase}.`,
      deliver: false,
    },
    phase,
  );
  assert(typeof result.runId === "string" && result.runId, "agent omitted its real run identity");
  if (wait) {
    const completed = rpc(
      "agent.wait",
      { runId: result.runId, timeoutMs: 60_000 },
      `${phase}-wait`,
    );
    assert.equal(completed.status, "ok", `parent ${phase} did not settle`);
  }
  return result.runId;
}

function snapshot() {
  const databasePath = path.join(required("OPENCLAW_STATE_DIR"), "state", "openclaw.sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tasks = db
      .prepare(
        "SELECT * FROM task_runs WHERE runtime = 'subagent' AND task_kind = 'codex-native' AND requester_session_key = ? ORDER BY run_id",
      )
      .all(SESSION_KEY)
      .map((row) => Object.assign({}, row));
    const bindings = db
      .prepare(
        "SELECT entry_key, value_json FROM plugin_state_entries WHERE plugin_id = 'codex' AND namespace = 'app-server-thread-bindings'",
      )
      .all()
      .map((row) => ({ key: row.entry_key, value: JSON.parse(row.value_json) }))
      .filter((row) => row.value.binding?.threadId === "native-upgrade-parent");
    assert.equal(bindings.length, 1, "native parent binding was missing or ambiguous");
    return { databasePath, tasks, binding: bindings[0] };
  } finally {
    db.close();
  }
}

function assignments(observation) {
  return observation.binding.value.nativeSubagentAssignments?.assignments ?? [];
}

export function assertPublishedAssignments(observation) {
  assert.equal(
    observation.tasks.length,
    2,
    "published writer did not create both native assignments",
  );
  for (const runId of [RUNNING, COMPLETED]) {
    const task = observation.tasks.find((row) => row.run_id === runId);
    assert(task, `published writer omitted ${runId}`);
    assert.equal(task.owner_key, SESSION_KEY);
    assert.equal(task.scope_kind, "session");
    const detail = JSON.parse(task.detail_json);
    assert.equal(detail.nativeHistory?.parentThreadId, "native-upgrade-parent");
    assert.equal(detail.nativeHistory?.sessionId, observation.binding.value.sessionId);
    assert.equal(typeof detail.nativeHistory.connectionFingerprint, "string");
    assert(detail.nativeHistory.connectionFingerprint.length === 64);
    assert.equal(
      detail.nativeTurnId,
      undefined,
      "released 9.4 state must not fabricate a native turn locator",
    );
    assert.equal(task.delivery_status, runId === RUNNING ? "not_applicable" : "pending");
    assert.equal(task.status, runId === RUNNING ? "running" : "succeeded");
    if (runId === COMPLETED) {
      assert(
        task.terminal_summary?.includes(RESULT_MARKER),
        "published writer omitted the retained result",
      );
    }
  }
}

export function assertImportedAssignments(before, after) {
  assert.deepEqual(after.tasks, before.tasks, "upgrade changed released native source rows");
  assert.equal(after.binding.key, before.binding.key);
  assert.equal(after.binding.value.sessionId, before.binding.value.sessionId);
  const imported = assignments(after);
  assert.equal(imported.length, 2, "candidate Doctor did not import both native assignments");
  const marker = after.binding.value.nativeSubagentTaskImport;
  assert.equal(marker?.version, 1);
  assert.deepEqual(
    marker.taskIds.toSorted((left, right) => left.localeCompare(right)),
    before.tasks.map((row) => row.task_id).toSorted((left, right) => left.localeCompare(right)),
  );
  for (const task of before.tasks) {
    const entry = imported.find((value) => value.runId === task.run_id);
    assert(entry, "native assignment locator was lost");
    const detail = JSON.parse(task.detail_json);
    assert.deepEqual(entry.owner, detail.nativeHistory);
    assert.equal(entry.nativeTurnId, detail.nativeTurnId);
    if (task.run_id === COMPLETED) {
      assert.equal(entry.recordedCompletion?.result, task.terminal_summary);
    }
  }
}

function history(label, retained) {
  const result = rpc("chat.history", { sessionKey: SESSION_KEY, limit: 100 }, label);
  assert(Array.isArray(result.messages), "native history omitted messages");
  const text = JSON.stringify(result.messages);
  assert(text.includes(HISTORY_MARKER), "native history lost the released parent reply");
  if (retained) {
    assert.equal(result.sessionId, retained.sessionId, "native history changed physical session");
    const stableMessage = (message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      idempotencyKey: message.idempotencyKey,
      id: message["__openclaw"]?.id,
      mirrorIdentity: message["__openclaw"]?.mirrorIdentity,
      runId: message["__openclaw"]?.runId,
    });
    assert.deepEqual(
      result.messages.slice(0, retained.messages.length).map(stableMessage),
      retained.messages.map(stableMessage),
      "native history changed released message content, identity, or order",
    );
  }
  return result;
}

async function seed() {
  runParent("seed-history");
  const retainedHistory = history("history-before");
  runParent("seed-assignments", false);
  const observed = await waitForWitness(() => {
    const value = snapshot();
    assertPublishedAssignments(value);
    return value;
  });
  const coreVersion = cli(["--version"], "baseline-version").trim();
  assert.match(coreVersion, /^OpenClaw 2026\.9\.4(?:\s|$)/u);
  const record = readPluginInstallRecords().codex;
  assert.equal(record?.source, "npm", "native writer plugin was not the published npm package");
  const installPath = record.installPath.replace(/^~(?=$|\/)/u, required("HOME"));
  const plugin = readJson(path.join(installPath, "package.json"));
  assert.equal(plugin.name, "@openclaw/codex");
  assert.equal(plugin.version, "2026.9.4");
  const integrity = record.integrity ?? record.npmIntegrity;
  assert(
    typeof integrity === "string" && integrity.startsWith("sha512-"),
    "published native writer omitted package integrity",
  );
  writeJson("native-assignment-baseline.json", {
    baselineVersion: "2026.9.4",
    coreVersion,
    plugin: {
      name: plugin.name,
      version: plugin.version,
      spec: record.spec,
      integrity,
    },
    sessionKey: SESSION_KEY,
    retainedHistory,
    ...observed,
  });
}

function configure() {
  setPhase("seed-history");
  const ready = readJson(artifact("native-assignment-ready.json"));
  const config = readJson(required("OPENCLAW_CONFIG_PATH"));
  const set = (key, value) =>
    cli(["config", "set", key, JSON.stringify(value), "--strict-json"], `configure-${key}`);
  set("plugins.entries.codex", {
    enabled: true,
    config: { appServer: { transport: "websocket", url: ready.url, mode: "yolo" } },
  });
  if (config.plugins?.allow?.length) {
    set("plugins.allow", [...new Set([...config.plugins.allow, "codex"])]);
  }
  set("agents.defaults.models", {
    ...config.agents?.defaults?.models,
    [MODEL]: { agentRuntime: { id: "codex" } },
  });
  cli(
    [
      "agents",
      "add",
      "native-proof",
      "--workspace",
      path.join(required("OPENCLAW_TEST_WORKSPACE_DIR"), "native-proof"),
      "--model",
      MODEL,
      "--non-interactive",
      "--json",
    ],
    "configure-native-agent",
  );
  const configured = readJson(required("OPENCLAW_CONFIG_PATH"));
  if (
    config.agents?.defaults?.systemAgent === undefined &&
    configured.agents?.defaults?.systemAgent !== undefined
  ) {
    cli(["config", "unset", "agents.defaults.systemAgent"], "preserve-unset-system-agent");
  }
  setPhase("seed-history");
}

function postUpdate(candidateVersion) {
  const before = readJson(artifact("native-assignment-baseline.json"));
  const after = snapshot();
  assertImportedAssignments(before, after);
  const eligibility = readJson(artifact("native-assignment-eligibility.json"));
  assert.equal(eligibility.candidateVersion, candidateVersion);
  const installed = readPluginInstallRecords().codex;
  assert.equal(installed?.resolvedVersion, candidateVersion);
  assert.equal(
    installed?.integrity ?? installed?.npmIntegrity,
    eligibility.companionIntegrity,
    "installed candidate did not load the selected Codex companion archive",
  );
  writeJson("native-assignment-first-hop.json", { candidateVersion, ...after });
}

async function waitForWitness(observe) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return observe();
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await delay(100);
    }
  }
}

function nativeMessages() {
  return fs
    .readFileSync(artifact("native-assignment-messages.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function completionRequests(messages) {
  return messages.filter(
    (entry) =>
      entry.direction === "request" &&
      entry.method === "turn/start" &&
      JSON.stringify(entry.params?.input).includes(RESULT_MARKER),
  );
}

function assertCloseWitness(phase, childLoaded) {
  const messages = nativeMessages().filter((entry) => entry.phase === phase);
  const index = messages.findIndex(
    (entry) => entry.direction === "request" && entry.method === "thread/loaded/list",
  );
  assert(index >= 0, "native closure skipped loaded-thread confirmation");
  const response = messages[index + 1];
  assert(
    response?.direction === "response" && response.id === messages[index].id,
    "native closure did not observe the loaded-thread response",
  );
  const started = messages.findIndex(
    (entry) => entry.method === "item/started" && entry.params?.item?.tool === "closeAgent",
  );
  const completed = messages.findIndex(
    (entry) =>
      entry.method === "item/completed" &&
      entry.params?.item?.id === messages[started]?.params?.item?.id &&
      entry.params?.turnId === messages[started]?.params?.turnId &&
      entry.params?.item?.status === "completed",
  );
  assert(
    started >= 0 && completed > started && index > completed,
    "native close did not confirm the completed close-agent operation",
  );
  assert(
    messages
      .slice(index + 2)
      .some(
        (entry) =>
          entry.method === "turn/completed" &&
          entry.params?.threadId === "native-upgrade-parent" &&
          entry.params?.turn?.id === messages[started].params.turnId,
      ),
    "native close parent completed before confirmation",
  );
  assert.deepEqual(response.result, {
    data: childLoaded
      ? ["native-upgrade-parent", "native-upgrade-running"]
      : ["native-upgrade-parent"],
    nextCursor: null,
  });
}

async function live(candidateVersion) {
  const before = readJson(artifact("native-assignment-baseline.json"));
  const firstHop = readJson(artifact("native-assignment-first-hop.json"));
  assert.equal(firstHop.candidateVersion, candidateVersion);
  runParent("recover");
  // The foreground run can settle before its detached completion continuation. Join the
  // observable delivery and native terminal event before switching the backend's phase.
  await waitForWitness(() => {
    const messages = nativeMessages();
    const delivered = completionRequests(messages);
    assert.equal(delivered.length, 1, "retained completion must reach the parent exactly once");
    assert.equal(delivered[0].phase, "recover");
    const reply = messages
      .slice(messages.indexOf(delivered[0]) + 1)
      .find((entry) => entry.direction === "response" && entry.id === delivered[0].id);
    assert(reply?.result?.turn?.id, "completion continuation omitted its native turn");
    assert(
      messages.some(
        (entry) =>
          entry.method === "turn/completed" &&
          entry.params?.threadId === "native-upgrade-parent" &&
          entry.params?.turn?.id === reply.result.turn.id,
      ),
      "completion continuation did not settle",
    );
    const remaining = assignments(snapshot());
    assert.deepEqual(
      remaining.map((entry) => entry.runId),
      [RUNNING],
      "recovery did not settle only the completed assignment",
    );
    assert(
      messages.some(
        (entry) =>
          entry.direction === "request" &&
          entry.method === "thread/read" &&
          entry.params?.threadId === "native-upgrade-running" &&
          entry.phase === "recover",
      ),
      "candidate did not recover the imported child through its native owner",
    );
  });
  history("history-recovered", before.retainedHistory);
  runParent("close-loaded");
  assertCloseWitness("close-loaded", true);
  assert(
    assignments(snapshot()).some((entry) => entry.runId === RUNNING),
    "unconfirmed native closure discarded an assignment",
  );
  runParent("close-gone");
  assertCloseWitness("close-gone", false);
  assert(
    !assignments(snapshot()).some((entry) => entry.runId === RUNNING),
    "confirmed native closure retained the old assignment",
  );
  runParent("verify-repeat");
  const finalMessages = nativeMessages();
  assert.equal(
    completionRequests(finalMessages).length,
    1,
    "retained completion was delivered twice",
  );
  assert(
    !finalMessages.some(
      (entry) =>
        entry.phase === "verify-repeat" &&
        entry.direction === "request" &&
        ["native-upgrade-running", "native-upgrade-complete"].includes(entry.params?.threadId) &&
        ((entry.method === "thread/read" && entry.params?.includeTurns === true) ||
          ["thread/turns/list", "thread/resume", "thread/subscribe", "turn/start"].includes(
            entry.method,
          )),
    ),
    "settled child was rediscovered on a later parent turn",
  );
  const after = snapshot();
  assert.equal(assignments(after).length, 0, "settled native work was restored");
  assert.deepEqual(after.tasks, before.tasks, "runtime changed preserved legacy rows");
  history("history-final", before.retainedHistory);
  writeJson("native-assignment-proof.json", {
    status: "passed",
    baselineVersion: "2026.9.4",
    candidateVersion,
    candidateSha256: readJson(artifact("native-assignment-eligibility.json")).candidateSha256,
    baselineCodex: before.plugin,
    baselineCore: before.coreVersion,
    backend: "synthetic-codex-websocket",
    source: "published-gateway-agent-native-events",
    sessionKey: SESSION_KEY,
    recoveredRunIds: [RUNNING, COMPLETED],
    firstHopImported: true,
    retainedHistory: true,
    retainedCompletion: true,
    unconfirmedClosePreserved: true,
    confirmedCloseSettled: true,
    noReplay: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, candidateVersion] = process.argv.slice(2);
  if (operation === "eligibility") {
    assessEligibility(candidateVersion);
  } else if (operation === "configure") {
    configure();
  } else if (operation === "seed") {
    await seed();
  } else if (operation === "before-update") {
    const before = readJson(artifact("native-assignment-baseline.json"));
    assert.deepEqual(
      snapshot().tasks,
      before.tasks,
      "published updater did not receive the captured native assignments",
    );
  } else if (operation === "post-update") {
    postUpdate(candidateVersion);
  } else if (operation === "live") {
    await live(candidateVersion);
  } else {
    throw new Error(`Unknown native assignment operation: ${operation}`);
  }
}
