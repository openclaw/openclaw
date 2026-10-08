// Passive preload for the opt-in released-driver cell. Never sets update markers,
// replaces application code, or observes npm lifecycle scripts as CLI handoffs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

const inputName = "readiness-handoff-input.json";
const receiptPrefix = "readiness-handoff-process-";
// Mirrors the package launch owner; the process test derives this path from
// runtimeProcessEntrypoints.updateMigratedFinalize rather than the fixture.
const finalizerEntrypoint = "dist/infra/update-migrated-finalize.worker.js";
const entrypoints = [
  "openclaw.mjs",
  "dist/index.js",
  "dist/index.mjs",
  "dist/entry.js",
  "dist/entry.mjs",
  finalizerEntrypoint,
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function processIdentity(pid) {
  const text = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  assert(/^[A-Z]$/u.test(fields[0]) && /^\d+$/u.test(fields[19]), "Invalid process identity");
  return { pid, parentPid: Number(fields[1]), started: fields[19] };
}

function packageProjection(identity) {
  return {
    version: identity.version,
    commit: identity.buildInfo.commit,
    manifest: identity.files["package.json"].sha256,
    build: identity.files["dist/build-info.json"].sha256,
    entries: Object.fromEntries(
      entrypoints
        .filter((entry) => identity.files[entry]?.sha256)
        .map((entry) => [entry, identity.files[entry].sha256]),
    ),
  };
}

export function prepareReadinessHandoff({ artifacts, packageRoot, baseline, candidate }) {
  for (const name of fs.readdirSync(artifacts)) {
    if (name.startsWith(receiptPrefix) && /^readiness-handoff-process-\d+-\d+\.json$/u.test(name)) {
      fs.rmSync(path.join(artifacts, name));
    }
  }
  const input = {
    packageRoot: fs.realpathSync(packageRoot),
    harness: processIdentity(process.pid),
    baseline: packageProjection(baseline),
    candidate: packageProjection(candidate),
  };
  assert.notEqual(
    input.baseline.commit,
    input.candidate.commit,
    "Candidate must differ from the released driver",
  );
  fs.writeFileSync(path.join(artifacts, inputName), JSON.stringify(input), { mode: 0o600 });
}

export function inspectReadinessHandoff({ artifacts, driverPid }) {
  const input = readJson(path.join(artifacts, inputName));
  const names = fs
    .readdirSync(artifacts)
    .filter((name) => /^readiness-handoff-process-\d+-\d+\.json$/u.test(name));
  assert(names.length > 0 && names.length <= 32, "Missing or excessive handoff observations");
  const observations = names.map((name) => {
    const file = path.join(artifacts, name);
    assert(
      fs.lstatSync(file).isFile() && fs.statSync(file).size <= 16_384,
      "Unsafe handoff observation",
    );
    return readJson(file);
  });
  const observed = observations.map(
    ({ role, process: identity, entry, version, commit, marker, error }) => ({
      role,
      process: identity,
      entry,
      version,
      commit,
      marker,
      error,
    }),
  );
  const evidence = JSON.stringify({ driverPid, observations: observed });
  assert(Buffer.byteLength(evidence) <= 12_000, "Handoff observations exceed publication budget");
  fs.writeFileSync(path.join(artifacts, "readiness-handoff-observations.json"), evidence, {
    mode: 0o600,
  });
  assert(!observations.some((entry) => entry.error), "Passive handoff observation failed");
  const driver = observations.find(
    (entry) => entry.role === "driver" && entry.process.pid === driverPid,
  );
  assert(driver, "The launched released updater was not observed");
  assert.equal(driver.process.parentPid, input.harness.pid);
  assert.equal(driver.marker, false, "Harness must not supply the updater marker");
  assert.equal(driver.commit, input.baseline.commit);
  const candidates = observations.filter((entry) => entry.role === "candidate");
  assert(candidates.length > 0, "No actual candidate post-core handoff observed");
  for (const candidate of candidates) {
    assert.equal(candidate.commit, input.candidate.commit);
    assert.equal(candidate.marker, true, "Released driver did not propagate its updater marker");
    assert(
      candidate.ancestors.some(
        (ancestor) =>
          ancestor.pid === driver.process.pid && ancestor.started === driver.process.started,
      ),
      "Candidate is not descended from the launched released updater",
    );
  }
  const result = {
    driver,
    candidates,
    passive: true,
    scope: "released updater to installed candidate post-core entry",
  };
  assert(
    Buffer.byteLength(JSON.stringify(result)) <= 12_000,
    "Handoff evidence exceeds the bounded publication contract",
  );
  return result;
}

function observeEntry(artifacts) {
  const input = readJson(path.join(artifacts, inputName));
  // Reject npm lifecycle entrypoints before reading their half-reified package.
  const lexicalEntry = fs.realpathSync(path.resolve(process.argv[1] ?? ""));
  const relative = path.relative(input.packageRoot, lexicalEntry).split(path.sep).join("/");
  if (!entrypoints.includes(relative)) {
    return;
  }
  const finalizer = relative === finalizerEntrypoint;
  if (!finalizer && process.argv[2] !== "update") {
    return;
  }
  if (finalizer && process.argv[2] !== undefined && process.argv[2] !== "--post-core") {
    return;
  }
  const own = processIdentity(process.pid);
  let receipt;
  try {
    assert.equal(fs.realpathSync(lexicalEntry), lexicalEntry, "CLI entry path changed");
    const manifest = hash(fs.readFileSync(path.join(input.packageRoot, "package.json")));
    const build = hash(fs.readFileSync(path.join(input.packageRoot, "dist/build-info.json")));
    const entryHash = hash(fs.readFileSync(lexicalEntry));
    const selected = ["baseline", "candidate"].find(
      (kind) =>
        input[kind].manifest === manifest &&
        input[kind].build === build &&
        input[kind].entries[relative] === entryHash,
    );
    assert(selected, "Runtime entry differs from admitted package payload");
    const role = selected === "baseline" ? "driver" : "candidate";
    if (role === "candidate" && !finalizer && process.env.OPENCLAW_UPDATE_POST_CORE !== "1") {
      return;
    }
    const ancestors = [];
    let current = own;
    for (let depth = 0; depth < 24 && current.parentPid > 1; depth++) {
      current = processIdentity(current.parentPid);
      ancestors.push(current);
      if (current.pid === input.harness.pid) {
        break;
      }
    }
    assert(
      ancestors.some(
        (entry) => entry.pid === input.harness.pid && entry.started === input.harness.started,
      ),
      "Handoff is outside the admitted harness ancestry",
    );
    // Bind the ancestry observation to the same process incarnation.
    assert.deepEqual(processIdentity(process.pid), own);
    receipt = {
      role,
      process: own,
      ancestors,
      entry: relative,
      entrySha256: entryHash,
      manifestSha256: manifest,
      buildInfoSha256: build,
      version: input[selected].version,
      commit: input[selected].commit,
      marker: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    };
  } catch {
    receipt = { process: own, error: "Unverified released-driver handoff" };
  }
  fs.writeFileSync(
    path.join(artifacts, receiptPrefix + own.pid + "-" + own.started + ".json"),
    JSON.stringify(receipt),
    { flag: "wx", mode: 0o600 },
  );
}

const observationRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
if (isMainThread && observationRoot && fs.existsSync(path.join(observationRoot, inputName))) {
  try {
    observeEntry(observationRoot);
  } catch {
    // The controller treats absent/incomplete evidence as failure after joining
    // the command. Observation never changes the product's output or exit code.
  }
}

export async function prepareReadinessHandoffPackages({
  run,
  artifacts,
  runtime,
  packageRoot,
  driverVersion,
  candidate,
  build,
  writeJson,
}) {
  const { readWorkerCellPackageIdentity, assertWorkerCellPackageIdentity } =
    await import("./worker-cell-package.mjs");
  await run("readiness-published-pack", "npm", [
    "pack",
    "openclaw@" + driverVersion,
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    runtime,
  ]);
  const packed = JSON.parse(
    fs.readFileSync(path.join(artifacts, "readiness-published-pack.stdout"), "utf8"),
  );
  assert.equal(packed.length, 1);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  const publishedTarball = path.join(runtime, packed[0].filename);
  const publishedIntegrity =
    "sha512-" + createHash("sha512").update(fs.readFileSync(publishedTarball)).digest("base64");
  const integrities = {
    "2026.9.7":
      "sha512-/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA==",
    "2026.9.8":
      "sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==",
  };
  assert.equal(publishedIntegrity, integrities[driverVersion], "Published baseline bytes changed");
  const identities = [];
  for (const [name, tarball] of [
    ["published", publishedTarball],
    ["candidate", candidate],
  ]) {
    const extracted = path.join(runtime, "readiness-identity-" + name);
    fs.mkdirSync(extracted);
    await run("readiness-identity-" + name, "tar", [
      "-xf",
      tarball,
      "-C",
      extracted,
      "package/package.json",
      "package/openclaw.mjs",
      "package/dist",
    ]);
    identities.push(readWorkerCellPackageIdentity(path.join(extracted, "package")));
  }
  const [baseline, expected] = identities;
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(packageRoot), baseline);
  assert.equal(baseline.version, driverVersion);
  assert.deepEqual(expected.buildInfo, build);
  prepareReadinessHandoff({ artifacts, packageRoot, baseline, candidate: expected });
  writeJson("readiness-package-inputs", {
    publishedIntegrity,
    baseline: baseline.buildInfo,
    candidate: expected.buildInfo,
    candidateSha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
  });
  return expected;
}
