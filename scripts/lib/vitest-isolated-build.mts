import { resolveVitestPretestBuildMode } from "./vitest-build-prerequisites.mts";
import { resolveVitestConfigArg } from "./vitest-process-env.mts";
import { resolveVitestRuntimeCliSelections } from "./vitest-runtime-selection.mts";

/** Select builds inside an admitted fresh snapshot without changing host admission. */
export function resolveIsolatedVitestBuild(
  argv: string[],
  env: NodeJS.ProcessEnv,
): { profile: "ciArtifacts" | "qaRuntime"; privateQa: boolean } | undefined {
  const config = resolveVitestConfigArg(argv) ?? "vitest.config.ts";
  if (config === "test/vitest/vitest.ui-e2e.config.ts") {
    return { profile: "ciArtifacts", privateQa: true };
  }
  const mode = resolveVitestPretestBuildMode(resolveVitestRuntimeCliSelections(config, argv, env));
  return mode ? { profile: "qaRuntime", privateQa: mode === "private-qa" } : undefined;
}
