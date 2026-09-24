import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const [command, ...args] = process.argv.slice(2);
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(runtimeRoot && artifactRoot && stateDir && configPath, "Missing survivor fixture paths");
const evidenceRoot = path.join(artifactRoot, "missing-plugin");
const fixturePath = path.join(evidenceRoot, "fixture.json");
const requestPath = path.join(evidenceRoot, "registry-requests.jsonl");
const migrationId = "deferred-plugin-migration:codex";
const bindingNamespace = "app-server-thread-bindings";

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  config.session = { ...config.session, store: storePattern };
  const logPath = path.join(runtimeRoot, "logs", "missing-plugin.jsonl");
  config.logging = { ...config.logging, file: logPath, level: "warn" };
  writeJson(configPath, config);
  writeJson(fixturePath, { storePattern, logPath, specimens });
}

function withDatabase(read) {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function isPendingWarning(text) {
  return /Plugin "codex" (?:state )?migration is (?:pending|deferred)/iu.test(
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
  const receipt = withDatabase((db) =>
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
  const imported = withDatabase((db) => {
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
  assert.equal(
    status.migrationWarnings,
    undefined,
    "Completed migrations still have active warnings",
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
