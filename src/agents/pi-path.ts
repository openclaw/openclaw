import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Resolve the bundled pi/tau binary path from the installed dependency.
export function resolveBundledPiBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(
      "@mariozechner/pi-coding-agent/package.json",
    );
    const pkgDir = path.dirname(pkgPath);
    // Prefer compiled binary if present, else fall back to dist/cli.js (has shebang).
    const binCandidates = [
      path.join(pkgDir, "dist", "pi"),
      path.join(pkgDir, "dist", "cli.js"),
      path.join(pkgDir, "bin", "tau-dev.mjs"),
    ];
    for (const candidate of binCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Dependency missing or resolution failed.
  }
  return null;
}
