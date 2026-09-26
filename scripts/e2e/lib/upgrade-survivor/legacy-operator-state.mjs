import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { assertAgentReplyContainsMarker } from "../agent-turn-output.mjs";
import { readTcpPortEnv } from "../env-limits.mjs";
import { readPluginInstallIndex } from "../plugin-index-sqlite.mjs";

const MODEL = "survivor/gpt-5.6-luna";
const JOBS = [
  { name: "survivor-default-owner", agentId: "main" },
  { name: "survivor-ops-owner", agentId: "ops" },
];
const SKILL =
  "---\nname: survivor-workspace\ndescription: Synthetic upgrade survivor workspace skill.\n---\n\nKeep this workspace intact across upgrades.\n";

function requiredEnv(name) {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
}

function artifact(name) {
  return path.join(requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function cli(args, label, { json = false, privateOutput = false, env = process.env } = {}) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  if (!privateOutput) {
    fs.writeFileSync(artifact(`${label}.out`), result.stdout ?? "");
    fs.writeFileSync(artifact(`${label}.err`), result.stderr ?? "");
  }
  assert.equal(
    result.status,
    0,
    `${label} failed (exit ${result.status}, signal ${result.signal}); see scenario artifacts`,
  );
  if (!json) {
    return result.stdout;
  }
  // Released CLIs may print plugin notices before their JSON result.
  const start = result.stdout.search(/^\s*\{/mu);
  assert(start >= 0, `${label} did not return JSON`);
  try {
    return JSON.parse(result.stdout.slice(start));
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function authoredPolicy(value) {
  return {
    version: value?.version,
    defaults: value?.defaults,
    agents: value?.agents,
  };
}

function baselinePolicy(value) {
  const policy = structuredClone(authoredPolicy(value));
  // JSON-era CLIs wrote unused usage fields as null. Doctor removes those
  // placeholders; the complete authored policy and real usage must survive.
  for (const agent of Object.values(policy.agents ?? {})) {
    for (const entry of agent.allowlist ?? []) {
      for (const key of ["lastUsedAt", "lastUsedCommand", "lastResolvedPath"]) {
        if (entry[key] === null) {
          delete entry[key];
        }
      }
    }
  }
  return policy;
}

function approvalsCommand() {
  const help = cli(["--help"], "legacy-operator-cli-help");
  // Both names appeared in published CLI surfaces. Select from help, never by
  // retrying a failed mutation against a different command.
  return /^\s+approvals\b/mu.test(help) ? "approvals" : "exec-approvals";
}

export function seedLegacyOperatorState() {
  const workspace = requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR");
  const mockPort = readTcpPortEnv("OPENCLAW_UPGRADE_SURVIVOR_MOCK_PORT");
  const set = (key, value) =>
    cli(
      ["config", "set", key, JSON.stringify(value), "--strict-json"],
      `legacy-operator-config-${key}`,
    );
  // Only transport and model setup uses config set. Every state specimen below
  // is authored by the installed baseline, preserving its native storage era.
  set("gateway", {
    mode: "local",
    port: 18789,
    bind: "loopback",
    reload: { mode: "off" },
    auth: {
      mode: "token",
      token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
    },
  });
  set("models.providers.survivor", {
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    models: [
      {
        id: "gpt-5.6-luna",
        name: "Survivor mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
  const setupHelp = cli(["setup", "--help"], "legacy-operator-setup-help");
  cli(
    [
      "setup",
      ...(setupHelp.includes("--baseline") ? ["--baseline"] : []),
      "--workspace",
      workspace,
    ],
    "legacy-operator-setup",
  );
  set("agents.defaults.model.primary", MODEL);
  // Every fixture client shares this container's loopback network namespace.
  set("plugins.entries.device-pair", {
    enabled: true,
    config: { publicUrl: "ws://127.0.0.1:18789" },
  });
  unsetSystemAgent();
  writeJson(artifact("legacy-operator-baseline.json"), {});
  seedLegacyOperatorWebhooks(set);
  const skillPath = path.join(workspace, "skills", "survivor-workspace", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, SKILL);
  fs.writeFileSync(
    path.join(workspace, "IDENTITY.md"),
    "# Upgrade Survivor\n\nSynthetic operator workspace.\n",
  );
}

function seedLegacyOperatorWebhooks(set) {
  const inventory = cli(["plugins", "list", "--json"], "legacy-operator-webhooks-inventory", {
    json: true,
  });
  const supported = inventory.plugins?.some((plugin) => plugin.id === "webhooks") === true;
  const baselineVersion = requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION");
  if (baselineVersion === "2026.9.2") {
    assert(supported, "the 2026.9.2 Webhooks retirement cell must seed the published plugin");
  }
  if (!supported) {
    writeJson(artifact("legacy-operator-webhooks.json"), { baselineVersion, seeded: false });
    return;
  }
  const entry = {
    enabled: true,
    config: {
      routes: {
        survivor: {
          enabled: true,
          path: "/survivor-taskflow",
          sessionKey: "agent:main:main",
          secret: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
        },
      },
    },
  };
  const hooks = {
    enabled: true,
    path: "/survivor-hooks",
    token: "synthetic-survivor-hook-token",
  };
  const prior = readJson(requiredEnv("OPENCLAW_CONFIG_PATH")).plugins ?? {};
  // An explicit allowlist retains the baseline's enabled plugins. The deny entry
  // keeps this migration specimen idle while exercising both retired-id lists.
  const allow =
    prior.allow ?? inventory.plugins.filter((plugin) => plugin.enabled).map((p) => p.id);
  set("plugins", {
    ...prior,
    allow: [...new Set([...allow, "webhooks"])],
    deny: [...new Set([...(prior.deny ?? []), "webhooks"])],
    entries: { ...prior.entries, webhooks: entry },
  });
  set("hooks", hooks);
  const config = readJson(requiredEnv("OPENCLAW_CONFIG_PATH"));
  assert.deepEqual(config.plugins?.entries?.webhooks, entry, "baseline Webhooks entry changed");
  assert(config.plugins.allow.includes("webhooks"), "baseline Webhooks allow reference missing");
  assert(config.plugins.deny.includes("webhooks"), "baseline Webhooks deny reference missing");
  assert.deepEqual(config.hooks, hooks, "baseline ordinary hooks changed");
  writeJson(artifact("legacy-operator-webhooks.json"), {
    baselineVersion,
    seeded: true,
    entry,
    hooks,
    model: config.agents.defaults.model.primary,
    provider: config.models.providers.survivor,
  });
}

export function seedLegacyOperatorExternalPlugin() {
  const inventory = cli(["plugins", "list", "--json"], "legacy-operator-baseline-plugins", {
    json: true,
  });
  const bundled = inventory.plugins?.some(
    (plugin) => plugin.id === "duckduckgo" && plugin.origin === "bundled",
  );
  const entry = {
    enabled: true,
    config: { webSearch: { region: "us-en", safeSearch: "moderate" } },
  };
  if (bundled) {
    // This is the published bundled-era web-search configuration, authored by its CLI.
    cli(["plugins", "enable", "duckduckgo"], "legacy-operator-enable-duckduckgo");
    for (const [key, value] of Object.entries({
      "plugins.entries.duckduckgo": entry,
      "tools.web.search.provider": "duckduckgo",
      "tools.web.search.enabled": true,
    })) {
      cli(["config", "set", key, JSON.stringify(value), "--strict-json"], `legacy-operator-${key}`);
    }
    cli(["config", "validate", "--json"], "legacy-operator-duckduckgo-baseline-validate", {
      json: true,
    });
  } else {
    // Recreate an earlier upgrade that retained config but lost the bundled payload.
    // Seed only after the healthy baseline Gateway/CLI specimens have been captured.
    assert(
      !inventory.plugins?.some((plugin) => plugin.id === "duckduckgo"),
      "baseline DuckDuckGo already installed",
    );
    const configPath = requiredEnv("OPENCLAW_CONFIG_PATH");
    const config = readJson(configPath);
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries.duckduckgo = entry;
    if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes("duckduckgo")) {
      config.plugins.allow.push("duckduckgo");
    }
    config.tools ??= {};
    config.tools.web ??= {};
    config.tools.web.search = { ...config.tools.web.search, provider: "duckduckgo", enabled: true };
    writeJson(configPath, config);
  }
  const records = readPluginInstallIndex({
    stateDir: requiredEnv("OPENCLAW_STATE_DIR"),
  }).installRecords;
  assert(!records?.duckduckgo, "formerly bundled plugin must have no baseline install record");
  writeJson(artifact("legacy-operator-external-plugin.json"), {
    pluginId: "duckduckgo",
    packageName: "@openclaw/duckduckgo-plugin",
    baselineState: bundled ? "bundled" : "missing",
    installRecord: null,
  });
  console.log(
    `Seeded configured DuckDuckGo without an install record (${bundled ? "bundled" : "already missing"}).`,
  );
}

export function assertLegacyOperatorExternalPlugin(expectedVersion) {
  const inventory = cli(["plugins", "list", "--json"], "legacy-operator-candidate-plugins", {
    json: true,
  });
  if (readJson(artifact("legacy-operator-webhooks.json")).seeded) {
    assert(
      !inventory.plugins?.some((entry) => entry.id === "webhooks"),
      "candidate still discovers retired Webhooks",
    );
  }
  const plugin = inventory.plugins?.find((entry) => entry.id === "duckduckgo");
  assert(plugin, "plugins list omitted configured DuckDuckGo");
  assert.notEqual(plugin.origin, "bundled", "DuckDuckGo must converge to an external package");
  assert.equal(
    plugin.version,
    expectedVersion,
    "plugins list reported the wrong DuckDuckGo version",
  );
  assert.notEqual(plugin.status, "error", "plugins list reported a DuckDuckGo load error");
  assert.equal(plugin.enabled, true, "DuckDuckGo was disabled during the update");
  const validation = cli(
    ["config", "validate", "--json"],
    "legacy-operator-external-plugin-validate",
    { json: true },
  );
  assert.equal(
    validation.valid,
    true,
    "config validation failed after external plugin convergence",
  );
  assert.deepEqual(
    validation.warnings,
    [],
    "config validation reported unresolved plugin warnings",
  );
}

function seedLegacyOperatorApprovals() {
  const approvals = approvalsCommand();
  const policyInput = artifact("legacy-operator-policy-input.json");
  writeJson(policyInput, {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: {},
  });
  cli([approvals, "set", "--file", policyInput, "--json"], "legacy-operator-approvals-set", {
    privateOutput: true,
  });
  fs.rmSync(policyInput);
  for (const [agent, pattern] of [
    ["main", "/usr/bin/uname"],
    ["ops", "/usr/bin/date"],
  ]) {
    cli(
      [approvals, "allowlist", "add", "--agent", agent, pattern, "--json"],
      `legacy-operator-approvals-${agent}`,
      { privateOutput: true },
    );
  }
  const initialSnapshot = cli([approvals, "get", "--json"], "legacy-operator-approvals-get", {
    json: true,
    privateOutput: true,
  });
  // JSON-era get synthesizes missing entry IDs without saving them. Persist
  // that baseline-authored policy before recording the durable migration input.
  writeJson(policyInput, authoredPolicy(initialSnapshot.file));
  cli([approvals, "set", "--file", policyInput, "--json"], "legacy-operator-approvals-persist", {
    privateOutput: true,
  });
  fs.rmSync(policyInput);
  const snapshot = cli([approvals, "get", "--json"], "legacy-operator-approvals-capture", {
    json: true,
    privateOutput: true,
  });
  assert.equal(
    snapshot.file?.defaults?.security,
    "allowlist",
    "baseline approvals policy was not set",
  );
  const policy = baselinePolicy(snapshot.file);
  assert.equal(policy.agents?.main?.allowlist?.[0]?.pattern, "/usr/bin/uname");
  assert.equal(policy.agents?.ops?.allowlist?.[0]?.pattern, "/usr/bin/date");
  writeJson(artifact("legacy-operator-baseline.json"), {
    ...readJson(artifact("legacy-operator-baseline.json")),
    approvals: policy,
    approvalsJsonEra: fs.existsSync(
      path.join(requiredEnv("OPENCLAW_STATE_DIR"), "exec-approvals.json"),
    ),
  });
}

function unsetSystemAgent() {
  const config = readJson(requiredEnv("OPENCLAW_CONFIG_PATH"));
  if (config.agents?.defaults?.systemAgent !== undefined) {
    cli(["config", "unset", "agents.defaults.systemAgent"], "legacy-operator-unset-system-agent");
  }
}

function seedCronJob(job) {
  const seedNativeHistory = process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION === "2026.9.6";
  const transcriptMarker = seedNativeHistory
    ? `OPENCLAW_E2E_LEGACY_OPERATOR_CRON_${job.agentId.toUpperCase()}`
    : undefined;
  const created = cli(
    [
      "cron",
      "add",
      "--name",
      job.name,
      "--every",
      "24h",
      ...(transcriptMarker
        ? [
            "--message",
            `Reply with exactly ${transcriptMarker}.`,
            "--thinking",
            "off",
            "--no-deliver",
          ]
        : ["--command", "printf survivor-cron"]),
      "--disabled",
      ...(job.agentId === "ops" ? ["--agent", "ops"] : []),
      "--json",
    ],
    `legacy-operator-add-${job.name}`,
    { json: true },
  );
  assert.equal(created.name, job.name, "baseline cron add returned the wrong job");
  assert(
    typeof created.id === "string" && created.id.length > 0,
    "baseline cron add omitted its job id",
  );
  assert.equal(
    created.agentId,
    job.agentId === "ops" ? "ops" : undefined,
    "baseline CLI changed the authored cron owner",
  );
  let history;
  if (seedNativeHistory) {
    // Each released run owns its real task_runs shape. Run the default-owner job
    // before adding ops, while the published Gateway can still resolve its owner.
    const log = artifact("legacy-operator-requests.jsonl");
    const priorBytes = fs.existsSync(log) ? fs.statSync(log).size : 0;
    cli(["cron", "run", created.id, "--wait"], `legacy-operator-run-${job.name}`, { json: true });
    assertLegacyOperatorPrompt(transcriptMarker, priorBytes);
    const page = cli(
      ["cron", "runs", "--id", created.id, "--limit", "50"],
      `legacy-operator-history-${job.name}`,
      { json: true },
    );
    assert.equal(page.entries?.length, 1, "published baseline did not retain its Cron run");
    assert.equal(page.entries[0].status, "ok", "published baseline Cron run did not succeed");
    assert.equal(page.entries[0].jobId, created.id);
    assert.equal(typeof page.entries[0].runId, "string");
    for (const field of ["sessionId", "sessionKey"]) {
      assert(page.entries[0][field]?.trim(), `published Cron run omitted ${field}`);
    }
    assert(page.entries[0].summary?.includes(transcriptMarker));
    history = page.entries;
  }
  return {
    id: created.id,
    name: created.name,
    agentId: created.agentId,
    ...(history ? { history, transcriptMarker } : {}),
  };
}

export function seedLegacyOperatorDefaultCron() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs, undefined, "baseline cron seed was already started");
  // 2026.9.2 refuses new ownerless jobs once the roster is ambiguous. Create
  // this ordinary operator job while main is still the sole configured agent.
  seeded.jobs = [seedCronJob(JOBS[0])];
  writeJson(artifact("legacy-operator-baseline.json"), seeded);
}

export function seedLegacyOperatorAgent() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs?.length, 1, "create the default-owner cron job before adding ops");
  cli(
    [
      "agents",
      "add",
      "ops",
      "--workspace",
      path.join(requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR"), "ops"),
      "--non-interactive",
      "--model",
      MODEL,
      "--json",
    ],
    "legacy-operator-add-ops",
  );
  unsetSystemAgent();
  // The approvals CLI validates named agents against the current roster.
  seedLegacyOperatorApprovals();
  assertLegacyOperatorConfig("baseline");
}

export function seedLegacyOperatorGatewayState() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs?.length, 1, "baseline default-owner cron seed missing");
  seeded.jobs.push(seedCronJob(JOBS[1]));
  // Capture the baseline's own creation receipts. Its global list can reject
  // the now-ownerless first job; only the candidate must resolve both owners.
  writeJson(artifact("legacy-operator-baseline.json"), seeded);
  console.log(
    "Legacy operator baseline: two CLI-authored cron jobs; default owner remains unpinned.",
  );
}

export function assertLegacyOperatorConfig(stage) {
  const config = readJson(requiredEnv("OPENCLAW_CONFIG_PATH"));
  const webhooks = readJson(artifact("legacy-operator-webhooks.json"));
  assert.equal(webhooks.baselineVersion, requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION"));
  if (webhooks.baselineVersion === "2026.9.2") {
    assert.equal(webhooks.seeded, true, "the 2026.9.2 Webhooks specimen was not seeded");
  }
  if (webhooks.seeded) {
    assert.deepEqual(config.hooks, webhooks.hooks, "ordinary hooks changed during retirement");
    if (stage === "baseline") {
      assert.deepEqual(config.plugins?.entries?.webhooks, webhooks.entry);
      assert(config.plugins?.allow?.includes("webhooks"), "Webhooks allow reference missing");
      assert(config.plugins?.deny?.includes("webhooks"), "Webhooks deny reference missing");
    } else {
      assert.equal(config.plugins?.entries?.webhooks, undefined, "retired Webhooks entry remains");
      assert(!config.plugins?.allow?.includes("webhooks"), "retired Webhooks allow id remains");
      assert(!config.plugins?.deny?.includes("webhooks"), "retired Webhooks deny id remains");
      writeJson(artifact("legacy-operator-webhooks-retired.json"), {
        baselineVersion: webhooks.baselineVersion,
        seeded: true,
        retired: true,
        ordinaryHooksPreserved: true,
        stage,
      });
    }
  }
  const agents =
    config.agents?.entries ??
    Object.fromEntries((config.agents?.list ?? []).map((entry) => [entry.id, entry]));
  assert(agents.main && agents.ops, "legacy operator main or ops agent missing");
  if (stage === "baseline") {
    assert.equal(
      config.agents?.defaults?.systemAgent,
      undefined,
      "legacy operator baseline must omit systemAgent",
    );
  }
  assert.equal(config.agents?.defaults?.model?.primary, MODEL, "legacy operator model changed");
  assert.equal(
    fs.readFileSync(
      path.join(
        requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR"),
        "skills",
        "survivor-workspace",
        "SKILL.md",
      ),
      "utf8",
    ),
    SKILL,
    "workspace skill changed",
  );
}

export function assertLegacyOperatorApprovals(stage) {
  const stateDir = requiredEnv("OPENCLAW_STATE_DIR");
  const baseline = readJson(artifact("legacy-operator-baseline.json"));
  const legacyPath = path.join(stateDir, "exec-approvals.json");
  let policy;
  if (stage === "baseline" && baseline.approvalsJsonEra) {
    policy = readJson(legacyPath);
  } else {
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    assert(fs.existsSync(dbPath), "legacy operator approvals database missing");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = ?")
        .get("current");
      assert(row, "legacy operator approvals canonical row missing");
      policy = JSON.parse(row.raw_json);
    } finally {
      db.close();
    }
  }
  const observed = stage === "baseline" ? baselinePolicy(policy) : authoredPolicy(policy);
  writeJson(artifact(`legacy-operator-${stage}-approvals.json`), observed);
  assert(isDeepStrictEqual(observed, baseline.approvals), "legacy operator exec approvals changed");
  if (stage !== "baseline") {
    assert(!fs.existsSync(legacyPath), "legacy exec approvals file was not retired");
  }
}

export function assertLegacyOperatorGatewayState(stage) {
  const listing = cli(["cron", "list", "--all", "--json"], `legacy-operator-${stage}-cron`, {
    json: true,
  });
  const baseline = readJson(artifact("legacy-operator-baseline.json"));
  assertLegacyOperatorCronOwners(listing, baseline);
  console.log("Legacy operator cron owners: survivor-default-owner=main, survivor-ops-owner=ops.");
  if (stage !== "baseline") {
    assertLegacyOperatorCronHistory(stage, baseline);
  }
}

function assertLegacyOperatorCronHistory(stage, baseline) {
  const legacyPath = artifact("legacy-operator-cron-history.json");
  const legacy = fs.existsSync(legacyPath) ? readJson(legacyPath).entries : [];
  const expected = [...legacy, ...baseline.jobs.flatMap((job) => job.history ?? [])];
  if (expected.length === 0) {
    return;
  }
  const migrationProof = legacy.length
    ? readJson(artifact("legacy-operator-cron-history-proof.json"))
    : undefined;
  if (migrationProof) {
    assert.equal(migrationProof.status, "passed", "retained Cron import proof did not pass");
  }
  const proof = {
    status: "running",
    stage,
    source: migrationProof?.contract ?? "published-native-runs",
    pages: [],
  };
  const proofPath = artifact(`legacy-operator-${stage}-cron-history.json`);
  try {
    for (const [index, entry] of expected.entries()) {
      const transcriptMarker = baseline.jobs.find(
        (job) => job.id === entry.jobId,
      )?.transcriptMarker;
      if (!migrationProof) {
        assert(transcriptMarker, "native Cron transcript expectation missing");
      }
      const args = ["cron", "runs", "--id", entry.jobId, "--limit", "1"];
      const page = cli(
        [...args, "--run-id", entry.runId],
        `legacy-operator-${stage}-history-${index}`,
        { json: true },
      );
      assert.equal(page.total, 1, "candidate lost or duplicated retained Cron history");
      assert.equal(page.entries?.length, 1, "candidate omitted retained Cron entry");
      assert.equal(page.hasMore, false);
      for (const [key, value] of Object.entries(entry)) {
        assert.deepEqual(page.entries[0][key], value, `candidate changed retained Cron ${key}`);
      }
      const empty = cli(
        [...args, "--offset", "1"],
        `legacy-operator-${stage}-history-${index}-offset`,
        { json: true },
      );
      assert.deepEqual(
        {
          entries: empty.entries,
          total: empty.total,
          offset: empty.offset,
          hasMore: empty.hasMore,
          nextOffset: empty.nextOffset,
        },
        { entries: [], total: 1, offset: 1, hasMore: false, nextOffset: null },
      );
      const missing = cli(
        [...args, "--run-id", "missing-survivor-run"],
        `legacy-operator-${stage}-history-${index}-missing`,
        { json: true },
      );
      assert.deepEqual(
        { entries: missing.entries, total: missing.total },
        { entries: [], total: 0 },
      );
      proof.pages.push({
        jobId: entry.jobId,
        runId: entry.runId,
        retained: page,
        offset: empty,
        missing,
        ...(transcriptMarker
          ? {
              transcript: assertLegacyOperatorCronTranscript(stage, index, entry, transcriptMarker),
            }
          : {}),
      });
    }
    proof.status = "passed";
  } catch (error) {
    proof.status = "failed";
    proof.failure = String(error).slice(0, 500);
    throw error;
  } finally {
    writeJson(proofPath, proof);
  }
}

function assertLegacyOperatorCronTranscript(stage, index, entry, marker) {
  const read = (cursor) =>
    cli(
      [
        "gateway",
        "call",
        "cron.history",
        "--expect-url",
        "ws://127.0.0.1:18789",
        "--params",
        JSON.stringify({
          id: entry.jobId,
          runId: entry.runId,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        }),
        "--json",
      ],
      `legacy-operator-${stage}-transcript-${index}${cursor ? "-earlier" : ""}`,
      { json: true },
    );
  const recent = read();
  assert.equal(recent.messages?.length, 1, "Cron transcript omitted its latest message");
  assert(
    typeof recent.nextCursor === "string" && recent.nextCursor,
    "Cron transcript omitted earlier history cursor",
  );
  const earlier = read(recent.nextCursor);
  assert.equal(earlier.messages?.length, 1, "Cron transcript omitted its earlier message");
  const latest = recent.messages[0];
  const previous = earlier.messages[0];
  const text = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  assert.equal(latest.role, "assistant");
  assert.equal(previous.role, "user");
  assert(text(latest).includes(marker), "Cron transcript selected another run's reply");
  assert(
    text(previous).includes(`Reply with exactly ${marker}.`),
    "Cron transcript selected another run's prompt",
  );
  for (const message of [latest, previous]) {
    assert(message["__openclaw"]?.id?.trim(), "Cron transcript omitted retained message identity");
    assert(Number.isSafeInteger(message["__openclaw"].seq));
  }
  assert.notEqual(
    previous["__openclaw"].id,
    latest["__openclaw"].id,
    "Cron transcript repeated a page",
  );
  assert(
    previous["__openclaw"].seq < latest["__openclaw"].seq,
    "Cron transcript page did not move earlier",
  );
  return { sessionId: entry.sessionId, sessionKey: entry.sessionKey, recent, earlier };
}

export function assertLegacyOperatorCronOwners(listing, baseline) {
  const seededJobs = listing.jobs?.filter((job) => JOBS.some(({ name }) => job.name === name));
  assert.equal(seededJobs?.length, 2, "legacy operator cron job count changed");
  for (const expected of JOBS) {
    const before = baseline.jobs?.find((job) => job.name === expected.name);
    const after = seededJobs.find((job) => job.id === before?.id && job.name === expected.name);
    assert(after, `legacy operator cron job missing: ${expected.name}`);
    assert.equal(
      after.effectiveAgentId,
      expected.agentId,
      `legacy operator cron owner unresolved or changed: ${expected.name}`,
    );
    assert.equal(
      after.agentId,
      before.agentId,
      `legacy operator cron explicit owner changed: ${expected.name}`,
    );
  }
}

export function runLegacyOperatorTurn(stage) {
  assert(["baseline", "candidate"].includes(stage), "unknown legacy operator turn stage");
  const marker = `OPENCLAW_E2E_LEGACY_OPERATOR_${stage.toUpperCase()}`;
  const label = `legacy-operator-${stage}-turn`;
  const log = artifact("legacy-operator-requests.jsonl");
  const priorBytes = fs.existsSync(log) ? fs.statSync(log).size : 0;
  cli(
    [
      "agent",
      "--agent",
      "main",
      "--session-id",
      `legacy-operator-${stage}`,
      "--message",
      `Reply with exactly ${marker}.`,
      "--thinking",
      "off",
      "--timeout",
      "90",
      "--json",
    ],
    label,
  );
  assertAgentReplyContainsMarker(marker, artifact(`${label}.out`));
  assertLegacyOperatorPrompt(marker, priorBytes);
  console.log(`Legacy operator ${stage} agent turn: ${marker}.`);
}

function assertLegacyOperatorPrompt(marker, priorBytes) {
  const requests = fs
    .readFileSync(artifact("legacy-operator-requests.jsonl"))
    .subarray(priorBytes)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/v1/chat/completions" &&
        JSON.stringify(request.body).includes(marker),
    ),
    `${marker} did not reach the mock provider with its prompt`,
  );
}
