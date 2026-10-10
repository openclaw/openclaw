import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const operation = source.match(/^prepare_release\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(operation);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

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
  assert.doesNotMatch(log, /publish|seal-tree/);
});
for (const scenario of ["journal", "timer", "foreign", "origin", "publisher"]) {
  test(`refuses ${scenario} before publication`, t => {
    const { result, log } = prepare(t, scenario);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(log, /publish|validate-release/);
  });
}
