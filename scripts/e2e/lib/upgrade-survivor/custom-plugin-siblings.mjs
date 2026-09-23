import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(root && artifacts && stateDir && configPath, "Missing isolated survivor paths");
const pluginId = "survivor-sibling-memory";
const pluginRoot = path.join(root, "custom-plugins", "memory");
const sharedRoot = path.join(root, "custom-plugins", "shared");
const registrations = path.join(artifacts, "sibling-registrations.jsonl");
const evidencePath = path.join(artifacts, "sibling-source.json");
const marker = "OPENCLAW_SIBLING_SOURCE_OK";

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function seed() {
  write(registrations, "");
  const observe = (surface) => `fs.appendFileSync(${JSON.stringify(registrations)}, JSON.stringify({
      value,
      surface: ${JSON.stringify(surface)},
      stateDir: process.env.OPENCLAW_STATE_DIR,
      source: import.meta.url,
      sharedSource,
      sourceSha256: createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex"),
      sharedSourceSha256: createHash("sha256").update(fs.readFileSync(new URL(sharedSource))).digest("hex"),
      argv: process.argv.slice(2),
    }) + "\\n");`;
  const files = {
    [path.join(pluginRoot, "package.json")]: JSON.stringify({
      name: "@openclaw-test/survivor-sibling-memory",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
    [path.join(pluginRoot, "openclaw.plugin.json")]: JSON.stringify({
      id: pluginId,
      kind: "memory",
      doctorContract: { configRepair: true },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    [path.join(sharedRoot, "value.mjs")]:
      `export default ${JSON.stringify(marker)};\nexport const sharedSource = import.meta.url;\n`,
    [path.join(pluginRoot, "index.mjs")]: `import fs from "node:fs";
import { createHash } from "node:crypto";
import value, { sharedSource } from "../shared/value.mjs";
export default {
  id: ${JSON.stringify(pluginId)},
  kind: "memory",
  register() {
    ${observe("runtime")}
  },
};
`,
    [path.join(pluginRoot, "doctor-contract-api.mjs")]: `import fs from "node:fs";
import { createHash } from "node:crypto";
import value, { sharedSource } from "../shared/value.mjs";
${observe("doctor-module")}
export function normalizeCompatibilityConfig({ cfg }) {
  ${observe("doctor-contract")}
  return { config: cfg, changes: [] };
}
`,
  };
  for (const [file, contents] of Object.entries(files)) {
    write(file, contents);
  }
  write(
    evidencePath,
    JSON.stringify(Object.fromEntries(Object.keys(files).map((file) => [file, digest(file)]))),
  );
  write(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "survivor-sibling-token" },
        controlUi: { enabled: false },
      },
      agents: { defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } } },
      plugins: {
        allow: [pluginId],
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true } },
        slots: { memory: pluginId },
      },
    }),
  );
}

function inspect(stage) {
  const result = spawnSync("openclaw", ["plugins", "inspect", pluginId, "--runtime", "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  write(path.join(artifacts, `sibling-${stage}.json`), result.stdout ?? "");
  write(path.join(artifacts, `sibling-${stage}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `Plugin runtime inspection failed: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.plugin?.status, "loaded", `Custom plugin did not load: ${result.stdout}`);
  console.log(`${stage}: enabled sibling-import plugin loaded`);
}

function assertCanary() {
  const events = fs
    .readFileSync(registrations, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const canary = events.filter(
    (event) => event.stateDir !== stateDir && event.stateDir?.includes("openclaw-update-canary-"),
  );
  assert(
    canary.some((event) => event.surface === "doctor-contract"),
    "No custom plugin Doctor contract execution from the private update canary; healthy readiness alone does not prove sibling imports",
  );
  assert(
    canary.some((event) => event.surface === "runtime" && event.argv.includes("--update-canary")),
    "The private Gateway canary did not register the enabled custom plugin",
  );
  for (const event of canary) {
    assert.equal(event.value, marker, "Canary loaded the wrong sibling source");
    for (const field of ["source", "sharedSource"]) {
      const url = new URL(event[field]);
      assert.equal(url.protocol, "file:", `Canary ${field} is not a file URL`);
      const relative = path.relative(event.stateDir, fileURLToPath(url));
      assert(
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Canary ${field} resolved outside its private state: ${event[field]}`,
      );
    }
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(
    config.plugins.entries[pluginId].enabled,
    true,
    "Updater disabled the custom plugin",
  );
  assert.equal(config.plugins.slots.memory, pluginId, "Updater replaced the memory plugin");
  for (const [file, expected] of Object.entries(
    JSON.parse(fs.readFileSync(evidencePath, "utf8")),
  )) {
    assert.equal(digest(file), expected, `Updater changed original plugin source: ${file}`);
  }
  write(
    path.join(artifacts, "sibling-canary.json"),
    JSON.stringify({ marker, registrations: canary }, null, 2),
  );
  console.log(
    `canary: ${canary.length} actual plugin executions resolved sibling source; original files preserved`,
  );
}

const [mode] = process.argv.slice(2);
if (mode === "seed") {
  seed();
} else if (mode === "baseline" || mode === "candidate") {
  inspect(mode);
} else if (mode === "assert-canary") {
  assertCanary();
} else {
  throw new Error(`Unknown sibling fixture mode: ${mode}`);
}
