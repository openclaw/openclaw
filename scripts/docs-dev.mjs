#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
// Preview source docs with the website implementation owned by openclaw/docs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolvePreviewPython } from "./lib/docs-preview-python.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    page: { type: "string", multiple: true, default: [] },
    "site-repo": { type: "string" },
    port: { type: "string", default: "4173" },
    "build-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: pnpm docs:dev [--page <route>] [--site-repo <checkout>] [--port <port>] [--build-only]",
  );
  console.log(
    "Uses ../openclaw-docs beside the main checkout, or OPENCLAW_DOCS_SITE_REPO. Re-run after edits.",
  );
  process.exit(0);
}
if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}
const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: sourceRoot,
  encoding: "utf8",
});
const commonDir = git.status === 0 ? git.stdout.trim() : "";
const canonicalRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : sourceRoot;
const siteRepo = path.resolve(
  values["site-repo"] ||
    process.env.OPENCLAW_DOCS_SITE_REPO ||
    path.join(canonicalRoot, "..", "openclaw-docs"),
);
const manifestPath = path.join(siteRepo, "package.json");
if (
  !fs.existsSync(manifestPath) ||
  !JSON.parse(fs.readFileSync(manifestPath, "utf8")).scripts?.["docs:build:preview"]
) {
  throw new Error(
    `Docs website checkout missing at ${siteRepo}. Clone openclaw/docs beside the main checkout, or pass --site-repo <checkout>.`,
  );
}
if (!fs.existsSync(path.join(siteRepo, "node_modules"))) {
  throw new Error(`Docs website dependencies missing. Run npm ci in ${siteRepo}, then retry.`);
}
const outputDir = path.join(sourceRoot, ".cache", "docs-preview");
const buildArgs = [
  "run",
  "docs:build:preview",
  "--",
  "--source-root",
  sourceRoot,
  "--output-dir",
  outputDir,
  ...values.page.flatMap((page) => ["--page", page]),
];
const windows = process.platform === "win32";
const build = spawnSync(
  windows ? resolveWindowsCmdExePath() : "npm",
  windows ? ["/d", "/s", "/c", buildCmdExeCommandLine("npm.cmd", buildArgs)] : buildArgs,
  { cwd: siteRepo, stdio: "inherit", windowsVerbatimArguments: windows },
);
if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
if (!values["build-only"]) {
  const python = resolvePreviewPython();
  const server = spawn(
    python.command,
    [
      ...python.args,
      "-m",
      "http.server",
      values.port,
      "--bind",
      "127.0.0.1",
      "--directory",
      outputDir,
    ],
    { stdio: "inherit" },
  );
  server.on("error", (error) => {
    console.error(
      `Preview server could not start: ${error.message}. Install Python 3 or serve ${outputDir} locally.`,
    );
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.kill(signal));
  }
  server.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
  console.log(
    `Docs preview: http://127.0.0.1:${values.port}/ — re-run this command after editing.`,
  );
}
