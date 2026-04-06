import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DAEMON_CLI_EXPORTS,
  resolveAliasedExportAccessor,
  resolveLegacyDaemonCliRegisterAccessor,
} from "../src/cli/daemon-cli-compat.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");
const allBundleEntries = () =>
  fs.readdirSync(distDir).filter((entry) => entry.endsWith(".js") || entry.endsWith(".mjs"));

const findCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    const isDaemonCliBundle =
      entry === "daemon-cli.js" || entry === "daemon-cli.mjs" || entry.startsWith("daemon-cli-");
    if (!isDaemonCliBundle) {
      return false;
    }
    // tsdown can emit either .js or .mjs depending on bundler settings/runtime.
    return entry.endsWith(".js") || entry.endsWith(".mjs");
  });

// In rare cases, build output can land slightly after this script starts (depending on FS timing).
// Retry briefly to avoid flaky builds.
let candidates = findCandidates();
for (let i = 0; i < 10 && candidates.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  candidates = findCandidates();
}

if (candidates.length === 0) {
  throw new Error("No daemon-cli bundle found in dist; cannot write legacy CLI shim.");
}

const orderedCandidates = candidates.toSorted();
const registerBundle = orderedCandidates
  .map((entry) => {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const registerAccessor = resolveLegacyDaemonCliRegisterAccessor(source);
    return { entry, registerAccessor };
  })
  .find((entry) => Boolean(entry.registerAccessor));

if (!registerBundle?.registerAccessor) {
  throw new Error(
    `Could not resolve daemon-cli export aliases from dist bundles: ${orderedCandidates.join(", ")}`,
  );
}

type ResolvedCompatExport = {
  accessor: string;
  entry: string;
};

const cache = new Map<string, string>();
const readBundle = (entry: string) => {
  const cached = cache.get(entry);
  if (cached) {
    return cached;
  }
  const source = fs.readFileSync(path.join(distDir, entry), "utf8");
  cache.set(entry, source);
  return source;
};

const findExportEntry = (
  exportName: (typeof LEGACY_DAEMON_CLI_EXPORTS)[number],
): ResolvedCompatExport | null => {
  const preferredEntries =
    exportName === "runDaemonStatus"
      ? allBundleEntries()
          .filter((entry) => entry.startsWith("status-"))
          .toSorted()
      : allBundleEntries()
          .filter((entry) => entry.startsWith("runners-"))
          .toSorted();
  for (const entry of preferredEntries) {
    const accessor = resolveAliasedExportAccessor(readBundle(entry), exportName);
    if (accessor) {
      return { accessor, entry };
    }
  }
  return null;
};

const resolvedEntries = new Map<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], ResolvedCompatExport>();
resolvedEntries.set("registerDaemonCli", {
  accessor: registerBundle.registerAccessor,
  entry: registerBundle.entry,
});

for (const exportName of LEGACY_DAEMON_CLI_EXPORTS) {
  if (exportName === "registerDaemonCli") {
    continue;
  }
  const resolved = findExportEntry(exportName);
  if (resolved) {
    resolvedEntries.set(exportName, resolved);
  }
}

const uniqueEntries = new Set<string>();
for (const value of resolvedEntries.values()) {
  uniqueEntries.add(value.entry);
}

const entryImportNames = new Map<string, string>();
for (const entry of uniqueEntries) {
  entryImportNames.set(entry, `daemonCliCompat${entryImportNames.size}`);
}

const missingExportError = (name: string) =>
  `Legacy daemon CLI export "${name}" is unavailable in this build. Please upgrade OpenClaw.`;
const buildExportLine = (name: (typeof LEGACY_DAEMON_CLI_EXPORTS)[number]) => {
  const resolved = resolvedEntries.get(name);
  if (resolved) {
    const importName = entryImportNames.get(resolved.entry);
    return `export const ${name} = ${importName}.${resolved.accessor};`;
  }
  if (name === "registerDaemonCli") {
    return `export const ${name} = () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
  }
  return `export const ${name} = async () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
};

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  [...entryImportNames.entries()]
    .map(([entry, importName]) => `import * as ${importName} from "../${entry}";`)
    .join("\n") +
  "\n" +
  LEGACY_DAEMON_CLI_EXPORTS.map(buildExportLine).join("\n") +
  "\n";

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
