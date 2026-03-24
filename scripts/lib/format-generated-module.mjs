import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function formatGeneratedModule(source, { repoRoot, outputPath, errorLabel }) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutputPath = path.resolve(
    resolvedRepoRoot,
    path.isAbsolute(outputPath) ? path.relative(resolvedRepoRoot, outputPath) : outputPath,
  );
  const formatterPath = path.relative(resolvedRepoRoot, resolvedOutputPath) || resolvedOutputPath;
  const directFormatterPath = path.join(resolvedRepoRoot, "node_modules", ".bin", "oxfmt");
  const useDirectFormatter = process.platform !== "win32" && fs.existsSync(directFormatterPath);
  const command = useDirectFormatter ? directFormatterPath : "pnpm";
  const args = useDirectFormatter
    ? ["--stdin-filepath", formatterPath]
    : ["exec", "oxfmt", "--stdin-filepath", formatterPath];
  const formatter = spawnSync(command, args, {
    cwd: resolvedRepoRoot,
    input: source,
    encoding: "utf8",
    // Windows requires a shell to launch package-manager shim scripts reliably.
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  if (formatter.status !== 0) {
    const details =
      formatter.stderr?.trim() ||
      formatter.stdout?.trim() ||
      formatter.error?.message ||
      "unknown formatter failure";
    throw new Error(`failed to format generated ${errorLabel}: ${details}`);
  }
  return formatter.stdout;
}
