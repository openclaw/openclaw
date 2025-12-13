import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the bundled pi/tau binary path from the installed dependency.
export function resolveBundledPiBinary(): string | null {
  const candidatePkgDirs: string[] = [];

  // Preferred: ESM resolution to the package entry, then walk up to package.json.
  try {
    const resolved = (import.meta as { resolve?: (s: string) => string })
      .resolve;
    const entryUrl = resolved?.("@mariozechner/pi-coding-agent");
    if (typeof entryUrl === "string" && entryUrl.startsWith("file:")) {
      const entryPath = fileURLToPath(entryUrl);
      let dir = path.dirname(entryPath);
      for (let i = 0; i < 12; i += 1) {
        const pkgJson = path.join(dir, "package.json");
        if (fs.existsSync(pkgJson)) {
          candidatePkgDirs.push(dir);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    // ignore; we'll try filesystem fallbacks below
  }

  // Fallback: walk up from this module's directory to find node_modules.
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i += 1) {
      candidatePkgDirs.push(
        path.join(dir, "node_modules", "@mariozechner", "pi-coding-agent"),
      );
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }

  // Fallback: assume CWD is project root.
  candidatePkgDirs.push(
    path.resolve(
      process.cwd(),
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
    ),
  );

  for (const pkgDir of candidatePkgDirs) {
    try {
      if (!fs.existsSync(pkgDir)) continue;
      const binCandidates = [
        path.join(pkgDir, "dist", "pi"),
        path.join(pkgDir, "dist", "cli.js"),
        path.join(pkgDir, "bin", "tau-dev.mjs"),
      ];
      for (const candidate of binCandidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore this candidate
    }
  }
  return null;
}
