import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NEEDLE = 'this.express.use("/api*", express_1.default.json());';
const REPLACEMENT = 'this.express.use("/api", express_1.default.json());';

function listJsFilesRecursively(rootDir) {
  const out = [];
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      if (!dirent.name.endsWith(".js")) {
        continue;
      }
      out.push(fullPath);
    }
  }

  return out;
}

export function patchMSTeamsHttpPluginApiRoute(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const distDir = params.distDir ?? path.join(repoRoot, "dist");
  if (!fs.existsSync(distDir)) {
    return { changedFiles: [], distDir, skipped: "missing-dist" };
  }

  const warnOnNoMatches = params.warnOnNoMatches ?? true;

  const jsFiles = listJsFilesRecursively(distDir);
  const changedFiles = [];
  let matchedFiles = 0;
  let sawReplacement = false;

  for (const filePath of jsFiles) {
    const src = fs.readFileSync(filePath, "utf8");
    if (src.includes(REPLACEMENT)) {
      sawReplacement = true;
    }
    if (!src.includes(NEEDLE)) {
      continue;
    }

    matchedFiles++;

    const next = src.split(NEEDLE).join(REPLACEMENT);
    if (next !== src) {
      fs.writeFileSync(filePath, next);
      changedFiles.push(filePath);
    }
  }

  if (warnOnNoMatches && jsFiles.length && matchedFiles === 0 && !sawReplacement) {
    process.stderr.write(
      "patch-msteams-httpplugin-route: warning: dist/ exists but no matches were found for the expected HttpPlugin route needle. " +
        "This likely means the patch is stale or the bundle layout changed.\n",
    );
  }

  return {
    changedFiles,
    distDir,
    scannedFiles: jsFiles.length,
    matchedFiles,
    skipped: null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = patchMSTeamsHttpPluginApiRoute();
  if (result.skipped) {
    process.stdout.write(`patch-msteams-httpplugin-route: skipped (${result.skipped})\n`);
    process.exit(0);
  }
  process.stdout.write(
    `patch-msteams-httpplugin-route: patched ${result.changedFiles.length} file(s)\n` +
      result.changedFiles.map((f) => `- ${path.relative(process.cwd(), f)}`).join("\n") +
      (result.changedFiles.length ? "\n" : ""),
  );
}
