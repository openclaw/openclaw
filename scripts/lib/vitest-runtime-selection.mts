import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import {
  resolveVitestRuntimeConfigScopes,
  type VitestRuntimeTestSelection,
} from "./vitest-build-prerequisites.mts";

/** Bind installed CLI matching without adding runtime dependencies to CI planning. */
export function resolveVitestRuntimeCliSelections(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): VitestRuntimeTestSelection[] {
  return resolveVitestRuntimeConfigScopes(config).map(({ file: scopedFile, configs, dir }) => ({
    configs,
    matchesFile: (file, included, includePatterns) =>
      file === scopedFile &&
      matchesVitestCliSelection(file, included ? [file] : [], args, dir, env, includePatterns),
  }));
}

/** Keep known worker compilation outside dynamically imported test cases. */
export function shouldPrepareVitestCoreWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  includePatterns?: readonly string[] | null,
): boolean {
  const infra = "test/vitest/vitest.infra.config.ts";
  const contracts = "test/vitest/vitest.contracts-plugin.config.ts";
  const includesProject = (project: string) =>
    config === project ||
    config === "vitest.config.ts" ||
    config === "test/vitest/vitest.config.ts" ||
    fullSuiteVitestShards.some(
      (shard) => shard.config === config && shard.projects.includes(project),
    );
  const workers = [
    ...(includesProject(infra) ? databaseWorkerCoreTestFiles : []),
    ...(includesProject(contracts)
      ? ["src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts"]
      : []),
  ];
  return workers.some((file) =>
    matchesVitestCliSelection(file, [file], args, "", env, includePatterns),
  );
}
