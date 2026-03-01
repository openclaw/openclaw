import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const envEntry = process.env.OPENCLAW_CLI_SNAPSHOT_ENTRY;
const bundledEntry = path.resolve(cwd, "dist/entry.bundle.mjs");
const fallbackEntry = path.resolve(cwd, "dist/entry.js");
const entry = envEntry
  ? path.resolve(cwd, envEntry)
  : existsSync(bundledEntry)
    ? bundledEntry
    : fallbackEntry;
const snapshotBlob = path.resolve(
  cwd,
  process.env.OPENCLAW_CLI_SNAPSHOT_BLOB ?? "dist/openclaw-cli.snapshot.blob",
);

const warmModules = [
  path.resolve(cwd, "dist/cli/argv.js"),
  path.resolve(cwd, "dist/cli/program/context.js"),
  path.resolve(cwd, "dist/cli/program/help.js"),
];

const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-cli-snapshot-"));
const bootstrapPath = path.join(tempDir, "snapshot-bootstrap.cjs");

const warmImports = warmModules
  .map(
    (modulePath) =>
      `void import(${JSON.stringify(pathToFileURL(modulePath).href)}).catch(() => {});`,
  )
  .join("\n");

if (!existsSync(entry)) {
  console.error(`[openclaw] snapshot entry not found: ${entry}`);
  process.exit(1);
}

writeFileSync(
  bootstrapPath,
  `
const { startupSnapshot } = require("node:v8");
${warmImports}
const entryHref = ${JSON.stringify(pathToFileURL(entry).href)};
startupSnapshot.setDeserializeMainFunction(() => {
  import(entryHref).catch((error) => {
    console.error("[openclaw] snapshot entry failed:", error);
    process.exitCode = 1;
  });
});
`,
  "utf8",
);

const result = spawnSync(
  process.execPath,
  [`--snapshot-blob=${snapshotBlob}`, "--build-snapshot", bootstrapPath],
  { stdio: "inherit" },
);

rmSync(tempDir, { recursive: true, force: true });

if (result.status !== 0 || result.signal) {
  process.exit(result.status ?? 1);
}
