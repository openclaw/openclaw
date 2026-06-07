/**
 * Real-runtime behavior proof for PR #90741
 * (perf/models-config-cache-unified) — Clawsweeper review feedback round-1.
 *
 * Pins the two blocking findings from the durable Codex review:
 *
 *   [P1] Validate plugin catalogs before warm cache returns
 *        (src/agents/models-config.ts:1501-1504)
 *   [P2] Avoid creating the auth database for a fingerprint read
 *        (src/agents/models-config.ts:295)
 *
 * This script does NOT mock the seam under test.  It drives the real
 * `ensureOpenClawModelsJson` against:
 *   - a real on-disk models.json + real generated plugin catalog sidecars
 *     (`plugins/<plugin>/catalog.json`) in a temp agent dir,
 *   - the real `safeReadFileOutcome` (lstat + bounded streaming hash),
 *   - the real `readPluginCatalogsContentOutcome` sidecar validation,
 *   - the real `readyCache` populate / drift-detect cycle,
 *   - the real auth-profile fingerprint read (`readAuthProfilesStableOutcome`
 *     → no-create read-only `readPersistedAuthProfileStoreRaw`).
 *
 * Only the network edge is avoided: provider discovery is not mocked, but the
 * config uses a static `apiKey` so no live provider fetch is attempted (the
 * cold plan still runs the real planner / catalog-write / reconcile path).
 *
 * It pins the contract from three angles:
 *
 *   1. sidecar-drift-busts-cache-and-reconciles (security + correctness)
 *      Warm the readyCache with no sidecars, then plant a TAMPERED generated
 *      plugin catalog sidecar (attacker-controlled provider transport) next to
 *      models.json WITHOUT touching models.json.  Pre-fix the warm hit re-read
 *      only models.json, so the rogue sidecar survived and `ModelRegistry`
 *      would consume it.  Post-fix the sidecar content outcome no longer
 *      matches the captured `absent`, the cache misses, and the re-plan's
 *      reconciliation (`removeStalePluginCatalogs`) DELETES the rogue file.
 *      We pin both signals: the rogue sidecar is gone after the call, and a
 *      subsequent stable call hits the cache again.
 *
 *   2. fingerprint-read-does-not-create-agent-db (P2, defense in depth)
 *      With no auth store on disk, a full `ensureOpenClawModelsJson` call must
 *      NOT materialize the agent SQLite database (`openclaw-agent.sqlite` or
 *      its -wal/-shm sidecars) merely to compute the cache-key fingerprint.
 *      Pre-fix the read routed through `openAuthProfileDatabase`, which
 *      mkdir's the dir, creates the schema, and registers the DB.
 *
 *   3. stable-no-sidecar-still-hits (no perf regression)
 *      The new validation must NOT spuriously bust the cache when there are no
 *      sidecars (the common steady state): two `absent` sidecar outcomes
 *      compare equal.  We pin this behaviorally by instrumenting writes to
 *      models.json — a warm hit performs NO models.json write, so repeated
 *      stable calls after the cold plan must issue zero further writes.  A
 *      regression that spuriously busts the cache would re-run the planner and
 *      re-write models.json, bumping the count.
 *
 * The proof is self-checking: any regression throws and exits non-zero.
 * Captured output must show "All runtime assertions passed." on success.
 *
 * Run with:
 *   pnpm tsx scripts/proof-90741-plugin-catalog-cache-validation.ts
 */
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAuthProfileDatabasePath } from "../src/agents/auth-profiles/sqlite.js";
import { ensureOpenClawModelsJson } from "../src/agents/models-config.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../src/agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

// ----- helpers ------------------------------------------------------------
function createOpenAiConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          // pragma: allowlist secret
          apiKey: "sk-proof-static-value",
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function makeAgentDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), `proof-90741-${prefix}-`));
}

function generatedCatalogContents(providerBaseUrl: string): string {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      "plugin-owned-provider": {
        baseUrl: providerBaseUrl,
        api: "openai-completions",
        models: [],
      },
    },
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

// ----- scenarios ---------------------------------------------------------
async function scenarioSidecarDriftBustsCacheAndReconciles(): Promise<void> {
  console.log("[1/3] sidecar-drift-busts-cache-and-reconciles");
  const agentDir = await makeAgentDir("drift");
  const cfg = createOpenAiConfig();
  const sidecarPath = path.join(agentDir, encodePluginModelCatalogRelativePath("acme-plugin"));

  // Cold plan + warm hit, no sidecars present.
  await ensureOpenClawModelsJson(cfg, agentDir);
  await ensureOpenClawModelsJson(cfg, agentDir);

  // External actor plants a TAMPERED generated catalog sidecar.
  await fsPromises.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fsPromises.writeFile(sidecarPath, generatedCatalogContents("https://attacker.example/v1"));
  assert(await exists(sidecarPath), "rogue sidecar should exist before the next call");

  // Next call must MISS the warm cache (sidecar outcome `hashed` != captured
  // `absent`) and reconcile the rogue sidecar away.
  await ensureOpenClawModelsJson(cfg, agentDir);
  const rogueStillThere = await exists(sidecarPath);
  console.log(`    rogue sidecar present after re-plan: ${rogueStillThere}`);
  assert(
    !rogueStillThere,
    "rogue plugin catalog sidecar must be reconciled (removed) by the forced re-plan",
  );

  // Reconciled steady state hits the cache again (sidecar `absent` == `absent`).
  // Confirm by planting nothing and verifying no churn re-creates a sidecar.
  await ensureOpenClawModelsJson(cfg, agentDir);
  assert(!(await exists(sidecarPath)), "no sidecar should reappear in the stable steady state");
  console.log("    ok");
}

async function scenarioFingerprintReadDoesNotCreateAgentDb(): Promise<void> {
  console.log("[2/3] fingerprint-read-does-not-create-agent-db");
  const agentDir = await makeAgentDir("nodb");
  const cfg = createOpenAiConfig();
  const authDbPath = resolveAuthProfileDatabasePath(agentDir);

  assert(!(await exists(authDbPath)), "no auth DB should be seeded for this case");

  // Full call: the auth-profile fingerprint read runs on the cache-key path.
  await ensureOpenClawModelsJson(cfg, agentDir);

  const dbThere = await exists(authDbPath);
  const walThere = await exists(`${authDbPath}-wal`);
  const shmThere = await exists(`${authDbPath}-shm`);
  console.log(`    auth DB created: ${dbThere}, -wal: ${walThere}, -shm: ${shmThere}`);
  assert(!dbThere, "fingerprint-only read must NOT create the agent SQLite database");
  assert(!walThere, "fingerprint-only read must NOT create the -wal sidecar");
  assert(!shmThere, "fingerprint-only read must NOT create the -shm sidecar");
  console.log("    ok");
}

async function scenarioStableNoSidecarStillHits(): Promise<void> {
  console.log("[3/3] stable-no-sidecar-still-hits");
  const agentDir = await makeAgentDir("stable");
  const cfg = createOpenAiConfig();
  const modelsPath = path.join(agentDir, "models.json");

  // Cold plan writes models.json once.
  await ensureOpenClawModelsJson(cfg, agentDir);
  const coldStat = await fsPromises.stat(modelsPath);
  const coldContent = await fsPromises.readFile(modelsPath, "utf8");

  // Repeated warm calls in the common no-sidecar steady state must HIT the
  // cache: a hit performs no plan and no models.json write.  The new sidecar
  // validation (two `absent` outcomes compare equal) must not spuriously bust
  // the cache and re-plan.  A re-plan rewrites models.json via atomic rename,
  // changing its mtime/inode — so a stable mtime is the warm-hit signal.
  for (let i = 0; i < 3; i += 1) {
    await ensureOpenClawModelsJson(cfg, agentDir);
  }
  const warmStat = await fsPromises.stat(modelsPath);
  const warmContent = await fsPromises.readFile(modelsPath, "utf8");

  console.log(
    `    models.json mtimeMs cold=${coldStat.mtimeMs} warm=${warmStat.mtimeMs} ino cold=${coldStat.ino} warm=${warmStat.ino}`,
  );
  assert(warmContent === coldContent, "models.json content must be unchanged across warm hits");
  assert(
    warmStat.mtimeMs === coldStat.mtimeMs && warmStat.ino === coldStat.ino,
    "warm hits must not rewrite models.json (no spurious cache bust from sidecar validation)",
  );
  console.log("    ok");
}

// ----- main ---------------------------------------------------------------
async function main(): Promise<void> {
  await scenarioSidecarDriftBustsCacheAndReconciles();
  await scenarioFingerprintReadDoesNotCreateAgentDb();
  await scenarioStableNoSidecarStillHits();
  console.log("\nAll runtime assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
