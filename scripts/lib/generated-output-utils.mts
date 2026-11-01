// Shared write/check/report helpers for generated repository files.
import path from "node:path";
import { writeTextFileIfChanged } from "../runtime-postbuild-shared.mjs";
import { readIfExists } from "./bundled-plugin-source-utils.mts";

/** Write generated output unless check mode only needs stale-state metadata. */
export function writeGeneratedOutput(params: {
  check: boolean;
  next: string;
  outputPath: string;
  repoRoot: string;
}) {
  const outputPath = path.resolve(params.repoRoot, params.outputPath);
  const changed = params.check
    ? readIfExists(outputPath) !== params.next
    : writeTextFileIfChanged(outputPath, params.next);

  return {
    changed,
    wrote: !params.check && changed,
    outputPath,
  };
}
