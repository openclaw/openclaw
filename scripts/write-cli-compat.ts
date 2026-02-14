import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DAEMON_CLI_EXPORTS,
  resolveLegacyDaemonCliAccessors,
} from "../src/cli/daemon-cli-compat.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

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

const orderedCandidates = candidates.toSorted();
const resolved = orderedCandidates
  .map((entry) => {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const accessors = resolveLegacyDaemonCliAccessors(source);
    return { entry, accessors };
  })
  .find((entry) => Boolean(entry.accessors));

if (!resolved?.accessors) {
  throw new Error(
    `Could not resolve daemon-cli export aliases from dist bundles: ${orderedCandidates.join(", ")}`,
  );
}

const target = resolved.entry;
const relPath = `../${target}`;
const { accessors } = resolved;

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  `import * as daemonCli from "${relPath}";\n` +
  LEGACY_DAEMON_CLI_EXPORTS.map(
    (name) => `export const ${name} = daemonCli.${accessors[name]};`,
  ).join("\n") +
  "\n";

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
