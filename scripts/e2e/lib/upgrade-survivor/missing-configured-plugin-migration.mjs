import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJson, write, writeJson } from "../fixtures/common.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
import { readDatabase } from "./observations.mjs";

const [command, ...args] = process.argv.slice(2);
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(runtimeRoot && artifactRoot && stateDir && configPath, "Missing survivor fixture paths");
const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
const evidenceRoot = path.join(artifactRoot, "missing-plugin");
const fixturePath = path.join(evidenceRoot, "fixture.json");
const requestPath = path.join(evidenceRoot, "registry-requests.jsonl");
const migrationId = "deferred-plugin-migration:codex";
const bindingNamespace = "app-server-thread-bindings";
const setupFixtures = [
  { id: "public-setup-complete", detector: "setup" },
  { id: "public-setup-ambiguous", detector: "full" },
];

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function installSetupFixture({ id, detector }) {
  const root = path.join(runtimeRoot, "setup-plugins", id);
  const setupWitness = path.join(evidenceRoot, `${id}-setup-loaded`);
  const fullDetectorWitness = path.join(evidenceRoot, `${id}-full-detector-called`);
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, "package.json"), {
    name: `@fixture/${id}`,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"], setupEntry: "./setup-entry.js" },
  });
  writeJson(path.join(root, "openclaw.plugin.json"), {
    id,
    channels: [id],
    channelConfigs: {
      [id]: {
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    configSchema: {
      type: "object",
      properties: { region: { type: "string" }, retained: { type: "string" } },
      additionalProperties: false,
    },
  });
  write(
    path.join(root, "setup-entry.js"),
    `import fs from "node:fs";\n` +
      `import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";\n` +
      `fs.writeFileSync(${JSON.stringify(setupWitness)}, "loaded\\n");\n` +
      `export default defineSetupPluginEntry({ id: ${JSON.stringify(id)}${
        detector === "setup" ? ", lifecycle: { detectLegacyStateMigrations: () => [] }" : ""
      } });\n`,
  );
  write(
    path.join(root, "index.js"),
    `import fs from "node:fs";\n` +
      `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";\n` +
      `const plugin = {\n` +
      `  id: ${JSON.stringify(id)},\n` +
      `  meta: { id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, selectionLabel: ${JSON.stringify(id)}, docsPath: "/channels/${id}", blurb: "Upgrade survivor fixture." },\n` +
      `  capabilities: { chatTypes: ["direct"] },\n` +
      `  config: { listAccountIds: () => [], resolveAccount: () => ({ accountId: "default" }), isEnabled: () => false, isConfigured: () => false },\n` +
      (detector === "full"
        ? `  lifecycle: { detectLegacyStateMigrations: () => { fs.writeFileSync(${JSON.stringify(fullDetectorWitness)}, "called\\n"); return []; } },\n`
        : "") +
      `};\n` +
      `export default definePluginEntry({ id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, register(api) { api.registerChannel({ plugin }); } });\n`,
  );
  return { id, root, setupWitness, fullDetectorWitness };
}

function seedDeferredObligation(db, pluginId) {
  const report = {
    pluginId,
    reason: "The configured plugin package is missing or has not converged.",
    command: "openclaw update repair",
    configPaths: [["plugins", "entries", pluginId, "config"]],
  };
  db.prepare(
    `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
     VALUES (?, ?, NULL, 'pending', ?)`,
  ).run(`deferred-plugin-migration:${pluginId}`, Date.now(), JSON.stringify(report));
}

function seed() {
  assert.equal(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION, "2026.9.2");
  assert.equal(readPluginInstallRecords().codex, undefined, "Baseline already installed Codex");
  const config = readJson(configPath);
  assert.equal(
    config.agents?.ownership,
    "explicit",
    "Fixture must retain explicit agent ownership",
  );
  assert(config.agents.entries.main && config.agents.entries.ops, "Expected both baseline agents");
  const storePattern = path.join(runtimeRoot, "legacy-codex", "{agentId}", "sessions.json");
  const specimens = ["main", "ops"].map((agentId) => {
    const sessionId = `missing-plugin-${agentId}`;
    const sessionKey = `agent:${agentId}:${sessionId}`;
    const storePath = storePattern.replace("{agentId}", agentId);
    const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    const threadId = `retained-codex-thread-${agentId}`;
    writeJson(storePath, {
      [sessionKey]: {
        sessionId,
        sessionFile: path.basename(transcriptPath),
        agentHarnessId: "codex",
        updatedAt: 1,
      },
    });
    write(transcriptPath, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
    // The v2 sidecar is the shipped writer format used by Codex's migration fixture.
    writeJson(sidecarPath, {
      schemaVersion: 2,
      threadId,
      sessionFile: transcriptPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext: { fingerprint: "policy-1", apps: {}, pluginAppIds: {} },
    });
    return {
      agentId,
      sessionId,
      sessionKey,
      threadId,
      sidecarPath,
      files: Object.fromEntries(
        [storePath, transcriptPath, sidecarPath].map((file) => [file, digest(file)]),
      ),
    };
  });
  config.agents.defaults.models ??= {};
  config.agents.defaults.models["openai/gpt-5.5"] = { agentRuntime: { id: "codex" } };
  config.plugins.allow = [...new Set([...config.plugins.allow, "codex"])];
  config.plugins.entries.codex = {
    enabled: true,
    config: { codexDynamicToolsProfile: "openclaw-compat" },
  };
  const installedSetupFixtures = setupFixtures.map(installSetupFixture);
  config.plugins.allow = [
    ...new Set([...config.plugins.allow, ...installedSetupFixtures.map(({ id }) => id)]),
  ];
  config.plugins.load ??= {};
  config.plugins.load.paths = [
    ...new Set([
      ...(config.plugins.load.paths ?? []),
      ...installedSetupFixtures.map(({ root }) => root),
    ]),
  ];
  for (const { id } of installedSetupFixtures) {
    config.plugins.entries[id] = {
      enabled: true,
      config: { region: "us-en", retained: `setting-${id}` },
    };
  }
  config.session = { ...config.session, store: storePattern };
  const logPath = path.join(runtimeRoot, "logs", "missing-plugin.jsonl");
  config.logging = { ...config.logging, file: logPath, level: "warn" };
  writeJson(configPath, config);
  const db = new DatabaseSync(databasePath);
  try {
    for (const { id } of installedSetupFixtures) {
      seedDeferredObligation(db, id);
    }
  } finally {
    db.close();
  }
  writeJson(fixturePath, {
    storePattern,
    logPath,
    specimens,
    setupFixtures: installedSetupFixtures,
  });
}

function isPendingWarning(text) {
  return /Plugin "codex" (?:(?:state )?migration is (?:pending|deferred)|data\/settings upgrade is unfinished)/iu.test(
    text.replaceAll('\\"', '"'),
  );
}

function pending(stage) {
  const fixture = readJson(fixturePath);
  const config = readJson(configPath);
  assert.equal(config.session?.store, fixture.storePattern, "Deferred migration lost its locator");
  assert.equal(config.plugins.entries.codex.config.codexDynamicToolsProfile, "openclaw-compat");
  assert.equal(readPluginInstallRecords().codex, undefined, "Unavailable Codex was installed");
  for (const specimen of fixture.specimens) {
    for (const [file, expected] of Object.entries(specimen.files)) {
      assert.equal(digest(file), expected, `Deferred migration modified ${file}`);
    }
  }
  const receipt = readDatabase(databasePath, (db) =>
    db.prepare("SELECT status, report_json FROM migration_runs WHERE id = ?").get(migrationId),
  );
  assert.equal(receipt?.status, "pending", "Missing plugin has no pending migration checkpoint");
  const report = JSON.parse(receipt.report_json);
  assert.equal(report.pluginId, "codex");
  assert(
    report.reason && /^openclaw\s/u.test(report.command),
    "Pending migration lacks repair guidance",
  );
  const warnings = fs.readFileSync(fixture.logPath, "utf8");
  assert(isPendingWarning(warnings), "Owner did not persist a Codex migration warning");
  if (stage === "post-update") {
    const update = fs.readFileSync(path.join(artifactRoot, "update.json"), "utf8");
    assert(isPendingWarning(update), "Update report omitted the deferred Codex migration");
  }
  const requests = fs.readFileSync(requestPath, "utf8").trim().split("\n").map(JSON.parse);
  assert(
    requests.some((request) => request.blocked),
    "No Codex install request reached the fixture",
  );
  assert(requests.every((request) => !request.blocked || request.package === "@openclaw/codex"));
  writeJson(path.join(evidenceRoot, `${stage}.json`), {
    receipt: report,
    preserved: fixture.specimens,
  });
  if (stage === "post-doctor") {
    fs.copyFileSync(
      path.join(artifactRoot, "doctor.log"),
      path.join(evidenceRoot, "pending-doctor.log"),
    );
  }
}

function assertSetupMigrationOutcomes() {
  const fixture = readJson(fixturePath);
  const config = readJson(configPath);
  const receipts = readDatabase(databasePath, (db) =>
    Object.fromEntries(
      fixture.setupFixtures.map(({ id }) => [
        id,
        db
          .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
          .get(`deferred-plugin-migration:${id}`),
      ]),
    ),
  );
  const completed = fixture.setupFixtures.find(({ id }) => id === "public-setup-complete");
  const ambiguous = fixture.setupFixtures.find(({ id }) => id === "public-setup-ambiguous");
  assert(completed && ambiguous, "Setup fixture inventory changed");
  assert.equal(receipts[completed.id]?.status, "completed", "Public detector did not clear debt");
  assert.equal(receipts[ambiguous.id]?.status, "pending", "Ambiguous setup debt was cleared");
  assert.equal(
    JSON.parse(receipts[ambiguous.id].report_json).requiresDoctorInspection,
    true,
    "Ambiguous setup debt lost its inspection requirement",
  );
  for (const item of fixture.setupFixtures) {
    assert(fs.existsSync(item.setupWitness), `Doctor did not load ${item.id}'s public setup entry`);
    assert.deepEqual(config.plugins.entries[item.id].config, {
      region: "us-en",
      retained: `setting-${item.id}`,
    });
  }
  assert.equal(
    fs.existsSync(ambiguous.fullDetectorWitness),
    false,
    "Doctor used the full runtime entry to discharge setup-entry debt",
  );
  writeJson(path.join(evidenceRoot, "public-setup-migrations.json"), {
    completed: completed.id,
    pending: JSON.parse(receipts[ambiguous.id].report_json),
    settings: Object.fromEntries(
      fixture.setupFixtures.map(({ id }) => [id, config.plugins.entries[id].config]),
    ),
  });
}

function assertLegacyDriverRefusal([updateJson, updateErr, expectedVersion, packageRoot]) {
  assert(
    updateJson && updateErr && expectedVersion && packageRoot,
    "Missing refusal evidence paths",
  );
  const evidence = `${fs.readFileSync(updateJson, "utf8")}\n${fs.readFileSync(updateErr, "utf8")}`;
  assert(
    evidence.includes("driver PID and host not recorded, liveness: not observed"),
    "Published updater did not hit the expected identityless-driver refusal",
  );
  assert.equal(readJson(path.join(packageRoot, "package.json")).version, expectedVersion);
  const latest = readDatabase(databasePath, (db) =>
    db
      .prepare(
        "SELECT status, phase, finished_at_ms FROM update_runs ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get(),
  );
  assert(latest, "Published updater did not record an update run");
  assert.notEqual(latest.status, "running", "Published updater retained live authority after exit");
  assert.equal(latest.phase, "finished", "Published updater did not terminalize its run");
  assert.equal(typeof latest.finished_at_ms, "number");
}

function cli(name, argv) {
  const out = fs.openSync(path.join(evidenceRoot, `${name}.json`), "w");
  const err = fs.openSync(path.join(evidenceRoot, `${name}.err`), "w");
  try {
    execFileSync("openclaw", argv, { stdio: ["ignore", out, err], timeout: 120_000 });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  return readJson(path.join(evidenceRoot, `${name}.json`));
}

function diagnostics() {
  const status = cli("update-status", ["update", "status", "--json"]);
  assert(isPendingWarning(JSON.stringify(status)), "Update status omitted the migration warning");
  const triage = cli("triage", ["triage", "--non-interactive", "--json"]);
  assert(triage.bundlePath, `Support export failed: ${triage.bundleError}`);
  const logs = execFileSync(
    "python3",
    [
      "-c",
      'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("logs/openclaw-sanitized.jsonl").decode())',
      triage.bundlePath,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  assert(isPendingWarning(logs), "Support bundle omitted the owner migration warning");
  write(path.join(evidenceRoot, "support-warnings.jsonl"), logs);
}

function resumed(expectedVersion) {
  assert(expectedVersion, "Missing expected Codex package version");
  const installed = readPluginInstallRecords().codex;
  assert(installed?.installPath, "Doctor did not install the configured Codex plugin");
  const packageJson = readJson(path.join(installed.installPath, "package.json"));
  assert.equal(packageJson.name, "@openclaw/codex");
  assert.equal(packageJson.version, expectedVersion, "Doctor installed a different Codex version");
  const fixture = readJson(fixturePath);
  const imported = readDatabase(databasePath, (db) => {
    const receipt = db.prepare("SELECT status FROM migration_runs WHERE id = ?").get(migrationId);
    assert.equal(receipt?.status, "completed", "Deferred migration remained pending after Doctor");
    return fixture.specimens.map((specimen) => {
      const key = `session-key:${specimen.agentId}:${createHash("sha256").update(specimen.sessionKey).digest("base64url")}`;
      const row = db
        .prepare(
          "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
        )
        .get("codex", bindingNamespace, key);
      assert(row, `Codex did not import ${specimen.agentId}'s binding`);
      const stored = JSON.parse(row.value_json);
      assert.equal(stored.state, "active");
      assert.equal(stored.sessionId, specimen.sessionId);
      assert.equal(stored.binding.threadId, specimen.threadId);
      assert.equal(fs.existsSync(specimen.sidecarPath), false, "Imported sidecar was not retired");
      assert.equal(
        digest(`${specimen.sidecarPath}.migrated`),
        specimen.files[specimen.sidecarPath],
      );
      return {
        agentId: specimen.agentId,
        sessionId: stored.sessionId,
        threadId: stored.binding.threadId,
      };
    });
  });
  const config = readJson(configPath);
  assert.equal(config.plugins.entries.codex.config.codexDynamicToolsProfile, undefined);
  const status = cli("update-status-resumed", ["update", "status", "--json"]);
  const warnings = status.migrationWarnings;
  assert(Array.isArray(warnings), "Pending ambiguous setup debt lost its update warning");
  assert.equal(
    warnings.filter((warning) =>
      warning.startsWith('Plugin "public-setup-ambiguous" data/settings upgrade is unfinished:'),
    ).length,
    1,
    "Ambiguous setup debt did not retain exactly one owner warning",
  );
  assert.equal(
    warnings.some((warning) =>
      warning.startsWith('Plugin "codex" data/settings upgrade is unfinished:'),
    ),
    false,
    "Completed Codex migration retained its owner warning",
  );
  const retainedSourceWarnings = warnings.filter((warning) =>
    warning.includes("[plugin_migration_source_retained]"),
  );
  assert.equal(
    retainedSourceWarnings.length,
    fixture.specimens.length,
    "Ambiguous setup debt did not retain every protected migration source warning",
  );
  assert(
    retainedSourceWarnings.every((warning) => warning.includes("public-setup-ambiguous")),
    "Protected source warnings omitted the pending ambiguous owner",
  );
  for (const specimen of fixture.specimens) {
    const storePath = Object.keys(specimen.files).find((file) => file.endsWith("/sessions.json"));
    assert(
      storePath && retainedSourceWarnings.some((warning) => warning.startsWith(`${storePath}:`)),
      `Protected source warning omitted ${specimen.agentId}'s session store`,
    );
  }
  assert.equal(
    warnings.length,
    retainedSourceWarnings.length + 1,
    "Resumed update retained an unexpected migration warning",
  );
  assert.equal(
    status.migrationWarningsError,
    undefined,
    "Completed migration status is unreadable",
  );
  writeJson(path.join(evidenceRoot, "resumed.json"), {
    migrationStatus: "completed",
    installed: { name: packageJson.name, version: packageJson.version },
    imported,
  });
}

async function serve([portFile, npmUpstream, clawhubUpstream]) {
  assert(portFile && npmUpstream && clawhubUpstream, "Missing fixture registry endpoints");
  let available = false;
  write(requestPath, "");
  async function proxy(upstream, label) {
    const upstreamUrl = new URL(upstream);
    const server = http.createServer((request, response) => {
      if (request.method === "POST" && request.url === "/__fixture__/available") {
        available = true;
        response.end("available");
        return;
      }
      const requestUrl = new URL(request.url, "http://fixture");
      const decoded = decodeURIComponent(requestUrl.pathname);
      const codex = /\/@openclaw\/codex(?:\/|$)/u.test(decoded);
      const blocked = codex && !available;
      fs.appendFileSync(
        requestPath,
        `${JSON.stringify({ registry: label, path: decoded, package: codex ? "@openclaw/codex" : null, blocked })}\n`,
      );
      if (blocked) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Codex is unavailable in this fixture" }));
        return;
      }
      const relay = http.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          path: `${requestUrl.pathname}${requestUrl.search}`,
          method: request.method,
          // Keep package download URLs on this proxy while the upstream serves its bytes.
          headers: request.headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      relay.on("error", (error) => {
        response.writeHead(502);
        response.end(String(error));
      });
      request.pipe(relay);
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  }
  const endpoints = {
    npm: await proxy(npmUpstream, "npm"),
    clawhub: await proxy(clawhubUpstream, "clawhub"),
  };
  writeJson(`${portFile}.tmp`, endpoints);
  fs.renameSync(`${portFile}.tmp`, portFile);
}

if (command === "seed") {
  seed();
} else if (command === "pending") {
  pending(args[0]);
} else if (command === "diagnostics") {
  diagnostics();
} else if (command === "resumed") {
  resumed(args[0]);
} else if (command === "setup-outcomes") {
  assertSetupMigrationOutcomes();
} else if (command === "legacy-driver-refusal") {
  assertLegacyDriverRefusal(args);
} else if (command === "serve") {
  await serve(args);
} else if (command === "available") {
  const endpoints = readJson(args[0]);
  const response = await fetch(`${endpoints.npm}/__fixture__/available`, { method: "POST" });
  assert(response.ok, "Could not expose the prepared Codex artifact");
  await response.body?.cancel();
} else {
  throw new Error(`Unknown missing-plugin fixture command: ${command}`);
}
