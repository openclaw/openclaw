import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function formatGeneratedModule(source, { repoRoot, outputPath, errorLabel }) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutputPath = path.resolve(
    resolvedRepoRoot,
    path.isAbsolute(outputPath) ? path.relative(resolvedRepoRoot, outputPath) : outputPath,
  );
  const directFormatterPath = path.join(resolvedRepoRoot, "node_modules", ".bin", "oxfmt");
  const useDirectFormatter = process.platform !== "win32" && fs.existsSync(directFormatterPath);
  const command = useDirectFormatter ? directFormatterPath : "pnpm";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-generated-format-"));
  const tempOutputPath = path.join(tempDir, path.basename(resolvedOutputPath));

  try {
    fs.writeFileSync(tempOutputPath, source, "utf8");
    const args = useDirectFormatter
      ? ["--write", tempOutputPath]
      : ["exec", "oxfmt", "--write", tempOutputPath];
    const formatter = spawnSync(command, args, {
      cwd: resolvedRepoRoot,
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
      const bindingHint = /Cannot find native binding|@oxfmt\/binding-|MODULE_NOT_FOUND/u.test(
        details,
      )
        ? " oxfmt optional platform bindings are missing or wrong for this machine (common if node_modules was copied from another OS). Run `pnpm install` on this host to install `@oxfmt/binding-*` for your platform."
        : "";
      throw new Error(`failed to format generated ${errorLabel}: ${details}${bindingHint}`);
    }
    return fs.readFileSync(tempOutputPath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
