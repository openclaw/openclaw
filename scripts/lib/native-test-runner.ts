import path from "node:path";

type NativeTestRunnerOptions = {
  node?: readonly string[];
  bun?: readonly string[];
};

/** Select the current executable's native test CLI without changing its runtime. */
export function nativeTestRunnerArgs(
  files: readonly string[],
  options: NativeTestRunnerOptions = {},
): string[] {
  if (process.versions.bun) {
    // Bare relative paths are Bun substring filters; ./ selects the exact file.
    return [
      "test",
      ...(options.bun ?? []),
      ...files.map((file) => (path.isAbsolute(file) ? file : `./${file}`)),
    ];
  }
  return [...(options.node ?? []), "--test", ...files];
}
