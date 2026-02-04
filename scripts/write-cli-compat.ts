import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

const requiredExports = [
  "registerDaemonCli",
  "runDaemonInstall",
  "runDaemonRestart",
  "runDaemonStart",
  "runDaemonStatus",
  "runDaemonStop",
  "runDaemonUninstall",
];

const findCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    if (!entry.startsWith("daemon-cli-")) {
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

// tsdown code-splits daemon-cli into a barrel chunk (side-effect imports + a subset of
// re-exports) and an inner chunk (all implementations, exported under mangled aliases).
// The barrel's own export list only includes names consumed by other chunks in the main
// bundle — it does *not* reliably contain all seven public names.  We therefore locate
// the barrel's import of the inner chunk, flip it to a re-export, and side-effect-import
// the barrel so its dependency chain is still pulled in.
let barrel: string | undefined;
let innerChunk: string | undefined;
let importBindings: string | undefined; // e.g. "{ a as runDaemonStop, … }"

for (const candidate of candidates) {
  const src = fs.readFileSync(path.join(distDir, candidate), "utf8");
  for (const other of candidates) {
    if (other === candidate) {
      continue;
    }
    const escaped = other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = src.match(new RegExp(`import\\s*(\\{[^}]+\\})\\s*from\\s*"./${escaped}"`, "m"));
    if (match) {
      barrel = candidate;
      innerChunk = other;
      importBindings = match[1];
      break;
    }
  }
  if (barrel) {
    break;
  }
}

if (!barrel || !innerChunk || !importBindings) {
  throw new Error(
    `Could not locate barrel + inner daemon-cli chunks among: ${candidates.join(", ")}`,
  );
}

// Verify every required export is present in the bindings before writing.
for (const name of requiredExports) {
  if (!new RegExp(`\\b${name}\\b`).test(importBindings)) {
    throw new Error(
      `Required export "${name}" missing from barrel→inner bindings.\nBindings: ${importBindings}`,
    );
  }
}

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  `import "../${barrel}";\n` +
  `export ${importBindings} from "../${innerChunk}";\n`;

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
