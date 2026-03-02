import path from "node:path";
import { resolveRepoRoot, resolveSourceRoots } from "./ts-guard-utils.mjs";

export function createPairingGuardContext(importMetaUrl) {
  const repoRoot = resolveRepoRoot(importMetaUrl);
  const sourceRoots = resolveSourceRoots(repoRoot, ["src", "extensions"]);
  return {
    repoRoot,
    sourceRoots,
    resolveFromRepo: (relativePath) =>
      path.join(repoRoot, ...relativePath.split("/").filter(Boolean)),
  };
}
