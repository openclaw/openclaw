import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
let coreRootCache = null;
let coreDepsPromise = null;
function findPackageRoot(startDir, name) {
  let dir = startDir;
  for (; ; ) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        if (pkg.name === name) {
          return dir;
        }
      }
    } catch {
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
function resolveOpenClawRoot() {
  if (coreRootCache) {
    return coreRootCache;
  }
  const override = process.env.OPENCLAW_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }
  const candidates = /* @__PURE__ */ new Set();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    const urlPath = fileURLToPath(import.meta.url);
    candidates.add(path.dirname(urlPath));
  } catch {
  }
  for (const start of candidates) {
    for (const name of ["openclaw"]) {
      const found = findPackageRoot(start, name);
      if (found) {
        coreRootCache = found;
        return found;
      }
    }
  }
  throw new Error("Unable to resolve core root. Set OPENCLAW_ROOT to the package root.");
}
async function importCoreExtensionAPI() {
  const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`
    );
  }
  return await import(pathToFileURL(distPath).href);
}
async function loadCoreAgentDeps() {
  if (coreDepsPromise) {
    return coreDepsPromise;
  }
  coreDepsPromise = (async () => {
    return await importCoreExtensionAPI();
  })();
  return coreDepsPromise;
}
export {
  loadCoreAgentDeps
};
