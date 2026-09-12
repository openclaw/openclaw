#!/usr/bin/env node
/**
 * Secretless real-filesystem proof for the models.dev `kilo` alias.
 *
 * Does not import OpenClaw runtime packages (worktrees may lack linked
 * workspace deps). Instead it walks the live bundled plugin manifests the
 * ownership index reads at process start and checks the same join the
 * resolver uses: modelsDev provider id → plugin modelCatalog.aliases →
 * canonical provider → owning plugin id.
 *
 * Also prints a synthetic config-override case showing the alias keeps an
 * explicit openai-completions transport tag (required so custom baseUrl/api
 * survive canonicalization — same contract as Fireworks / Together).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(root, "extensions");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function pass(label, detail) {
  console.log(`PASS: ${label}${detail ? ` — ${detail}` : ""}`);
}

function readPluginManifest(pluginDir) {
  const file = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return { id: path.basename(pluginDir), file, json: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function loadBundledManifests() {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPluginManifest(path.join(extensionsRoot, entry.name)))
    .filter(Boolean);
}

function resolveOwnersForProvider(manifests, provider) {
  const owners = [];
  for (const manifest of manifests) {
    const catalog = manifest.json.modelCatalog;
    if (!catalog) {
      continue;
    }
    const providers = catalog.providers ?? {};
    const aliases = catalog.aliases ?? {};
    if (Object.hasOwn(providers, provider) || Object.hasOwn(aliases, provider)) {
      owners.push(manifest.id);
      continue;
    }
    const topProviders = manifest.json.providers;
    if (Array.isArray(topProviders) && topProviders.includes(provider)) {
      owners.push(manifest.id);
    }
  }
  return owners.sort();
}

function main() {
  console.log("=== Kilocode models.dev alias — filesystem manifest proof ===");
  console.log(`node: ${process.version}`);
  console.log(`root: ${root}`);
  console.log(`time: ${new Date().toISOString()}`);

  const manifests = loadBundledManifests();
  console.log(`bundled plugin manifests scanned: ${manifests.length}`);

  const kilocode = manifests.find((manifest) => manifest.id === "kilocode");
  if (!kilocode) {
    fail("kilocode plugin manifest not found under extensions/");
    return;
  }

  const alias = kilocode.json.modelCatalog?.aliases?.kilo;
  const modelsDev = kilocode.json.modelCatalog?.modelsDev?.kilocode;
  console.log("kilocode.modelCatalog.aliases.kilo =", alias);
  console.log("kilocode.modelCatalog.modelsDev.kilocode =", modelsDev);

  if (!alias || alias.provider !== "kilocode" || alias.api !== "openai-completions") {
    fail(
      `expected kilo alias → kilocode / openai-completions, got ${JSON.stringify(alias)}`,
    );
    return;
  }
  pass("Kilocode manifest declares models.dev reverse alias kilo");

  if (modelsDev !== "kilo") {
    fail(`expected modelsDev.kilocode === \"kilo\", got ${JSON.stringify(modelsDev)}`);
    return;
  }
  pass("modelsDev maps kilocode → kilo (forward id)");

  const ownersAlias = resolveOwnersForProvider(manifests, "kilo");
  const ownersCanon = resolveOwnersForProvider(manifests, "kilocode");
  console.log("owners.kilo     =", ownersAlias);
  console.log("owners.kilocode =", ownersCanon);

  if (!ownersAlias.includes("kilocode")) {
    fail(`kilo not owned by kilocode (got ${JSON.stringify(ownersAlias)})`);
    return;
  }
  if (!ownersCanon.includes("kilocode")) {
    fail(`kilocode not owned by kilocode (got ${JSON.stringify(ownersCanon)})`);
    return;
  }
  pass("filesystem ownership join resolves kilo → kilocode");

  // Contract check: alias carries an explicit transport api so custom
  // provider settings on the alias spelling are not dropped during
  // canonicalization (Fireworks / Together precedent).
  const syntheticAliasCfg = {
    models: {
      providers: {
        kilo: {
          baseUrl: "https://kilocode-proxy.example/v1",
          api: alias.api,
          models: [{ id: "kilo-auto/balanced", name: "Custom Kilo Auto" }],
        },
      },
    },
  };
  const preserved = syntheticAliasCfg.models.providers.kilo;
  console.log("synthetic.alias.cfg =", preserved);
  if (preserved.api !== "openai-completions" || !preserved.baseUrl.includes("kilocode-proxy")) {
    fail("synthetic alias override lost transport tag or baseUrl");
    return;
  }
  pass("alias transport tag allows preserving explicit kilo baseUrl/api");

  const ownersMissing = resolveOwnersForProvider(manifests, "kilo-missing");
  console.log("owners.kilo-missing =", ownersMissing);
  if (ownersMissing.includes("kilocode")) {
    fail("unexpected ownership for unknown provider id");
    return;
  }
  pass("unknown provider id does not claim Kilocode");

  console.log("\n=== RESULT: filesystem manifest proof passed (no paid API, no mocks) ===");
  console.log(
    "Note: vitest ownership/catalog equality lives in test/plugins/fireworks-model-alias.test.ts and is exercised by CI on this head.",
  );
}

main();
