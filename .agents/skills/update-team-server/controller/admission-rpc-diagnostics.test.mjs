import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const owner = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const declarations = [...owner.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
function ownerFunction(name) {
  const index = declarations.findIndex((match) => match[1] === name);
  assert.notEqual(index, -1, `missing owner function ${name}`);
  return owner.slice(declarations[index].index, declarations[index + 1]?.index ?? owner.length);
}

// Run the actual admission readers with inert CLI/proof boundaries. No Gateway,
// files, credentials, or deployment lifecycle are involved in these fixtures.
function admissionRead(reader, exit) {
  const script = `set -Eeuo pipefail
run_gateway() {
  [[ "$*" == "/fixture gateway call $METHOD --params {} --json --timeout 30000" ]] || exit 90
  printf '%s' "$PAYLOAD"
  return "$RPC_EXIT"
}
proof_json() {
  [[ "$1" == suspension-process-instance && "$2" == "$PAYLOAD" && "$3" == 123 ]] || exit 91
  printf fixture-instance
}
proof() {
  [[ "$1" == scheduler && "$2" == @stdin && "$(cat)" == "$PAYLOAD" ]] || exit 92
}
${ownerFunction(reader)}
${reader} /fixture 123
`;
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", RPC_EXIT: String(exit),
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      METHOD: reader === "read_process_instance" ? "system.info" : "update.status",
      PAYLOAD: '{"error":{"kind":"timeout","message":"private-fixture-do-not-log"}}' },
  });
}

for (const [reader, method, stdout] of [
  ["read_process_instance", "system.info", "fixture-instance"],
  ["assert_scheduler_owner", "update.status", ""],
]) {
  test(`${method} preserves successful JSON proof input without a failure receipt`, () => {
    const result = admissionRead(reader, 0);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, "");
  });
  for (const exit of [1, 124, 137]) {
    test(`${method} reports subprocess exit ${exit} without exposing response content`, () => {
      const result = admissionRead(reader, exit);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `GATEWAY_RPC_FAILED method=${method} exit=${exit}\n`);
    });
  }
}
