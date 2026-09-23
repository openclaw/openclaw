import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
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
