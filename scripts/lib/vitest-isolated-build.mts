import { resolveVitestPretestBuildMode } from "./vitest-build-prerequisites.mts";
import { resolveVitestConfigArg } from "./vitest-process-env.mts";
import { resolveVitestRuntimeCliSelections } from "./vitest-runtime-selection.mts";

/** Select builds inside an admitted fresh snapshot without changing host admission. */
export function resolveIsolatedVitestBuild(
  argv: string[],
  env: NodeJS.ProcessEnv,
): { profile: "ciArtifacts" | "qaRuntime"; privateQa: boolean; declarations?: true } | undefined {
  const config = resolveVitestConfigArg(argv) ?? "vitest.config.ts";
  if (config === "test/vitest/vitest.ui-e2e.config.ts") {
    return { profile: "ciArtifacts", privateQa: true };
  }
  if (config === "test/vitest/vitest.e2e.config.ts") {
    // Global E2E setup requires private QA and explicit declaration generation.
    // Prepare that same input set in the admitted snapshot, before its ordinary
    // freshness reader applies the managed-Gateway artifact fence.
    return { profile: "qaRuntime", privateQa: true, declarations: true };
  }
  const mode = resolveVitestPretestBuildMode(resolveVitestRuntimeCliSelections(config, argv, env));
  return mode ? { profile: "qaRuntime", privateQa: mode === "private-qa" } : undefined;
}
