import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inventory, loadInventorySources } from "../database-worker-inventory.mjs";
import {
  acquireBuildArtifactLock,
  finalizeBuildStepCache,
  hashInputFiles,
  resolveBuildStepCacheState,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./build-artifact-cache.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";
import {
  reportNativeTypeScriptPhase,
  resolveInstalledNativeTypeScriptCompiler,
  type NativeTypeScriptObserver,
} from "./native-typescript.mts";

const toolingRoot = path.resolve(import.meta.dirname, "../..");
const analyzerFiles = [
  "scripts/check-database-worker-ratchet.mts",
  "scripts/database-worker-inventory.mjs",
  "scripts/lib/database-worker-inventory-cache.mts",
  "scripts/lib/database-worker-compat.mts",
  "scripts/lib/personal-credential-writer-guard.mts",
  "scripts/lib/native-typescript.mts",
  "scripts/lib/native-typescript-toolchain.mts",
  "scripts/lib/shrink-ratchet.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/build-artifact-cache.mts",
].map((file) => path.join(toolingRoot, file));

function analyzerSignature() {
  const compiler = nativeTypeScriptToolchainFiles(
    resolveInstalledNativeTypeScriptCompiler().packageJson,
    (file) => file,
  );
  return hashInputFiles(toolingRoot, [...analyzerFiles, ...compiler], fs);
}

// Bind to the loaded implementation before the potentially long head analysis.
const loadedAnalyzerSignature = analyzerSignature();

/** The fresh head validates credential writers even when both source snapshots match. */
export function baseInventory(
  root: string,
  ref: string,
  current?: { sources: ReadonlyMap<string, string>; rows: ReturnType<typeof inventory> },
  observer?: NativeTypeScriptObserver,
): ReturnType<typeof inventory> {
  const trace: NativeTypeScriptObserver | undefined =
    observer && ((phase, facts) => reportNativeTypeScriptPhase(observer, `base.${phase}`, facts));
  const git = (revision: string) =>
    execFileSync("git", ["rev-parse", "--verify", revision], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const commit = git(`${ref}^{commit}`);
  if (analyzerSignature() !== loadedAnalyzerSignature) {
    reportNativeTypeScriptPhase(trace, "reuse", { outcome: "changed-analyzer" });
    return inventory(root, commit, false, undefined, trace);
  }
  // The semantic project denies disk fallback and embeds its config in the analyzer.
  // A whole-tree key conservatively includes every source path, byte and membership change.
  const tree = git(`${commit}^{tree}`);
  const signature = createHash("sha256")
    .update(
      JSON.stringify([
        tree,
        loadedAnalyzerSignature,
        path.resolve(root),
        process.platform,
        process.arch,
      ]),
    )
    .digest("hex");
  const output = ".artifacts/database-worker-ratchet/base.json";
  const step: BuildCacheStep = {
    label: "database-worker-ratchet-base",
    cache: { inputs: analyzerFiles, outputs: [output], requiredOutputs: [output] },
  };
  const params = { rootDir: root, inputSignature: () => signature };
  // Serialize this checkout's output file across lookup, generation and publication.
  const lock = acquireBuildArtifactLock(path.join(root, output));
  try {
    const state = resolveBuildStepCacheState(step, params);
    reportNativeTypeScriptPhase(trace, "lookup");
    if (state.fresh && (!state.restorable || restoreBuildStepCacheOutputs(state, params))) {
      const rows: ReturnType<typeof inventory> = JSON.parse(
        fs.readFileSync(path.join(root, output), "utf8"),
      );
      reportNativeTypeScriptPhase(trace, "reuse", { outcome: "cached" });
      return rows;
    }
    const sources = loadInventorySources(root, commit);
    reportNativeTypeScriptPhase(trace, "sources", { files: sources.size });
    // The semantic project has no disk fallback: path membership and all source
    // text are its complete inputs. SQL-only or diff-only equality is insufficient.
    const identical =
      current &&
      sources.size === current.sources.size &&
      [...sources].every(([file, text]) => current.sources.get(file) === text);
    reportNativeTypeScriptPhase(trace, "equality");
    const rows = identical ? current.rows : inventory(root, commit, false, sources, trace);
    reportNativeTypeScriptPhase(trace, "reuse", { outcome: identical ? "identical" : "analyzed" });
    if (identical) {
      console.log("SQLite worker snapshots identical: reusing fresh current-tree analysis.");
    }
    fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
    fs.writeFileSync(path.join(root, output), JSON.stringify(rows));
    if (analyzerSignature() === loadedAnalyzerSignature) {
      finalizeBuildStepCache(step, { ...state, consumedInputs: [] }, params);
    }
    reportNativeTypeScriptPhase(trace, "publish");
    return rows;
  } finally {
    lock.release();
    reportNativeTypeScriptPhase(trace, "release");
  }
}
