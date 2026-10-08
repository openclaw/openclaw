// Explicit release-cell fault injection; never imports or rewrites product modules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import {
  observeRequiredSnapshotRequests,
  snapshotProcessStart,
  snapshotFsPath,
} from "./snapshot-capture-binding.mjs";
import {
  assertSelectedSnapshotAcquisitions,
  assertSnapshotFailureCustody,
  observeSnapshotParentRetirement,
  snapshotEvidenceRecords,
  summarizeSnapshotCleanupEvidence,
} from "./snapshot-cleanup-evidence.mjs";
import { installSnapshotCopyFault, snapshotCopyRefusal } from "./snapshot-copy-fault.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const fixtureName = "snapshot-cleanup-fixture.json";
const nativeReceipt = (artifacts, request) =>
  path.join(artifacts, "snapshot-cleanup-native-" + request.key + ".json");
const optionalJson = (file) => (fs.existsSync(file) ? readJson(file) : undefined);
const refusal = snapshotCopyRefusal;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

function isRuntimeEntrypoint(relative) {
  return relative === "openclaw.mjs" || relative.startsWith("dist/");
}

function readIdentityAtRoot(root, file, relative) {
  const manifest = fs.readFileSync(path.join(root, "package.json"));
  const build = fs.readFileSync(path.join(root, "dist/build-info.json"));
  const info = JSON.parse(build.toString("utf8"));
  return {
    root,
    version: info.version,
    commit: info.commit,
    entrypoint: relative,
    entrypointSha256: hash(fs.readFileSync(file)),
    manifestSha256: hash(manifest),
    buildInfoSha256: hash(build),
  };
}

export function readSnapshotProcessIdentity(entrypoint, expected, admittedRoot) {
  if (!entrypoint) {
    return undefined;
  }
  const requested = path.resolve(entrypoint);
  const relative = (file) => path.relative(admittedRoot, file).split(path.sep).join("/");
  // Preserve selection from the already verified Doctor root, not mutable
  // package metadata. Resolve parent aliases even when the entry was removed.
  let selectedRelative =
    admittedRoot && isRuntimeEntrypoint(relative(requested)) ? relative(requested) : undefined;
  let resolved;
  if (admittedRoot) {
    let ancestor = requested;
    const missing = [];
    while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
      const parent = path.dirname(ancestor);
      assert(parent !== ancestor, "Runtime argument has no existing ancestor");
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const viaAncestor = path.join(fs.realpathSync(ancestor), ...missing);
    if (isRuntimeEntrypoint(relative(viaAncestor))) {
      selectedRelative ??= relative(viaAncestor);
    }
    if (!missing.length) {
      resolved = viaAncestor;
    }
  }
  if (!fs.lstatSync(requested, { throwIfNoEntry: false })) {
    assert(selectedRelative === undefined, "Selected candidate runtime is missing");
    return undefined;
  }
  const file = resolved ?? fs.realpathSync(requested);
  const actualRelative = admittedRoot ? relative(file) : undefined;
  if (selectedRelative !== undefined || (actualRelative && isRuntimeEntrypoint(actualRelative))) {
    assert(
      actualRelative && isRuntimeEntrypoint(actualRelative),
      "Selected runtime escaped its admitted package",
    );
    assert(fs.statSync(file).isFile(), "Selected candidate runtime is not a regular file");
    return bindSnapshotRuntimeIdentity(
      readIdentityAtRoot(admittedRoot, file, actualRelative),
      expected,
    );
  }
  // Eval/print probes can pass directories as argv[1]. They are not selected
  // application invocations; never try to hash them as executable files.
  if (!fs.statSync(file).isFile()) {
    return undefined;
  }
  for (let root = path.dirname(file), depth = 0; depth < 5; root = path.dirname(root), depth++) {
    const manifest = path.join(root, "package.json");
    const build = path.join(root, "dist/build-info.json");
    if (fs.existsSync(manifest) && fs.existsSync(build) && readJson(manifest).name === "openclaw") {
      const identity = readIdentityAtRoot(
        root,
        file,
        path.relative(root, file).split(path.sep).join("/"),
      );
      return expected && identity.commit === expected.buildInfo.commit
        ? bindSnapshotRuntimeIdentity(identity, expected)
        : identity;
    }
  }
  return undefined;
}

export function seedSnapshotCleanupRefusal({
  source,
  artifacts,
  candidateIdentity,
  baseline,
  gatewayPid,
}) {
  assert.equal(baseline.version, "2026.9.7");
  const candidateCommit = candidateIdentity.buildInfo.commit;
  assert.match(candidateCommit, /^[0-9a-f]{40}$/u);
  assert(Number.isSafeInteger(gatewayPid) && gatewayPid > 1);
  const database = new DatabaseSync(source);
  try {
    database.exec(
      "CREATE TABLE snapshot_cleanup_witness(value INTEGER NOT NULL); INSERT INTO snapshot_cleanup_witness VALUES(0)",
    );
  } finally {
    database.close();
  }
  writeJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"), candidateIdentity);
  writeJson(path.join(artifacts, fixtureName), { source, candidateCommit, baseline, gatewayPid });
}

function doctorAncestor(artifacts) {
  for (let pid = process.pid, depth = 0; pid > 1 && depth < 12; depth++) {
    const file = path.join(artifacts, "snapshot-cleanup-doctor-" + pid + ".json");
    if (fs.existsSync(file)) {
      return readJson(file);
    }
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function bindSnapshotRuntimeIdentity(identity, expected) {
  // NODE_OPTIONS reaches npm lifecycle scripts too. Only packaged application
  // entrypoints belong to this observer; unknown dist workers still fail closed.
  if (!isRuntimeEntrypoint(identity.entrypoint)) {
    return undefined;
  }
  assert.equal(identity.entrypointSha256, expected.files[identity.entrypoint]?.sha256);
  assert.equal(identity.manifestSha256, expected.files["package.json"]?.sha256);
  assert.equal(identity.buildInfoSha256, expected.files["dist/build-info.json"]?.sha256);
  return { ...identity, payloadSha256: hash(JSON.stringify(expected)) };
}

function installFault() {
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  if (!artifacts || !fs.existsSync(path.join(artifacts, fixtureName))) {
    return;
  }
  assert.equal(process.platform, "linux");
  assert(fs.existsSync("/.dockerenv"), "Snapshot fault injection requires disposable Docker state");
  const fixture = readJson(path.join(artifacts, fixtureName));
  const expected = readJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"));
  const admittedDoctor = doctorAncestor(artifacts);
  if (admittedDoctor) {
    assert.equal(admittedDoctor.fullPayloadVerified, true);
    assert.equal(admittedDoctor.identity.commit, fixture.candidateCommit);
    assert.equal(admittedDoctor.identity.payloadSha256, hash(JSON.stringify(expected)));
  }
  const identity = readSnapshotProcessIdentity(
    process.argv[1],
    expected,
    admittedDoctor?.identity.root,
  );
  if (!identity) {
    return;
  }
  const role = process.argv[2] === "--doctor" ? "doctor" : process.argv[2];
  if (isMainThread && role === "update" && identity.version === fixture.baseline.version) {
    writeJson(path.join(artifacts, "snapshot-cleanup-driver.json"), { pid: process.pid, identity });
  }
  if (identity.commit !== fixture.candidateCommit) {
    return;
  }
  const doctorFile = path.join(artifacts, "snapshot-cleanup-doctor-" + process.pid + ".json");
  if (isMainThread && role === "doctor") {
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(identity.root), expected);
    writeJson(doctorFile, {
      pid: process.pid,
      parentPid: process.ppid,
      identity,
      updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
      fullPayloadVerified: true,
      start: snapshotProcessStart(process.pid),
    });
  }
  const selected = [];
  const persist = (request) => {
    if (request.binding) {
      writeJson(nativeReceipt(artifacts, request), request);
    }
  };
  const observer =
    isMainThread && role === "doctor"
      ? observeRequiredSnapshotRequests({
          source: fixture.source,
          verifyFrame(site, kind) {
            const relative = path.relative(identity.root, site.file).split(path.sep).join("/");
            assert(relative.startsWith("dist/"), "Capture caller escaped the admitted package");
            if (kind === "retirement") {
              assert(
                relative.startsWith("dist/sqlite-readonly-worker-session-") &&
                  relative.endsWith(".mjs"),
                "Unrecognized worker retirement owner",
              );
            }
            assert.equal(hash(fs.readFileSync(site.file)), expected.files[relative]?.sha256);
            site.file = relative;
            site.sha256 = expected.files[relative].sha256;
          },
          onRequest(request) {
            if (!request.binding) {
              return;
            }
            assert(
              !fs.existsSync(nativeReceipt(artifacts, request)),
              "Capture request reused an existing observation key",
            );
            selected.push(request);
            persist(request);
          },
          onUpdate: persist,
        })
      : undefined;
  if (isMainThread && role === "doctor") {
    const writeFile = fs.promises.writeFile;
    fs.promises.writeFile = async function (file, data, ...rest) {
      const result = await writeFile.call(this, file, data, ...rest);
      if (
        snapshotFsPath(file) === process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH &&
        typeof data === "string"
      ) {
        const value = JSON.parse(data);
        const doctor = readJson(doctorFile);
        doctor.result = {
          status: value.status,
          failureFacts: value.failureFacts,
          sha256: hash(data),
        };
        writeJson(doctorFile, doctor);
      }
      return result;
    };
  }
  installSnapshotCopyFault({
    source: fixture.source,
    artifacts,
    identity,
    currentBinding: () => observer?.currentBinding(),
    loadRequest(request) {
      const native = optionalJson(nativeReceipt(artifacts, request));
      if (native?.binding) {
        assert.equal(native.parentPid, admittedDoctor?.pid);
        assert.equal(native.parentStart, admittedDoctor?.start);
      }
      return native;
    },
    canInject() {
      if (!doctorAncestor(artifacts)?.updateInProgress) {
        return false;
      }
      try {
        process.kill(fixture.gatewayPid, 0);
        return false;
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
        return true;
      }
    },
    describeContext: () => ({ doctor: doctorAncestor(artifacts) }),
  });
  if (observer) {
    observeSnapshotParentRetirement(
      selected,
      (request) =>
        optionalJson(path.join(artifacts, "snapshot-cleanup-copy-" + request.key + ".json")),
      persist,
    );
  }
  syncBuiltinESMExports();
}

export function writeSnapshotCleanupEvidence(artifacts) {
  let summary;
  try {
    summary = summarizeSnapshotCleanupEvidence(artifacts);
  } catch (error) {
    summary = {
      version: 2,
      unknown: ["evidence-collection"],
      overflow: false,
      error: String(error.message).slice(0, 256),
    };
  }
  writeJson(path.join(artifacts, "snapshot-cleanup-evidence.json"), summary);
}

export function assertSnapshotCleanupRefusal(artifacts, updateResult, updateFailure) {
  if (!updateResult) {
    throw updateFailure ?? new Error("Published update did not settle before the fault proof");
  }
  const stdout = fs.readFileSync(path.join(artifacts, "update.stdout"), "utf8");
  const result = JSON.parse(stdout.slice(stdout.indexOf("{")));
  writeJson(path.join(artifacts, "snapshot-cleanup-result.json"), {
    exitCode: updateResult.exitCode,
    signal: updateResult.signal,
    status: result.status,
    failedDoctorStep:
      result.steps?.some(
        (step) =>
          step.name === "openclaw doctor" && Number.isInteger(step.exitCode) && step.exitCode > 0,
      ) === true,
  });
  const fixture = readJson(path.join(artifacts, fixtureName));
  const driver = readJson(path.join(artifacts, "snapshot-cleanup-driver.json"));
  assert.equal(driver.identity.commit, fixture.baseline.commit);
  const receipts = fs
    .readdirSync(artifacts)
    .filter((file) => /^snapshot-cleanup-copy-[0-9a-f]{64}\.json$/u.test(file))
    .map((file) => readJson(path.join(artifacts, file)));
  assert.equal(
    receipts.length,
    1,
    "Expected one candidate-owned fault, not an old-driver or direct helper call",
  );
  const observed = receipts[0];
  assert.equal(observed.identity.commit, fixture.candidateCommit);
  assert.equal(observed.doctor.identity.commit, fixture.candidateCommit);
  assert.equal(observed.doctor.updateInProgress, true);
  assert.equal(observed.doctor.fullPayloadVerified, true);
  const expectedPayload = hash(
    JSON.stringify(readJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"))),
  );
  assert.equal(observed.identity.payloadSha256, expectedPayload);
  assert.equal(observed.doctor.identity.payloadSha256, expectedPayload);
  assert(observed.cleanupDenials > 0, "No real copy cleanup was refused");
  const records = snapshotEvidenceRecords(artifacts);
  const { native: selected, counts: acquisitions } = assertSelectedSnapshotAcquisitions(
    records,
    observed,
    expectedPayload,
  );
  assert.equal(
    observed.groupIncompleteAtRefusal,
    true,
    "Failed required backup group was not incomplete",
  );
  assert.equal(
    fs.existsSync(selected.binding.target),
    false,
    "Failed source was published as a verified backup",
  );
  assert.equal(selected.source, fixture.source);
  assert.equal(selected.parentPid, observed.doctor.pid);
  assert.equal(selected.operationId, observed.native.operationId);
  const marker = fs.lstatSync(selected.binding.marker, { bigint: true });
  assert(marker.isFile() && marker.size === 0n, "Failed required group lost its incomplete marker");
  assert.deepEqual(
    { dev: String(marker.dev), ino: String(marker.ino), mtimeNs: String(marker.mtimeNs) },
    selected.binding.markerIdentity,
  );
  const doctor = records.doctors.find((row) => row.pid === observed.doctor.pid);
  assert.equal(
    doctor?.result?.status,
    "error",
    "Required capture did not produce Doctor status:error",
  );
  assert.equal(
    observed.terminalRefusal,
    true,
    "Candidate did not surface terminal aggregate refusal",
  );
  assert.equal(
    observed.sourcePreservedAtRefusal,
    true,
    "Capture changed the source after the fixture writer",
  );
  assert.equal(
    observed.unpublishedAtRefusal,
    true,
    "The failed attempt was published as a snapshot",
  );
  assert(
    Number.isInteger(updateResult.exitCode) && updateResult.exitCode > 0,
    "Updater swallowed the copy refusal and returned success",
  );
  assert.equal(updateResult.signal, null, "Updater was terminated instead of reporting refusal");
  assert.equal(result.status, "error", "Updater did not publish a failed result");
  assert.equal(
    readJson(path.join(artifacts, "snapshot-cleanup-result.json")).failedDoctorStep,
    true,
    "Required Doctor failure was not a failed public step",
  );
  const publicOutput = stdout + fs.readFileSync(path.join(artifacts, "update.stderr"), "utf8");
  assert(publicOutput.includes(refusal), "Published updater omitted the candidate capture refusal");
  // Source-family hashes were compared at the producer refusal boundary,
  // before the installed updater's independent rollback/restore policy runs.
  assert.equal(
    observed.retainedAtRefusal,
    true,
    "Unresolved private scratch was not retained at refusal",
  );
  assertSnapshotFailureCustody(selected, observed);
  assert.equal(fs.existsSync(selected.stagingRoot), false);
  assert(
    !fs.existsSync(observed.staging),
    "Unpublished staging still exists after updater settlement",
  );
  const compact = summarizeSnapshotCleanupEvidence(artifacts);
  assert.equal(compact.overflow, false, "Critical snapshot evidence overflow");
  assert.deepEqual(compact.unknown, [], "Critical snapshot evidence remains unobserved");
  const proof = {
    status: "passed",
    baseline: fixture.baseline,
    candidateCommit: fixture.candidateCommit,
    updateExit: updateResult.exitCode,
    acquisitions,
    fault: { pid: observed.pid, operationId: selected.operationId },
    custody: selected.retirement,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    limitation:
      "Synthetic SQLite writer commits then exits by SIGKILL to retain WAL; filesystem EACCES is injected in a Linux container. Not Darwin or large-data proof.",
  };
  writeJson(path.join(artifacts, "snapshot-cleanup-proof.json"), proof);
  console.log("SNAPSHOT_CLEANUP_REFUSAL " + JSON.stringify(proof));
}

installFault();
