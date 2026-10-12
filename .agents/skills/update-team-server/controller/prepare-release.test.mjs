import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const operation = source.match(/^prepare_release\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(operation);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

test("builds historical checkouts through their existing runtime selector and package script", t => {
  const root = mkdtempSync(join(tmpdir(), "team-historical-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), resultPath = join(root, "result.json");
  mkdirSync(bin);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "historical build" } }));
  const pnpm = join(bin, "pnpm");
  writeFileSync(pnpm, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(`
    const fs = require("node:fs");
    const args = process.argv.slice(1);
    const scripts = JSON.parse(fs.readFileSync(args[1] + "/package.json")).scripts;
    if (!scripts[args[2]]) throw new Error("Unknown historical package script: " + args[2]);
    fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ args, skipDts: process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD }));
  `)} -- "$@"\n`);
  chmodSync(pnpm, 0o755);
  const build = source.replace(/\\\r?\n\s*/g, " ").split("\n")
    .find(line => line.includes('pnpm -C "$build_directory" build'));
  assert.ok(build, "controller package build invocation");
  const result = spawnSync("bash", ["-c", `set -euo pipefail
build_directory=${quote(root)}; build_budget=30; cache_environment=()
bounded_build() { shift; "$@"; }
${build}
`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RESULT_PATH: resultPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), {
    args: ["-C", root, "build"], skipDts: "1",
  });
});

function prepare(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), "team-prepare-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = "a".repeat(40), events = join(root, "events");
  mkdirSync(join(root, "releases"));
  if (scenario === "journal") writeFileSync(join(root, "activation.json"), "retained");
  if (scenario === "published") mkdirSync(join(root, "releases", target));
  const program = `set -euo pipefail
journal_file=${quote(join(root, "activation.json"))}
releases_root=${quote(join(root, "releases"))}
mirror=${quote(join(root, "mirror"))}
requested_sha=${quote(target)}; frozen_main=${quote("b".repeat(40))}; fetch_budget=30; root_uid=0
fail() { printf '%s\\n' "$*" >&2; return 1; }
event() { printf '%s\\n' "$*" >>${quote(events)}; }
system_systemctl() {
  event "systemctl $*"
  case "$1" in
    is-enabled) printf '%s\\n' ${scenario === "timer" ? "enabled" : "disabled"} ;;
    is-active) printf '%s\\n' inactive ;;
    *) return 99 ;;
  esac
}
freeze_origin_main() { [[ ${quote(scenario)} != origin ]] || fail 'foreign origin'; event fetch; }
bounded_build() { event "git $*"; ${scenario === "foreign" ? "return 1" : ":"}; }
publish_release() ( set -e; [[ ${quote(scenario)} != publisher ]]; event "publish $*"; printf '%s\\n' '{"sealed":true}'; )
proof() { event "proof $*"; [[ "$1" == validate-release ]]; printf '%s\\n' '{"sealed":true}'; }
prewarm_release() { event "prewarm $*"; }
${operation}
prepare_release
`;
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
  let log = "";
  try { log = readFileSync(events, "utf8"); } catch {}
  return { result, log };
}

test("prepares an exact official ancestor without Gateway RPC, service mutation, or pointer promotion", t => {
  const { result, log } = prepare(t, "new");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREPARED sha=a{40} action=prepare-release restart=0 activation=0/);
  assert.match(log, /git 30 git -C .* merge-base --is-ancestor a{40} b{40}/);
  assert.match(log, /publish a{40}/);
  assert.doesNotMatch(log, /systemctl (start|stop|restart|enable)|gateway|pointer/);
});
test("reuses a validated sealed release without rebuilding or resealing it", t => {
  const { result, log } = prepare(t, "published");
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /proof validate-release/);
  assert.match(log, /prewarm/);
  assert.doesNotMatch(log, /publish|seal-tree/);
});

test("prewarms as the runtime user at the published path and keeps failure advisory", t => {
  const root = mkdtempSync(join(tmpdir(), "team-prewarm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "gateway-prewarm.js"), "");
  const prewarm = source.match(/^prewarm_release\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(prewarm);
  const result = spawnSync("bash", ["-c", `set -euo pipefail
runuser_bin=runuser; runtime_home=/home/runtime; gateway_runtime_bin=/usr/bin/node
bounded() { printf '%s\\n' "$*"; return 1; }
${prewarm}
prewarm_release ${quote(root)}
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`120 runuser -u openclaw -- env -i HOME=/home/runtime PATH=/usr/bin:/bin /usr/bin/node ${root}/gateway-prewarm.mjs`));
  assert.match(result.stderr, /WARNING compile-cache prewarm failed/);
});
for (const scenario of ["journal", "timer", "foreign", "origin", "publisher"]) {
  test(`refuses ${scenario} before publication`, t => {
    const { result, log } = prepare(t, scenario);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(log, /publish|validate-release/);
  });
}
