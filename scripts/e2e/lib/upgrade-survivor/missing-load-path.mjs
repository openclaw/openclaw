import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(runtimeRoot && artifactRoot && configPath, "Missing isolated survivor paths");
const pluginId = "survivor-unavailable-path";
const pluginRoot = path.join(runtimeRoot, "custom-plugins", pluginId);
const evidenceRoot = path.join(artifactRoot, "missing-load-path");
const fixturePath = path.join(evidenceRoot, "fixture.json");
const registrationPath = path.join(evidenceRoot, "baseline-registration.json");
const code = "configured-plugin-path-unavailable";
const message = `Configured plugin load path is unavailable: ${pluginRoot}. Uninspected plugin configuration is preserved. Restore access to the path, then run \`openclaw doctor --fix\`.`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function memberBytes(key, value, indentation) {
  return JSON.stringify({ [key]: value }, null, 2)
    .slice(2, -2)
    .split("\n")
    .map((line) => " ".repeat(indentation) + line)
    .join("\n");
}

function seed() {
  const config = readJson(configPath);
  writeJson(path.join(pluginRoot, "package.json"), {
    name: "@openclaw-test/survivor-unavailable-path",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: pluginId,
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: true },
  });
  fs.writeFileSync(
    path.join(pluginRoot, "index.mjs"),
    `import fs from "node:fs";
export default {
  id: ${JSON.stringify(pluginId)},
  register() {
    fs.writeFileSync(${JSON.stringify(registrationPath)}, JSON.stringify({ source: import.meta.url }));
  },
};\n`,
  );
  config.plugins.allow.push(pluginId);
  config.plugins.load = { paths: [pluginRoot] };
  config.plugins.entries[pluginId] = {
    enabled: true,
    config: { retained: { text: "Preserve my unavailable plugin configuration.", count: 7 } },
  };
  writeJson(configPath, config);
  writeJson(fixturePath, {
    pluginRoot,
    entryBytes: memberBytes(pluginId, config.plugins.entries[pluginId], 4),
    loadBytes: memberBytes("load", config.plugins.load, 2),
  });
}

function assertPreserved(stage) {
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const fixture = readJson(fixturePath);
  assert.equal(fs.existsSync(pluginRoot), false, "Configured load path unexpectedly exists");
  assert(
    config.plugins.allow.includes(pluginId),
    `${stage}: unavailable plugin allow entry removed`,
  );
  assert(raw.includes(fixture.entryBytes), `${stage}: uninspected plugin entry bytes changed`);
  assert(raw.includes(fixture.loadBytes), `${stage}: configured load path bytes changed`);
}

const stage = process.argv[3];
if (stage === "seed") {
  seed();
} else if (stage === "unavailable") {
  assert.equal(
    readJson(registrationPath).source,
    pathToFileURL(path.join(pluginRoot, "index.mjs")).href,
    "The published baseline did not load the configured fixture plugin",
  );
  fs.rmSync(pluginRoot, { recursive: true });
  assertPreserved(stage);
  console.log(`Removed loaded baseline plugin source before update: ${pluginRoot}`);
} else {
  assertPreserved(stage);
  if (stage === "post-update") {
    const raw = fs.readFileSync(path.join(artifactRoot, "update.json"), "utf8");
    const update = JSON.parse(raw.slice(raw.indexOf("{")));
    assert.equal(update.status, "ok", "Missing load path must not require update recovery");
    assert(
      update.postUpdate?.plugins?.warnings?.some(
        (warning) => warning.reason === code && warning.message === message,
      ),
      "Update report omitted the typed configured-load-path warning",
    );
  } else if (stage === "post-doctor") {
    const report = readJson(path.join(evidenceRoot, "doctor-lint.json"));
    assert.equal(report.ok, false, "Standalone lint must report the selected warning threshold");
    assert(report.findings.every((finding) => finding.severity === "warning"));
    const finding = [...report.findings, ...(report.warnings ?? [])].find(
      (entry) => entry.requirement === code,
    );
    assert(finding, "Doctor lint omitted the typed configured-load-path warning");
    assert.equal(finding.source, pluginRoot);
    assert.equal(finding.severity, "warning");
    assert.equal(finding.target, "configured-unavailable");
    assert.equal(finding.message, message);
    assert.equal(finding.fixHint, "openclaw doctor --fix");
  } else if (stage === "ready") {
    assert.equal(readJson(path.join(artifactRoot, "readyz.json")).body.ready, true);
    assert.equal(readJson(path.join(artifactRoot, "status.json")).rpc.ok, true);
  } else {
    throw new Error(`Unknown missing-load-path fixture stage: ${stage}`);
  }
  writeJson(path.join(evidenceRoot, `${stage}.json`), {
    stage,
    code,
    message,
    configurationBytesPreserved: true,
    pathAbsent: true,
  });
  console.log(`${stage}: ${message} Configuration bytes preserved.`);
}
