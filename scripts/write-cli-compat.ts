import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DAEMON_CLI_EXPORTS,
  resolveLegacyDaemonCliAccessors,
  resolvePartialDaemonCliAccessors,
} from "../src/cli/daemon-cli-compat.ts";

type LegacyDaemonCliExport = (typeof LEGACY_DAEMON_CLI_EXPORTS)[number];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

const isDaemonCliChunk = (entry: string) =>
  entry.startsWith("daemon-cli-") && (entry.endsWith(".js") || entry.endsWith(".mjs"));

const findCandidates = () => fs.readdirSync(distDir).filter((entry) => isDaemonCliChunk(entry));

const IMPORT_RE = /import\s+\{[^}]*\bregisterDaemonCli\b[^}]*\}\s+from\s+"\.\/([^"]+)"/;

const findRegisterChunks = (daemonCliChunks: string[]): string[] => {
  const extra: string[] = [];
  for (const entry of daemonCliChunks) {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const match = source.match(IMPORT_RE);
    if (match?.[1]) {
      extra.push(match[1]);
    }
  }
  return extra;
};

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

// Try single-chunk resolution first (fast path).
const singleChunkResolved = orderedCandidates
  .map((entry) => {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const accessors = resolveLegacyDaemonCliAccessors(source);
    return { entry, accessors };
  })
  .find((entry) => Boolean(entry.accessors));

if (singleChunkResolved?.accessors) {
  const relPath = `../${singleChunkResolved.entry}`;
  const { accessors } = singleChunkResolved;
  const contents =
    "// Legacy shim for pre-tsdown update-cli imports.\n" +
    `import * as daemonCli from "${relPath}";\n` +
    LEGACY_DAEMON_CLI_EXPORTS.map(
      (name) => `export const ${name} = daemonCli.${accessors[name]};`,
    ).join("\n") +
    "\n";

  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
} else {
  // Multi-chunk resolution: collect partial exports from daemon-cli + related chunks.
  const registerChunks = findRegisterChunks(orderedCandidates);
  const allChunks = [...orderedCandidates, ...registerChunks];
  const merged: Partial<Record<LegacyDaemonCliExport, { chunk: string; accessor: string }>> = {};
  for (const entry of allChunks) {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const partial = resolvePartialDaemonCliAccessors(source);
    if (!partial) {
      continue;
    }
    for (const name of LEGACY_DAEMON_CLI_EXPORTS) {
      if (partial[name] && !merged[name]) {
        merged[name] = { chunk: entry, accessor: partial[name] };
      }
    }
  }

  const missing = LEGACY_DAEMON_CLI_EXPORTS.filter((name) => !merged[name]);
  if (missing.length > 0) {
    throw new Error(
      `Could not resolve daemon-cli export aliases from dist bundles: ${allChunks.join(", ")}. Missing: ${missing.join(", ")}`,
    );
  }

  // Group exports by chunk for cleaner imports.
  const byChunk = new Map<string, { name: LegacyDaemonCliExport; accessor: string }[]>();
  for (const name of LEGACY_DAEMON_CLI_EXPORTS) {
    const { chunk, accessor } = merged[name]!;
    if (!byChunk.has(chunk)) {
      byChunk.set(chunk, []);
    }
    byChunk.get(chunk)!.push({ name, accessor });
  }

  const importLines: string[] = [];
  const exportLines: string[] = [];
  let idx = 0;
  for (const [chunk, exports] of byChunk) {
    const alias = `daemonCli${idx > 0 ? idx : ""}`;
    importLines.push(`import * as ${alias} from "../${chunk}";`);
    for (const { name, accessor } of exports) {
      exportLines.push(`export const ${name} = ${alias}.${accessor};`);
    }
    idx++;
  }

  const contents =
    "// Legacy shim for pre-tsdown update-cli imports.\n" +
    importLines.join("\n") +
    "\n" +
    exportLines.join("\n") +
    "\n";

  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
}
