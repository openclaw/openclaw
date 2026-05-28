/**
 * Real-runtime behavior proof for #85254
 * (perf/manifest-model-id-thread-runtime-plugins).
 *
 * Establishes — without any mocks of the seam under test — that prepared
 * `manifestPlugins` passed into the runtime model-id normalize chain are
 * actually consulted, that the metadata-snapshot disk walk inside
 * `manifest-model-id-normalization.ts` is bypassed in that case, and
 * that the normalized model id is identical to the snapshot path's
 * result (no behavior drift introduced by the threading).
 *
 * Real code paths driven (no monkey-patches of the seam):
 *   - `normalizeModelRef` (`src/agents/model-selection-normalize.ts`),
 *     including the new spread-conditional `...(options?.manifestPlugins
 *     ? { plugins: options.manifestPlugins } : {})`.
 *   - `normalizeStaticProviderModelId` (`src/agents/model-ref-shared.ts`)
 *     which also threads `manifestPlugins` straight into
 *     `normalizeProviderModelIdWithManifest`.
 *   - `normalizeProviderModelIdWithRuntime` →
 *     `normalizeProviderModelIdWithPlugin` →
 *     `normalizeProviderModelIdWithManifest` (provider-runtime.ts /
 *     manifest-model-id-normalization.ts) — the chain whose final
 *     conditional, `if (params.plugins) return
 *     collectManifestModelIdNormalizationPolicies(params.plugins)`,
 *     is the PR's core.
 *
 * Instrumentation strategy.  The non-exported function we want to
 * observe — `resolveMetadataSnapshotForPolicies` — has exactly two
 * disk-side effects: it calls `getCurrentPluginMetadataSnapshot` and
 * (on miss) `resolvePluginMetadataSnapshot`, both of which probe the
 * installed-plugin-index ledger at `<stateDir>/plugins/installs.json`
 * via `resolveInstalledPluginIndexStorePath` → `fs.statSync` /
 * `fs.readFileSync`.  We point the state dir at a fresh empty temp
 * dir (so any access is observable, not cached), then wrap the
 * synchronous `fs` entry points to count touches against any path
 * inside `<stateDir>/plugins/`.
 *
 * NOTE: the same `normalizeModelRef` chain also calls
 * `resolveProviderHookPlugin` (in `provider-runtime.ts`) BEFORE the
 * manifest-policy lookup runs.  That lookup performs its own disk
 * touches and is unaffected by the PR.  Because it runs identically
 * on both the with- and without- `manifestPlugins` scenarios for the
 * same provider/env, its contribution cancels out in the DELTA
 * comparison — the delta isolates the manifest-policy lookup's disk
 * work exactly.  We assert both the absolute floor on the
 * without-plugins side (≥1, snapshot path IS taken) and the delta
 * (with-plugins strictly fewer) plus the byte-identical normalized
 * model-id on both paths.
 *
 * Three scenarios, all self-checking:
 *
 *   1. with-prepared-plugins-consults-them-and-skips-snapshot
 *      `normalizeModelRef("openai", "gpt-5", { manifestPlugins })`
 *      must apply the sentinel plugin alias (proves `params.plugins`
 *      flowed into `collectManifestModelIdNormalizationPolicies`) and
 *      its sentinel disk-touch count must be strictly less than the
 *      without-plugins control.
 *
 *   2. without-prepared-plugins-walks-snapshot
 *      `normalizeModelRef("openai", "gpt-5")` must touch the sentinel
 *      disk paths at least once — the snapshot path is taken.
 *
 *   3. result-identical-on-both-paths
 *      With an EMPTY manifestPlugins list (no policies for the target
 *      provider), the normalized model-id is byte-identical to the
 *      snapshot-path result.  Pins "no behavior drift introduced by
 *      the threading itself" beyond the policy lookup it short-
 *      circuits.
 *
 * Run with:
 *   pnpm tsx scripts/proof-85254-manifest-plugins-runtime-thread.ts
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  // ----- 1. Isolate state into an empty temp dir ------------------------
  // resolveInstalledPluginIndexStorePath bases its path on
  // resolveStateDir, which honors OPENCLAW_STATE_DIR.
  // OPENCLAW_TEST_FAST=1 makes the state-dir resolver skip the
  // legacy-dir scan and stick to the override.
  const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "proof-85254-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_TEST_FAST = "1";

  // Sentinel: anything inside `<stateDir>/plugins/` is a tell that the
  // snapshot-resolution machinery (the only consumer of
  // resolveInstalledPluginIndexStorePath in this chain) touched disk.
  const sentinelDir = path.join(stateDir, "plugins");

  // ----- 2. Wrap synchronous fs functions to count sentinel touches ---
  let sentinelTouches = 0;
  const touchedPaths = new Set<string>();
  const recordTouch = (p: unknown): void => {
    if (typeof p !== "string") {
      return;
    }
    if (p.startsWith(sentinelDir)) {
      sentinelTouches += 1;
      touchedPaths.add(p);
    }
  };

  const realStatSync = fs.statSync.bind(fs);
  const realReadFileSync = fs.readFileSync.bind(fs);
  const realExistsSync = fs.existsSync.bind(fs);
  (fs as { statSync: typeof fs.statSync }).statSync = ((
    ...args: Parameters<typeof fs.statSync>
  ) => {
    recordTouch(args[0]);
    return realStatSync(...args);
  }) as typeof fs.statSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    recordTouch(args[0]);
    return realReadFileSync(...args);
  }) as typeof fs.readFileSync;
  (fs as { existsSync: typeof fs.existsSync }).existsSync = ((
    ...args: Parameters<typeof fs.existsSync>
  ) => {
    recordTouch(args[0]);
    return realExistsSync(...args);
  }) as typeof fs.existsSync;

  function snapshotCounts(): { count: number; paths: string[] } {
    return { count: sentinelTouches, paths: [...touchedPaths] };
  }
  function resetCounts(): void {
    sentinelTouches = 0;
    touchedPaths.clear();
  }

  // ----- 3. Import the REAL seam (after fs wrappers are installed) ----
  // Dynamic import so any require() inside the chain (e.g. the
  // createRequire candidates inside provider-model-normalization.runtime)
  // resolves through the wrapped fs.
  const { normalizeModelRef } = await import("../src/agents/model-selection-normalize.js");

  type PluginRecord = {
    modelIdNormalization?: {
      providers?: Record<
        string,
        {
          aliases?: Record<string, string>;
          stripPrefixes?: string[];
          prefixWhenBare?: string;
        }
      >;
    };
  };

  // Sentinel plugin record: aliases `gpt-5` → `gpt-5o` for `openai`.  A
  // non-trivial alias makes scenario 1 verify the policy was consulted
  // (proves params.plugins flowed all the way through, not just that
  // it was syntactically threaded).
  const manifestPlugins: PluginRecord[] = [
    {
      modelIdNormalization: {
        providers: {
          openai: {
            aliases: { "gpt-5": "gpt-5o" },
          },
        },
      },
    },
  ];

  function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) {
      throw new Error(`ASSERTION FAILED: ${msg}`);
    }
  }

  // ----- 4. Warm any one-shot module init by calling once -------------
  // The first normalizeModelRef in a fresh process can do extra
  // module-init disk work (createRequire path probes, etc.) that has
  // nothing to do with the manifest-policy lookup.  Run a warmup with
  // a different provider, then reset, so subsequent counts isolate
  // per-call work only.
  normalizeModelRef("anthropic", "claude-sonnet-4.6");
  resetCounts();

  // ----- 5. Scenario 2 (control first): no prepared plugins -----------
  // Run the without-plugins control FIRST so its count establishes a
  // baseline >= 1.  Doing it first also means the with-plugins
  // scenario sees a warm policy cache — if the threading were broken
  // and the chain fell through to the snapshot path, the cache could
  // mask the regression.  Running without-plugins first deliberately
  // exposes the threading.
  console.log("[1/3] without-prepared-plugins-walks-snapshot (control)");
  resetCounts();
  const refWithout = normalizeModelRef("openai", "gpt-5");
  const withoutTouches = snapshotCounts();
  console.log(
    `    normalizeModelRef result: provider=${refWithout.provider} model=${refWithout.model}`,
  );
  console.log(`    sentinel disk touches under ${sentinelDir}: ${withoutTouches.count}`);
  if (withoutTouches.paths.length > 0) {
    console.log(`    touched paths: ${withoutTouches.paths.join(", ")}`);
  }
  assert(
    withoutTouches.count >= 1,
    `without prepared plugins the snapshot path must probe disk at least once (got ${withoutTouches.count})`,
  );
  console.log("    ok");

  // ----- 6. Scenario 1: with prepared plugins, snapshot path skipped --
  console.log("[2/3] with-prepared-plugins-consults-them-and-skips-snapshot");
  resetCounts();
  const refWith = normalizeModelRef("openai", "gpt-5", { manifestPlugins });
  const withTouches = snapshotCounts();
  console.log(`    normalizeModelRef result: provider=${refWith.provider} model=${refWith.model}`);
  console.log(`    sentinel disk touches under ${sentinelDir}: ${withTouches.count}`);
  if (withTouches.paths.length > 0) {
    console.log(`    touched paths: ${withTouches.paths.join(", ")}`);
  }
  // (a) Plugin alias was actually consulted — proves params.plugins
  // was threaded into collectManifestModelIdNormalizationPolicies.
  assert(
    refWith.model === "gpt-5o",
    `prepared plugins' alias must apply (proves the threading is live); got model=${refWith.model}`,
  );
  // (b) Strictly fewer disk touches than the control — proves
  // `resolveMetadataSnapshotForPolicies` was bypassed.  The delta is
  // the per-call disk work attributable to the manifest-policy
  // lookup alone (the provider-hook lookup runs identically in both
  // scenarios and cancels out).
  assert(
    withTouches.count < withoutTouches.count,
    `with prepared plugins the snapshot path must be bypassed; expected fewer touches than control ${withoutTouches.count}, got ${withTouches.count}`,
  );
  console.log(
    `    delta vs control: ${withoutTouches.count - withTouches.count} (snapshot path bypassed)`,
  );
  console.log("    ok");

  // ----- 7. Scenario 3: result identical on both paths ---------------
  // With an EMPTY manifestPlugins list (no relevant policy), the
  // with-plugins path's policy lookup yields no transformation, just
  // like the snapshot path's policy lookup would on this clean
  // workspace.  The normalized model-id must agree byte-for-byte —
  // pinning "no behavior drift introduced by the threading itself."
  console.log("[3/3] result-identical-on-both-paths");
  const emptyPlugins: PluginRecord[] = [{ modelIdNormalization: { providers: {} } }];
  const refEmptyWith = normalizeModelRef("anthropic", "claude-sonnet-4.6", {
    manifestPlugins: emptyPlugins,
  });
  const refEmptyWithout = normalizeModelRef("anthropic", "claude-sonnet-4.6");
  console.log(
    `    with empty plugins:  provider=${refEmptyWith.provider} model=${refEmptyWith.model}`,
  );
  console.log(
    `    without plugins:     provider=${refEmptyWithout.provider} model=${refEmptyWithout.model}`,
  );
  assert(
    refEmptyWith.provider === refEmptyWithout.provider &&
      refEmptyWith.model === refEmptyWithout.model,
    `normalized model-id must be identical on both paths (with-empty=${refEmptyWith.provider}/${refEmptyWith.model}, without=${refEmptyWithout.provider}/${refEmptyWithout.model})`,
  );
  console.log("    ok");

  console.log("\nAll runtime assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
