// On a Mac without Command Line Tools, run with a released npm tarball and the candidate tarball.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withPublishedDriverUpdate } from "./lib/upgrade-survivor/published-driver-update.mjs";

assert.equal(process.platform, "darwin");
const [source, candidate] = process.argv.slice(2).map((file) => fs.realpathSync(file));
assert(source && candidate, "Expected released and candidate package archives");
assert.notEqual(
  execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim(),
  "/usr/bin/git",
  "Put standalone Git on the shell PATH first",
);
assert.match(execFileSync("git", ["--version"], { encoding: "utf8" }), /^git version /u);
const selection = spawnSync("/usr/bin/xcode-select", ["--print-path"], { encoding: "utf8" });
assert(
  selection.status !== null && selection.status !== 0,
  "This test requires a Mac without a selected developer directory",
);
assert(!fs.existsSync(path.join(path.dirname(process.execPath), "git")), "Node has its own Git");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-git-"));
try {
  const prefix = path.join(root, "prefix");
  const home = path.join(root, "home");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(home);
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: root,
    CI: "true",
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    OPENCLAW_PROFILE: path.basename(root),
    OPENCLAW_GIT_DIR: checkout,
    npm_config_prefix: prefix,
    npm_config_cache: path.join(root, "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const buildInfo = (file) =>
    JSON.parse(
      execFileSync("tar", ["-xOzf", file, "package/dist/build-info.json"], { encoding: "utf8" }),
    );
  const before = buildInfo(source);
  const after = buildInfo(candidate);
  assert.notEqual(before.buildId, after.buildId);
  execFileSync("npm", ["install", "--global", "--prefix", prefix, source], { cwd: root, env });
  const cli = path.join(prefix, "bin/openclaw");
  const installed = () =>
    JSON.parse(
      fs.readFileSync(path.join(prefix, "lib/node_modules/openclaw/dist/build-info.json"), "utf8"),
    );
  assert.equal(installed().buildId, before.buildId);
  execFileSync(cli, ["setup", "--baseline", "--workspace", path.join(root, "workspace")], {
    cwd: root,
    env,
  });
  await withPublishedDriverUpdate({
    fromVersion: before.version,
    toVersion: after.version,
    tarball: candidate,
    env,
    runtime: root,
    timeoutMs: 900_000,
    extra: ["--no-restart"],
    run: (args, commandEnv) => execFileSync(cli, args, { cwd: root, env: commandEnv }),
  });
  assert.equal(installed().buildId, after.buildId);
  const result = spawnSync(cli, ["update", "--channel", "dev", "--yes", "--json", "--no-restart"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  const update = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(update.status, "error");
  assert.equal(update.reason, "git-version-unsupported");
  assert.match(result.stderr, /\/usr\/bin\/git/u);
  assert.match(result.stderr, /xcode-select --install/u);
  assert(!update.steps.some((step) => step.name === "git-clone"));
  assert(!fs.existsSync(checkout));
  assert.equal(installed().buildId, after.buildId);
  console.log(
    `Old updater ${before.buildId} installed ${after.buildId}; candidate refused the Git stub before cloning.`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
