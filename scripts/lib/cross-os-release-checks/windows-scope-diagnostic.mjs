// Diagnostic-only preload: observes exact packaged scope operands without changing disk bytes.
import { appendFileSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const output = process.env.OPENCLAW_WINDOWS_SCOPE_DIAGNOSTIC_FILE;
const key = Symbol.for("openclaw.windows-scope-diagnostic");
function emit(value) {
  appendFileSync(output, JSON.stringify({ pid: process.pid, node: process.version, ...value }) + "\n");
}
function identity(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return { path, realpath: realpathSync(path), native: realpathSync.native(path), dev: String(stat.dev), ino: String(stat.ino), symlink: lstatSync(path).isSymbolicLink() };
  } catch (error) {
    return { path, error: error.code };
  }
}
function entry(path) {
  return { leaf: identity(path), parent: identity(dirname(path)) };
}
if (process.platform === "win32" && output) {
  emit({ kind: "preload" });
  globalThis[key] = (manifest, scopes, url) => {
    const selected = [...scopes].map(([stateDir, configs]) => ({ stateDir, configs: [...configs] }));
    emit({ kind: "scope", module: url, manifest: { stateDir: manifest.stateDir, configPath: manifest.configPath }, selected,
      stateMatch: scopes.has(manifest.stateDir), configMatch: scopes.get(manifest.stateDir)?.has(manifest.configPath) ?? false,
      manifestIdentity: { state: identity(manifest.stateDir), config: entry(manifest.configPath) },
      selectedIdentity: selected.map(({ stateDir, configs }) => ({ state: identity(stateDir), configs: configs.map(entry) })),
      selectors: Object.fromEntries(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_PROFILE", "TEMP", "TMP"].map(name => [name, process.env[name] ?? null])) });
  };
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    // Exact retained baseline/candidate implementations; same-prefix re-export barrels have no assertion.
    if (!/\/update-recovery-backup-reader-(?:BZpL0l9m|CK_1jHek)\.mjs$/.test(url)) return result;
    const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
    const marker = "function assertManifestSelectedScope(manifest, scopes) {";
    if (source.split(marker).length !== 2 || !source.includes("Update recovery backup belongs to another selected state or configuration.")) throw new Error("Diagnostic scope instrumentation does not match the exact package");
    const root = dirname(dirname(fileURLToPath(url)));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const fsSafeEntry = createRequire(url).resolve("@openclaw/fs-safe");
    const fsSafe = JSON.parse(readFileSync(join(dirname(dirname(fsSafeEntry)), "package.json"), "utf8"));
    emit({ kind: "instrumented", module: url, version: pkg.version, declaredFsSafe: pkg.dependencies?.["@openclaw/fs-safe"], fsSafeEntry, installedFsSafe: fsSafe.version });
    return { ...result, source: source.replace(marker, marker + '\n globalThis[Symbol.for("openclaw.windows-scope-diagnostic")](manifest, scopes, import.meta.url);') };
  } });
}
