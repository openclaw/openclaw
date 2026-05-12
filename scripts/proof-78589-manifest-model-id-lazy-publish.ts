/**
 * Real-runtime behavior proof for #78589 (perf/manifest-model-id-lazy-publish).
 *
 * This script does NOT use vitest mocks. It wires up the production
 * model-id-normalization hot path against:
 *   - real on-disk plugin install index + manifest in a temp dir
 *   - the real `setActivePluginRegistry` runtime state (no fake)
 *   - the real `loadPluginMetadataSnapshot` walk of the installed
 *     plugin index (no fake)
 *   - the real `setCurrentPluginMetadataSnapshot` /
 *     `getCurrentPluginMetadataSnapshot` single-slot handoff
 *   - the real `normalizeProviderModelIdWithManifest` public surface
 *     (the entry point hot-path callers like the model-resolution
 *     pipeline reach through `resolveMetadataSnapshotForPolicies`)
 *
 * It then exercises three scenarios:
 *
 *   1. Gateway flow, cold slot (the bug):
 *      An active plugin-registry workspace is set; the
 *      `current-plugin-metadata-snapshot` slot is empty (the post-fix
 *      writePersistedInstalledPluginIndex behavior). The first
 *      `normalizeProviderModelIdWithManifest` call must:
 *        - return the normalized model id ("alpha/demo-model")
 *        - re-publish the freshly loaded snapshot to the slot
 *      Subsequent calls must reuse the slot and NOT re-read the
 *      installed plugin index off disk.
 *
 *   2. Gateway flow, warm slot:
 *      A snapshot is already published. Calls must reuse it and NOT
 *      re-read the index. (Pre-existing behavior; pin it.)
 *
 *   3. CLI flow (no active plugin-registry workspace):
 *      No `setActivePluginRegistry`. The slot must NEVER be re-published
 *      from inside `resolveMetadataSnapshotForPolicies`, so each call
 *      re-reads the index from disk. This preserves the manifest-edit
 *      detection contract for CLI surfaces (`openclaw plugins list`,
 *      `openclaw status`, etc.) where a long-lived published snapshot
 *      would mask file edits between invocations.
 *
 * The proof is self-checking: it counts reads of `plugins/installs.json`
 * via an `fs.readFileSync` instrumentation hook installed at module load,
 * runs N=5 normalize calls per scenario, and asserts the read counts
 * match the documented contract. A regression in any direction (slot
 * not refilled, slot refilled in CLI flow, or slot bypassed for
 * gateway-flow re-publish) will throw and exit non-zero.
 *
 * Run with:
 *   pnpm tsx scripts/proof-78589-manifest-model-id-lazy-publish.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "../src/plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../src/plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "../src/plugins/installed-plugin-index.js";
import { normalizeProviderModelIdWithManifest } from "../src/plugins/manifest-model-id-normalization.js";
import type { PluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";

// -- Disk-IO instrumentation ------------------------------------------------
//
// Wrap `fs.openSync` so we can count opens of the installed-plugin index
// file (`<stateDir>/plugins/installs.json`). The fs-safe `tryReadJsonSync`
// path the production code uses opens the file with `openSync` + `readSync`
// rather than `readFileSync`, so wrapping `openSync` is the right hook.
// The wrapper does not alter behavior; it just records each matching open.
// This is the perf invariant the fix is supposed to enforce: gateway-flow
// opens of the index should stay at 1 (cold load + warm-slot reuse), not N.

const indexReadsByPath = new Map<string, number>();
const originalOpenSync = fs.openSync.bind(fs);

(fs.openSync as unknown) = ((...args: Parameters<typeof fs.openSync>) => {
  const filePath = args[0];
  if (
    typeof filePath === "string" &&
    filePath.endsWith(`${path.sep}plugins${path.sep}installs.json`)
  ) {
    indexReadsByPath.set(filePath, (indexReadsByPath.get(filePath) ?? 0) + 1);
  }
  return originalOpenSync(...args);
}) as typeof fs.openSync;

function snapshotIndexReads(stateDir: string): number {
  const indexPath = path.join(stateDir, "plugins", "installs.json");
  return indexReadsByPath.get(indexPath) ?? 0;
}

function resetIndexReadsFor(stateDir: string): void {
  const indexPath = path.join(stateDir, "plugins", "installs.json");
  indexReadsByPath.delete(indexPath);
}

// -- Fixture setup ----------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-manifest-model-id-"));
  tempDirs.push(dir);
  return dir;
}

function writeInstallIndex(params: { stateDir: string; pluginDir: string }): void {
  const indexPath = path.join(params.stateDir, "plugins", "installs.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      plugins: [
        {
          id: "normalizer",
          rootDir: params.pluginDir,
          origin: "global",
        },
      ],
    }),
    "utf-8",
  );
}

function writeNormalizerManifest(params: { pluginDir: string; prefix: string }): void {
  fs.mkdirSync(params.pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "normalizer",
      configSchema: { type: "object" },
      providers: ["demo"],
      modelIdNormalization: {
        providers: {
          demo: { prefixWhenBare: params.prefix },
        },
      },
    }),
    "utf-8",
  );
}

function buildPublishedSnapshot(params: {
  manifestHash: string;
  prefix: string;
  workspaceDir: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "proof-host",
    compatRegistryVersion: "proof-compat",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [
      {
        pluginId: "normalizer",
        manifestPath: `/tmp/normalizer-${params.manifestHash}/openclaw.plugin.json`,
        manifestHash: params.manifestHash,
        source: `/tmp/normalizer-${params.manifestHash}/index.ts`,
        rootDir: `/tmp/normalizer-${params.manifestHash}`,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
  return {
    policyHash,
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(
      {},
      { env: process.env, index, policyHash, workspaceDir: params.workspaceDir },
    ),
    workspaceDir: params.workspaceDir,
    index,
    plugins: [
      {
        id: "normalizer",
        modelIdNormalization: {
          providers: { demo: { prefixWhenBare: params.prefix } },
        },
      },
    ],
  } as unknown as PluginMetadataSnapshot;
}

function configureEnvForStateDir(stateDir: string): void {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
}

function normalizeOnce(modelId = "demo-model"): string | undefined {
  return normalizeProviderModelIdWithManifest({
    provider: "demo",
    context: { provider: "demo", modelId },
  });
}

// -- Assertions -------------------------------------------------------------

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(
      `[proof-manifest] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDefined<T>(label: string, value: T | undefined): asserts value is T {
  if (value === undefined) {
    throw new Error(`[proof-manifest] ${label}: expected defined, got undefined`);
  }
}

function assertUndefined(label: string, value: unknown): void {
  if (value !== undefined) {
    throw new Error(`[proof-manifest] ${label}: expected undefined, got ${JSON.stringify(value)}`);
  }
}

// -- Scenarios --------------------------------------------------------------

const N = 5;

function scenarioGatewayColdSlot(): void {
  console.log(`\n[proof-manifest] Scenario 1: gateway flow, cold slot (the bug fix).`);
  resetPluginRuntimeStateForTest();
  clearCurrentPluginMetadataSnapshot();

  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "extensions", "normalizer");
  writeInstallIndex({ stateDir, pluginDir });
  writeNormalizerManifest({ pluginDir, prefix: "alpha" });
  configureEnvForStateDir(stateDir);

  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    "workspace-active",
    "gateway-bindable",
    stateDir,
  );

  resetIndexReadsFor(stateDir);
  assertUndefined("cold-slot precondition", getCurrentPluginMetadataSnapshot());

  // Call 1: cold load. The fix's contract is that this load also re-publishes
  // the snapshot to the current-snapshot slot so subsequent calls reuse it.
  // We intentionally do NOT pin the exact open count for the cold load itself
  // (`loadPluginMetadataSnapshot` legitimately opens the index file for
  // content-hashing in addition to parsing, and the shape of that bookkeeping
  // is not what this fix changes). What we DO pin is that calls 2..N must add
  // zero opens, because the slot is now warm.
  assertEqual("gateway cold-slot call 1 result", normalizeOnce(), "alpha/demo-model");
  const coldLoadReads = snapshotIndexReads(stateDir);
  console.log(`[proof-manifest]   call 1 (cold) -> ${coldLoadReads} installs.json open(s).`);
  if (coldLoadReads < 1) {
    throw new Error(
      `[proof-manifest] gateway cold-slot expected at least 1 installs.json open on cold load, observed ${coldLoadReads}.`,
    );
  }
  const refilled = getCurrentPluginMetadataSnapshot({ workspaceDir: stateDir });
  assertDefined("cold-slot post-call snapshot", refilled);
  assertEqual("cold-slot post-call workspaceDir", refilled.workspaceDir, stateDir);

  // Calls 2..N: the slot is warm, so they MUST add zero new opens of the
  // index file. This is the actual perf invariant the fix establishes.
  resetIndexReadsFor(stateDir);
  for (let i = 1; i < N; i += 1) {
    assertEqual(
      `gateway warm-after-cold call ${i + 1} result`,
      normalizeOnce(),
      "alpha/demo-model",
    );
  }
  const warmReads = snapshotIndexReads(stateDir);
  console.log(
    `[proof-manifest]   calls 2..${N} (slot warmed by fix) -> ${warmReads} installs.json open(s).`,
  );
  if (warmReads !== 0) {
    throw new Error(
      `[proof-manifest] gateway warm-after-cold perf invariant violated: expected 0 installs.json opens across ${N - 1} subsequent calls, observed ${warmReads}.`,
    );
  }
}

function scenarioGatewayWarmSlot(): void {
  console.log(`\n[proof-manifest] Scenario 2: gateway flow, warm slot (pre-existing reuse).`);
  resetPluginRuntimeStateForTest();
  clearCurrentPluginMetadataSnapshot();

  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "extensions", "normalizer");
  writeInstallIndex({ stateDir, pluginDir });
  writeNormalizerManifest({ pluginDir, prefix: "beta" });
  configureEnvForStateDir(stateDir);

  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    "workspace-active",
    "gateway-bindable",
    stateDir,
  );

  // Publish a snapshot the way gateway boot does.
  setCurrentPluginMetadataSnapshot(
    buildPublishedSnapshot({ manifestHash: "beta", prefix: "beta", workspaceDir: stateDir }),
    { config: {}, env: process.env, workspaceDir: stateDir },
  );
  resetIndexReadsFor(stateDir);

  for (let i = 0; i < N; i += 1) {
    assertEqual(`gateway warm-slot call ${i + 1} result`, normalizeOnce(), "beta/demo-model");
  }

  const reads = snapshotIndexReads(stateDir);
  console.log(`[proof-manifest]   ${N} normalize calls -> ${reads} installs.json open(s).`);
  if (reads !== 0) {
    throw new Error(
      `[proof-manifest] gateway warm-slot perf invariant violated: expected 0 installs.json opens across ${N} normalize calls, observed ${reads}.`,
    );
  }
}

function scenarioCliFlow(): void {
  console.log(`\n[proof-manifest] Scenario 3: CLI flow, no active workspace (refresh contract).`);
  resetPluginRuntimeStateForTest();
  clearCurrentPluginMetadataSnapshot();

  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "extensions", "normalizer");
  writeInstallIndex({ stateDir, pluginDir });
  writeNormalizerManifest({ pluginDir, prefix: "gamma" });
  configureEnvForStateDir(stateDir);

  // NOTE: no setActivePluginRegistry call. CLI surfaces enter normalize
  // with no published workspace, and per the fix the slot must NOT be
  // re-published from inside `resolveMetadataSnapshotForPolicies`.

  resetIndexReadsFor(stateDir);
  assertUndefined("cli precondition snapshot slot", getCurrentPluginMetadataSnapshot());

  for (let i = 0; i < N; i += 1) {
    assertEqual(`cli call ${i + 1} result`, normalizeOnce(), "gamma/demo-model");
  }

  const reads = snapshotIndexReads(stateDir);
  console.log(
    `[proof-manifest]   ${N} normalize calls -> ${reads} installs.json open(s) (must scale with calls).`,
  );
  // CLI flow does not refill the slot, so each call must re-walk the index.
  // We don't pin an exact ratio (the cold-load open count includes content
  // hashing alongside parsing), but the count must scale with N: it must be
  // strictly greater than the per-call open count of the warm-slot scenario
  // (which is 0). Concretely: at least N opens, since each normalize call
  // hits the disk path at least once.
  if (reads < N) {
    throw new Error(
      `[proof-manifest] CLI-flow refresh contract violated: expected at least ${N} installs.json opens across ${N} normalize calls (slot must stay empty so each call re-reads), observed ${reads}.`,
    );
  }
  // Slot must remain empty so the next CLI call re-reads disk and observes file edits.
  assertUndefined("cli post-call snapshot slot", getCurrentPluginMetadataSnapshot());
}

// -- Main -------------------------------------------------------------------

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log(
    "[proof-manifest] Real-runtime behavior proof for manifest-model-id lazy re-publish.",
  );
  console.log(
    "[proof-manifest] Production code paths: normalizeProviderModelIdWithManifest + loadPluginMetadataSnapshot",
  );
  console.log(
    "[proof-manifest]                            + setCurrentPluginMetadataSnapshot + setActivePluginRegistry.",
  );

  try {
    scenarioGatewayColdSlot();
    scenarioGatewayWarmSlot();
    scenarioCliFlow();
    console.log("\n[proof-manifest] All runtime assertions passed.");
  } finally {
    cleanup();
  }
}

try {
  main();
} catch (err) {
  console.error("[proof-manifest] FAILED:", err);
  cleanup();
  process.exitCode = 1;
}
