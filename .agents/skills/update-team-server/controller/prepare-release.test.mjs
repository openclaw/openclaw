import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const operation = source.match(/^prepare_release\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(operation);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

test("sealing retains executable modes and symlinks and refuses a failed durability barrier", t => {
  const root = mkdtempSync(join(tmpdir(), "team-seal-"));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const release = join(root, "release"), bin = join(root, "bin");
  mkdirSync(join(release, "nested"), { recursive: true });
  mkdirSync(bin);
  const file = join(release, "nested/data"), executable = join(release, "run");
  writeFileSync(file, "release content\n");
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("nested/data", join(release, "link"));
  writeFileSync(join(bin, "sync"), "#!/bin/sh\nexit 74\n", { mode: 0o755 });
  const args = [new URL("./release-lib.mjs", import.meta.url).pathname, "seal-tree", release];
  const failed = spawnSync(process.execPath, args, {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.notEqual(failed.status, 0, "a failed sync cannot admit a durable release");
  assert.match(failed.stderr, /cannot sync sealed release filesystem/);
  const retried = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(retried.status, 0, retried.stderr);
  for (const directory of [release, join(release, "nested")]) {
    assert.equal(statSync(directory).mode & 0o777, 0o555);
  }
  assert.equal(statSync(file).mode & 0o777, 0o444);
  assert.equal(statSync(executable).mode & 0o777, 0o555);
  assert.equal(readFileSync(file, "utf8"), "release content\n");
  assert.equal(readlinkSync(join(release, "link")), "nested/data");
});

test("publishes standalone exact-commit releases with an inode-independent reusable package store", t => {
  const root = mkdtempSync(join(tmpdir(), "team-publish-build-"));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    OPENCLAW_TEAM_ROOT_GID: String(process.getgid()) };
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cp = process.platform === "darwin" ? "gcp" : "cp";
  const mv = process.platform === "darwin" ? "gmv" : "mv";
  if ([cp, mv].some(command => spawnSync(command, ["--version"]).status !== 0)) {
    t.skip("GNU coreutils are required for the Linux controller's publication");
    return;
  }
  const repository = join(root, "source"), buildHome = join(root, "build"), serving = join(root, "serving");
  for (const directory of [repository, join(root, "package"), join(buildHome, "work"), join(buildHome, "cache"), join(serving, "staging"), join(serving, "releases")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }));
  const content = "module.exports = 'original dependency';\n";
  writeFileSync(join(root, "package/index.js"), content);
  run("tar", ["-czf", join(repository, "dependency.tgz"), "package"]);
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "fixture-release", version: "1.0.0", openclaw: { schemaVersions: { state: 1, agent: 1 } },
    scripts: { build: "node fixture-build.cjs" }, dependencies: { "fixture-dependency": "file:./dependency.tgz" },
  }));
  writeFileSync(join(repository, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(repository, "fixture-build.cjs"), `
    const fs = require('node:fs');
    const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
    fs.mkdirSync('dist/control-ui/assets', {recursive:true});
    for (const name of ['.buildstamp', '.runtime-postbuildstamp']) fs.writeFileSync('dist/'+name, JSON.stringify({head}));
    fs.writeFileSync('dist/build-info.json', JSON.stringify({commit:head, buildId:head}));
    fs.writeFileSync('dist/index.js', 'fixture();');
    fs.writeFileSync('dist/control-ui/index.html', '<script src="./assets/app.js"></script>');
    fs.writeFileSync('dist/control-ui/assets/app.js', 'fixture();');
  `);
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], repository);
  run("git", ["init", repository]);
  run("git", ["add", "."], repository);
  writeFileSync(join(repository, "retired-source"), "historical source excluded from releases");
  run("git", ["add", "."], repository);
  run("git", ["commit", "-m", "fixture baseline"], repository);
  const retiredBlob = run("git", ["rev-parse", "HEAD:retired-source"], repository);
  rmSync(join(repository, "retired-source"));
  run("git", ["add", "-u"], repository);
  run("git", ["commit", "-m", "fixture target"], repository);
  const target = run("git", ["rev-parse", "HEAD"], repository);
  writeFileSync(join(repository, "next-source"), "next revision");
  run("git", ["add", "."], repository);
  run("git", ["commit", "-m", "fixture successor"], repository);
  const successor = run("git", ["rev-parse", "HEAD"], repository);
  const library = new URL("./release-lib.mjs", import.meta.url).pathname;
  const publish = source.match(/^publish_release\(\) \([\s\S]*?^\)/m)?.[0];
  assert.ok(publish);
  const program = `set -euo pipefail
build_home=${quote(buildHome)}; work_root="$build_home/work"
runtime_home=${quote(join(root, "runtime"))}
serving_root=${quote(serving)}; releases_root="$serving_root/releases"
mirror=${quote(repository)}; official_origin=https://github.com/openclaw/openclaw.git
root_uid=${process.getuid()}; root_gid=${process.getgid()}; deploy_file_uid=$root_uid; deploy_gid=$root_gid
node_bin=${quote(process.execPath)}; release_lib=${quote(library)}; frozen_main=${quote(successor)}
clone_budget=30; build_budget=30; mirror_git_config=(-c gc.auto=0 -c maintenance.auto=false)
run_build() { "$@"; }
bounded_build() { shift; "$@"; }
bounded() { shift; "$@"; }
fail() { printf '%s\\n' "$*" >&2; exit 1; }
proof() { [[ "$1" != release-capacity ]] || return 0; "$node_bin" --no-warnings "$release_lib" "$@"; }
prewarm_release() { :; }
chown() { command chown -hR "$root_uid:$root_gid" "$3"; }
cp() { command ${quote(cp)} "$@"; }
# A non-root fixture cannot rename the sealed directory on macOS; restore its mode before validation.
mv() { chmod u+w "$2"; command ${quote(mv)} "$@"; chmod a-w "$3"; }
${source.match(/^clean_candidate\(\) \{[\s\S]*?^\}/m)[0]}
${source.match(/^cleanup_candidate_failure\(\) \{[\s\S]*?^\}/m)[0]}
${publish}
publish_release "$1" "$mirror"
`;
  run("bash", ["-c", program, "publish", target]);
  const release = join(serving, "releases", target);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sync"), "#!/bin/sh\nexit 74\n", { mode: 0o755 });
  const originalPath = env.PATH;
  env.PATH = `${bin}:${originalPath}`;
  run("bash", ["-c", program, "publish", target]);
  env.PATH = originalPath;
  assert.equal(run("git", ["rev-parse", "HEAD"], release), target);
  assert.equal(run("git", ["remote", "get-url", "origin"], release), "https://github.com/openclaw/openclaw.git");
  assert.notEqual(spawnSync("git", ["cat-file", "-e", retiredBlob], { cwd: release }).status, 0,
    "the release must not carry unrelated source history");
  assert.equal(existsSync(join(release, ".git/objects/info/alternates")), false);
  const dependency = join(release, "node_modules/fixture-dependency/index.js");
  const storeFiles = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && readFileSync(file, "utf8") === content) {
        storeFiles.push(file);
      }
    }
  };
  walk(join(buildHome, "cache/store"));
  assert.ok(storeFiles.length, "successful publication retains pnpm's content-addressed store");
  for (const file of storeFiles) {
    assert.notEqual(statSync(file).ino, statSync(dependency).ino, "sealed dependency cannot share its store inode");
    assert.ok(statSync(file).mode & 0o200, "sealing cannot chmod the retained store");
  }
  run("bash", ["-c", program, "publish", successor]);
  for (const file of storeFiles) {
    writeFileSync(file, "changed writable cache\n");
  }
  rmSync(repository, { recursive: true, force: true });
  assert.equal(readFileSync(dependency, "utf8"), content);
  assert.equal(readFileSync(join(serving, "releases", successor, "node_modules/fixture-dependency/index.js"), "utf8"), content);
  assert.equal(run("git", ["show", `${target}:package.json`], release), readFileSync(join(release, "package.json"), "utf8"));
  assert.deepEqual(readdirSync(join(buildHome, "work")), []);
  assert.deepEqual(readdirSync(join(serving, "staging")), []);
});

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
  if (scenario === "journal") {
    writeFileSync(join(root, "activation.json"), "retained");
  }
  if (scenario === "published") {
    mkdirSync(join(root, "releases", target));
  }
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
