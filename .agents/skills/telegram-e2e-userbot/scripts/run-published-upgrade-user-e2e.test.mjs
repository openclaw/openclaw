import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.ts";
import { inspectCandidateArchive } from "./published-upgrade-artifact.mjs";
import { parseUpgradeArguments } from "./run-published-upgrade-user-e2e.mjs";
import {
  publicUpgradeFailure,
  publicUpgradeReport,
  requireNormalGatewayStop,
} from "./telegram-binding-upgrade-verdict.mjs";

const commit = "a".repeat(40);
const buildInfo = { version: "2026.9.6", commit, buildId: "fixture-build" };
const temporary = useAutoCleanupTempDirTracker(afterEach);

test("requires an exact published baseline and unambiguous absolute paths", () => {
  const args = [
    "--candidate",
    "/candidate.tgz",
    "--baseline",
    "/prefix/bin/openclaw",
    "--baseline-spec",
    "openclaw@2026.9.6",
    "--output",
    "/public",
  ];
  assert.equal(parseUpgradeArguments(args).version, "2026.9.6");
  for (const spec of [
    "openclaw@latest",
    "openclaw@beta",
    "other@2026.9.6",
    "file:/candidate.tgz",
  ]) {
    assert.throws(() =>
      parseUpgradeArguments(args.map((value) => (value === "openclaw@2026.9.6" ? spec : value))),
    );
  }
  assert.throws(() => parseUpgradeArguments([...args, "--candidate", "/other.tgz"]));
  assert.throws(() =>
    parseUpgradeArguments(args.map((value) => (value === "/public" ? "relative" : value))),
  );
});

test("reads the actual packaged Telegram owners without executing or extracting package code", async () => {
  const root = temporary.make("telegram-upgrade-contract-");
  const tarball = path.join(root, "candidate.tgz");
  const files = {
    "package.json": JSON.stringify({ name: "openclaw", version: buildInfo.version }),
    "dist/build-info.json": JSON.stringify(buildInfo),
    "dist/entry.js": "throw new Error('package code must never execute');",
    "dist/plugin-sdk/logging-core.js": "export const redactSensitiveText = value => value;",
    "dist/extensions/telegram/package.json": "{}",
    "dist/extensions/telegram/index.js": "export default {};",
    "dist/extensions/telegram/channel-plugin-api.js":
      'import { t as telegramPlugin } from "../../channel-fixture.mjs";',
    "dist/channel-fixture.mjs":
      'import { t as createTelegramThreadBindingManager } from "./thread-bindings-fixture.mjs";\nimport { n as resolveTelegramTransport } from "./fetch-fixture.mjs";',
    "dist/thread-bindings-fixture.mjs": "export const fixture = 'binding';",
    "dist/fetch-fixture.mjs": "export const fixture = 'transport';",
  };
  const writeArchive = () =>
    execFileSync(
      "python3",
      [
        "-c",
        `import io,json,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
 for name, text in json.load(sys.stdin).items():
  data=text.encode(); member=tarfile.TarInfo('package/'+name); member.size=len(data)
  archive.addfile(member, io.BytesIO(data))`,
        tarball,
      ],
      { input: JSON.stringify(files) },
    );
  writeArchive();
  const result = await inspectCandidateArchive(tarball);
  assert.deepEqual(result.buildInfo, buildInfo);
  assert.equal(Object.keys(result.runtimeHashes).length, 9);
  for (const [name, digest] of Object.entries(result.runtimeHashes)) {
    assert.equal(digest, createHash("sha256").update(files[name]).digest("hex"));
  }
  assert.equal(result.sha256, createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"));
  files["dist/channel-fixture.mjs"] = files["dist/channel-fixture.mjs"].replace(
    "./fetch-fixture.mjs",
    "../../outside.mjs",
  );
  writeArchive();
  await assert.rejects(inspectCandidateArchive(tarball), /CANDIDATE_ARCHIVE_INSPECTION_FAILED/u);
  assert.deepEqual(fs.readdirSync(root), ["candidate.tgz"]);
});

test("confirmed process-group cleanup cannot qualify a killed or failed Gateway shutdown", () => {
  const runtime = {
    installedCommit: commit,
    entrySha256: "entry-digest",
    installedRoot: "/isolated/package",
  };
  const stopped = {
    phase: "baseline-before-update",
    joined: true,
    outcomeType: "exit",
    exitCode: 0,
    signal: null,
    graceMs: 60000,
    runtime: {
      build: { commit },
      entrySha256: runtime.entrySha256,
      packageRoot: runtime.installedRoot,
    },
  };
  requireNormalGatewayStop(stopped, runtime, stopped.phase);
  for (const change of [
    { signal: "SIGKILL", exitCode: null },
    { exitCode: 17 },
    { joined: false },
    { cleanupUnconfirmed: true },
    { phase: "candidate-final" },
  ]) {
    assert.throws(
      () => requireNormalGatewayStop({ ...stopped, ...change }, runtime, stopped.phase),
      /ORDERLY_SHUTDOWN/u,
    );
  }
  assert.throws(() =>
    requireNormalGatewayStop(
      stopped,
      { ...runtime, installedCommit: "b".repeat(40) },
      stopped.phase,
    ),
  );
});

test("public failure evidence keeps typed outcomes while dropping credentials, identities and raw RPC text", () => {
  const root = temporary.make("telegram-upgrade-contract-");
  const secret = "PRIVATE_CREDENTIAL_AND_CHAT_CANARY";
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write("updater-readback.json", {
    exitCode: 17,
    joined: true,
    beforeBuild: buildInfo,
    afterBuild: { ...buildInfo, commit: secret },
    stderr: secret,
    stateDir: secret,
  });
  write("gateway-stop-baseline-before-update.json", {
    joined: true,
    exitCode: null,
    signal: "SIGKILL",
    runtime: secret,
  });
  write("routing-spawn.json.diagnostic.json", {
    status: "failed",
    stage: "parent-history",
    code: "CHECKPOINT_RPC_FAILED",
    timedOut: true,
    missing: ["PARENT_NATIVE_ACK", secret],
    rpc: {
      method: "sessions.get",
      exitCode: 1,
      remoteCode: "UNAVAILABLE",
      stdout: secret,
      stderr: secret,
      remoteMessage: secret,
    },
  });
  write("routing-before.json.diagnostic.json", {
    status: "failed",
    stage: "phase-conditions",
    code: "FOLLOWUP_ROUTED_TO_CHILD",
    earlyPhase: secret,
  });
  write("cleanup.json", { ok: false, retainedLease: true, error: secret, groupId: secret });
  const report = publicUpgradeFailure(root, "live-scenario");
  assert.equal(report.updater.exitCode, 17);
  assert.deepEqual(report.updater.before, { version: buildInfo.version, commit });
  assert.equal(report.updater.after, undefined);
  assert.equal(report.gatewayStops[0].signal, "SIGKILL");
  assert.equal(report.checkpoints[0].code, "CHECKPOINT_RPC_FAILED");
  assert.equal(report.checkpoints[0].rpc.remoteCode, "UNAVAILABLE");
  assert.deepEqual(report.checkpoints[0].missing, ["PARENT_NATIVE_ACK"]);
  assert.deepEqual(
    { phase: report.checkpoints[1].phase, code: report.checkpoints[1].code },
    { phase: "before", code: "FOLLOWUP_ROUTED_TO_CHILD" },
  );
  assert.deepEqual(report.cleanup, {
    confirmed: false,
    fixtureConfirmed: false,
    leaseReleased: null,
    retainedLease: true,
    ownedGroupDeleted: false,
  });
  assert.equal(JSON.stringify(report).includes(secret), false);
  write("cleanup.json", { ok: true, groupDeleted: true });
  const releaseUnconfirmed = publicUpgradeFailure(root, "live-scenario").cleanup;
  assert.equal(releaseUnconfirmed.fixtureConfirmed, true);
  assert.equal(releaseUnconfirmed.confirmed, false);
  assert.equal(releaseUnconfirmed.leaseReleased, null);
});

test("public success retains actual shutdown and updater receipts without private proof references", () => {
  const root = temporary.make("telegram-upgrade-success-");
  const secret = "PRIVATE_CREDENTIAL_AND_CHAT_CANARY";
  fs.writeFileSync(
    path.join(root, "cleanup.json"),
    JSON.stringify({ ok: true, leaseReleased: true, groupId: secret }),
  );
  fs.writeFileSync(
    path.join(root, "updater-readback.json"),
    JSON.stringify({
      exitCode: 0,
      joined: true,
      durationMs: 12345,
      beforeBuild: buildInfo,
      afterBuild: buildInfo,
      stateDir: secret,
    }),
  );
  const phases = ["baseline-before-update", "candidate-restart", "candidate-final"];
  for (const [index, phase] of phases.entries()) {
    fs.writeFileSync(
      path.join(root, `gateway-stop-${phase}.json`),
      JSON.stringify({
        phase,
        joined: true,
        exitCode: 0,
        signal: null,
        durationMs: 100 + index,
        runtime: secret,
      }),
    );
  }
  const result = {
    ok: true,
    topicReturnedToParentAcrossRestart: true,
    verifiedRestarts: 2,
    nativePhases: ["PARENT", "CHILD", "BEFORE", "AFTER"],
    providerRequests: 5,
    childKey: secret,
    sessionId: secret,
    fixture: secret,
  };
  const report = publicUpgradeReport(
    result,
    {
      baseline: { buildInfo },
      candidate: { buildInfo, sha256: "b".repeat(64) },
      prefix: secret,
      token: secret,
    },
    root,
  );
  assert.equal(report.topicReturnedToParentAcrossUpgradeAndRestart, true);
  assert.equal(report.orderlyGatewayStops, 3);
  assert.equal(report.updater.durationMs, 12345);
  assert.deepEqual(
    report.gatewayStops.map(({ phase, exitCode, signal, joined, durationMs }) => ({
      phase,
      exitCode,
      signal,
      joined,
      durationMs,
    })),
    phases.map((phase, index) => ({
      phase,
      exitCode: 0,
      signal: null,
      joined: true,
      durationMs: 100 + index,
    })),
  );
  assert.equal(JSON.stringify(report).includes(secret), false);
});
