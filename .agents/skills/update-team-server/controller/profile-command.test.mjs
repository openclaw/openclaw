import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(process.env.PROFILE_FAILURE_TEST_OWNER ?? new URL("./openclaw-release-deploy", import.meta.url), "utf8");
function owner(name) {
  const definitions = [...source.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)\(\) \{/gm)];
  const index = definitions.findIndex(value => value[1] === name);
  assert(index >= 0, name);
  const start = definitions[index].index;
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

for (const operation of ["prepare", "inspect"]) {
  test(`profiling ${operation} classifies a killed proof owner before further work`, { skip: process.platform !== "linux" }, t => {
    const root = mkdtempSync(join(tmpdir(), "controller-profile-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const library = join(root, "killed-owner.mjs");
    writeFileSync(library, 'process.stdin.resume(); process.stdin.on("end", () => process.kill(process.pid, "SIGKILL"));\n');
    const script = `set -Eeuo pipefail
node_bin="$TEST_NODE"; release_lib="$TEST_LIBRARY"; timeout_bin=/usr/bin/timeout
profile_owner_unsafe=0; profile_result=""
${owner("bounded_proof")}
${owner("profile_command")}
code=0; profile_command "$TEST_OPERATION" '{}' >/dev/null || code=$?
printf 'RESULT %s %s\\n' "$code" "$profile_owner_unsafe"
if [[ "$TEST_OPERATION" == prepare ]]; then
  release_lib=/absent-must-not-launch
  code=0; profile_command cleanup '{}' >/dev/null || code=$?
  printf 'NEXT %s\\n' "$code"
fi
`;
    const result = spawnSync("bash", ["-c", script], {
      env: { PATH: "/usr/bin:/bin", TEST_NODE: process.execPath, TEST_LIBRARY: library,
        TEST_OPERATION: operation, TMPDIR: root }, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /unbound variable/);
    if (operation === "prepare") {
      assert.equal(result.stdout, "RESULT 76 76\nNEXT 76\n");
      assert.match(result.stderr, /PROFILE_OWNER_UNJOINED phase=prepare supervisor_exit=137 further-mutation=refused/);
    } else {
      assert.equal(result.stdout, "RESULT 137 0\n");
      assert.match(result.stderr, /PROFILE_READ_INCOMPLETE phase=inspect exit=137/);
    }
  });
}
