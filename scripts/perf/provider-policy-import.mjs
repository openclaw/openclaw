// Cold-import fixture: load real provider policies through production facade resolution.
// node scripts/perf/module-import-measure.mjs --entry "$PWD/scripts/perf/provider-policy-import.mjs"
//   --iterations 5 --mode timing --output .local/provider-policy-timing.json
// Repeat with --mode allocation in a separate pass; build each revision first.
// Run module-import-measure.mjs from the measured checkout. Discovery records are
// synthetic; selected artifacts, policy code, resolution and module loaders are real.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const dist = path.join(root, "dist");
const files = readdirSync(dist).toSorted();
async function loadExport(prefix, symbol) {
  for (const file of files) {
    if (!file.startsWith(`${prefix}-`) || !file.endsWith(".mjs")) {
      continue;
    }
    const filePath = path.join(dist, file);
    const source = readFileSync(filePath, "utf8");
    const clauses = [...source.matchAll(/^export \{([^}]+)\};?$/gm)];
    for (const clause of clauses) {
      for (const member of clause[1].split(",")) {
        const [local, exported = local] = member.trim().split(/\s+as\s+/);
        if (local !== symbol && exported !== symbol) {
          continue;
        }
        const value = (await import(pathToFileURL(filePath).href))[exported];
        assert.equal(typeof value, "function", `${symbol} missing from ${file}`);
        return value;
      }
    }
  }
  throw new Error(`Built export ${symbol} missing (${prefix})`);
}

const createRegistry = await loadExport("registry-empty", "createEmptyPluginRegistry");
const bindArtifact = await loadExport(
  "plugin-runtime-artifact-binding",
  "bindPluginRuntimeArtifactSelection",
);
const withRegistry = await loadExport("gateway-request-scope", "withPluginRuntimeRegistryScope");
const directPolicy = await loadExport(
  "provider-policy-surface",
  "resolveDirectBundledProviderPolicySurface",
);
const registry = createRegistry();
for (const id of ["deepseek", "moonshot"]) {
  const rootDir = path.join(root, "extensions", id);
  const source = path.join(rootDir, "index.ts");
  const builtRoot = path.join(dist, "extensions", id);
  const record = {
    id,
    rootDir,
    source,
    origin: "bundled",
    status: "loaded",
    enabled: true,
    channelIds: [],
  };
  bindArtifact(record, {
    rootDir,
    source,
    packageManifest: { build: { bundledDist: false } },
    preferBuiltPluginArtifacts: true,
    runtimeEntry: { rootDir: builtRoot, source: path.join(builtRoot, "index.js") },
  }).runtimeRegistrationComplete = true;
  registry.plugins.push(record);
}

withRegistry(registry, () => {
  const deepseek = directPolicy("deepseek");
  const moonshot = directPolicy("moonshot");
  const deepseekThinking = deepseek?.resolveThinkingProfile?.({
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(deepseekThinking?.defaultLevel, "high");
  assert.deepEqual(
    deepseekThinking?.levels.map(({ id }) => id),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
  const providerConfig = { models: [{ id: "synthetic-unknown-model" }] };
  assert.equal(deepseek.normalizeConfig({ provider: "deepseek", providerConfig }), providerConfig);
  assert.equal(
    moonshot?.resolveThinkingProfile?.({
      provider: "moonshot",
      modelId: "kimi-k3",
    })?.defaultLevel,
    "max",
  );
});

const babelModules = Object.keys(createRequire(import.meta.url).cache).filter((file) =>
  /[/\\]jiti[/\\]dist[/\\]babel\.cjs$/.test(file),
);
const proof = { policiesChecked: ["deepseek", "moonshot"], babelModules };
if (process.env.OPENCLAW_BENCH_POLICY_PROOF) {
  // Write diagnostics after module-import-measure has captured its timed boundary.
  process.once("beforeExit", () =>
    writeFileSync(process.env.OPENCLAW_BENCH_POLICY_PROOF, `${JSON.stringify(proof, null, 2)}\n`),
  );
}
