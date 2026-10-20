import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inventory } from "../database-worker-inventory.mjs";
import {
  acquireBuildArtifactLock,
  finalizeBuildStepCache,
  hashInputFiles,
  resolveBuildStepCacheState,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./build-artifact-cache.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";
import { resolveInstalledNativeTypeScriptCompiler } from "./native-typescript.mts";

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

/** Only historical counts are reusable; the head must still validate credential writers. */
export function baseInventory(root: string, ref: string): ReturnType<typeof inventory> {
  const git = (revision: string) =>
    execFileSync("git", ["rev-parse", "--verify", revision], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const commit = git(`${ref}^{commit}`);
  if (analyzerSignature() !== loadedAnalyzerSignature) {
    return inventory(root, commit);
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
    if (state.fresh && (!state.restorable || restoreBuildStepCacheOutputs(state, params))) {
      const rows: ReturnType<typeof inventory> = JSON.parse(
        fs.readFileSync(path.join(root, output), "utf8"),
      );
      return rows;
    }
    const rows = inventory(root, commit);
    fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
    fs.writeFileSync(path.join(root, output), JSON.stringify(rows));
    if (analyzerSignature() === loadedAnalyzerSignature) {
      finalizeBuildStepCache(step, { ...state, consumedInputs: [] }, params);
    }
    return rows;
  } finally {
    lock.release();
  }
}
