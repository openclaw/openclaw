// Task-only controls for the capture association that failed in41789229214.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectUpdateCapture } from "./br-beta-native-evidence.mjs";

function fixture() {
  const creator = { host: "synthetic-runner", pid: 123, startIdentity: "456" };
  const owner = { stateDir: "/synthetic/state", configPath: "/synthetic/state/openclaw.json",
    installRoot: "/synthetic/package", baselineVersion: "2026.11.5-beta.1", candidateVersion: "2026.10.10",
    baselineBuildId: "published-beta", candidateBuildId: "bcae-exact-package" };
  const doctor = { name: "doctor-baseline", sha256: "unchanged-doctor-manifest",
    files: [{ archivePath: "payload/0", size: 414, sha256: "unchanged-doctor-bytes" }],
    manifest: { runId: "doctor-baseline", creator: { ...creator, pid: 122 } } };
  const update = { name: "actual-update", sha256: "sealed-update-manifest", manifest: {
    schemaVersion: 2, kind: "update-recovery", generation: { kind: "baseline" }, runId: "actual-update",
    stateDir: owner.stateDir, configPath: owner.configPath, installRoot: owner.installRoot,
    creator: structuredClone(creator), drivers: [structuredClone(creator)] } };
  return { owner, before: { captures: [doctor], ledger: {} },
    after: { captures: [structuredClone(doctor), update], ledger: { lastRun: {
      runId: "actual-update", before: { buildId: owner.baselineBuildId }, after: { buildId: owner.candidateBuildId },
      origin: {
        driver: { ...creator, pid: 124, startIdentity: "789" }, previousDrivers: [structuredClone(creator)],
        admission: { owner: "candidate", protocol: 1, candidateVersion: owner.candidateVersion },
        candidateAdmission: { protocol: 1, verdict: "admit", facts: {
          installedVersion: owner.baselineVersion, candidateVersion: owner.candidateVersion } } } } } },
    result: { runId: "actual-update", run: { runId: "actual-update" } } };
}

test("selects the new updater capture and preserves an earlier Doctor capture across driver handoff", () => {
  const input = fixture();
  const before = structuredClone(input);
  assert.equal(selectUpdateCapture(input).name, "actual-update");
  assert.deepEqual(input, before, "Selection must not delete or rewrite any capture evidence");
});

test("refuses missing, foreign, ambiguous, reused or invalid capture ownership", () => {
  const controls = [
    ["missing", (input) => input.after.captures.pop(), /Expected one capture owned/],
    ["foreign run", (input) => input.after.captures[1].manifest.runId = "foreign", /Expected one capture owned/],
    ["foreign ledger", (input) => input.after.ledger.lastRun.runId = "foreign", /foreign run/],
    ["foreign driver", (input) => input.after.captures[1].manifest.creator.pid = 999, /creator is foreign/],
    ["foreign admission", (input) => input.after.ledger.lastRun.origin.candidateAdmission.verdict = "refuse", /refuse/],
    ["invalid generation", (input) => input.after.captures[1].manifest.generation.kind = "candidate", /candidate/],
    ["invalid schema", (input) => input.after.captures[1].manifest.schemaVersion = 3, /3 !== 2/],
    ["foreign state", (input) => input.after.captures[1].manifest.stateDir = "/foreign", /foreign/],
    ["ambiguous", (input) => input.after.captures.push(structuredClone(input.after.captures[1])), /Expected one capture owned/],
    ["reused", (input) => input.before.captures.push(structuredClone(input.after.captures[1])), /predates update/],
    ["lost Doctor", (input) => input.after.captures.shift(), /Earlier capture disappeared/],
    ["rewritten Doctor", (input) => input.after.captures[0].sha256 = "changed", /Earlier capture manifest changed/],
    ["changed Doctor payload", (input) => input.after.captures[0].files[0].sha256 = "changed", /Earlier capture payload bytes changed/],
  ];
  for (const [name, mutate, expected] of controls) {
    const input = fixture();
    mutate(input);
    assert.throws(() => selectUpdateCapture(input), expected, name);
  }
});
