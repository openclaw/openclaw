// Install genuine T; its updater prepares T+1 and its resident owns rollback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSchemaDowngrade } from "./schema-downgrade.mjs";

assert(
  fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"),
  "requires an isolated container",
);
const sourceRoot = "/tmp/openclaw-release-fixtures";
const source = JSON.parse(fs.readFileSync(path.join(sourceRoot, "downgrade-source.json"), "utf8"));
assert(source.selected, "downgrade was not selected by the schema/migration diff");
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
assert(artifacts && process.env.OPENCLAW_CURRENT_PACKAGE_TGZ, "missing release artifacts");
// openclaw-temp-dir: allow isolated container owns the complete fixture until removal.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-schema-downgrade-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("OPENCLAW_") &&
      !/^npm_config_/iu.test(key) &&
      !["NODE_OPTIONS", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].includes(key),
  ),
);
Object.assign(env, {
  HOME: path.join(root, "install-home"),
  CI: "true",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
});
fs.mkdirSync(env.HOME, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
fs.copyFileSync(
  path.join(sourceRoot, "downgrade-source.json"),
  path.join(artifacts, "downgrade-source.json"),
);
const previousPrefix = path.join(root, "previous");
const npmCache = path.join(root, "npm-cache");
execFileSync(
  "npm",
  [
    "install",
    "--global",
    "--prefix",
    previousPrefix,
    "--cache",
    npmCache,
    path.join(sourceRoot, "previous.tgz"),
    "--no-audit",
    "--no-fund",
  ],
  { env, stdio: "inherit", timeout: 300_000 },
);
await runSchemaDowngrade({
  previousRoot: path.join(previousPrefix, "lib", "node_modules", "openclaw"),
  previousPrefix,
  candidateTarball: process.env.OPENCLAW_CURRENT_PACKAGE_TGZ,
  previousBuild: source.previousBuild,
  candidateBuild: source.candidateBuild,
  npmCache,
  root: path.join(root, "fixture"),
  artifacts,
  env,
});
