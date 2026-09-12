// The trusted workflow owns this diagnostic projection; it never attests QA evidence.
import fs from "node:fs";
import path from "node:path";

const MAX_SHARDS = 32;
const MAX_ARTIFACTS = 128;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_MATRIX_BYTES = 256 * 1024;
const outcomes = new Set(["success", "failure", "cancelled", "skipped"]);
const timeoutOutcomes = new Set(["none", "term", "kill"]);
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// This CLI must run before candidate dependencies are available.
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exitCode = (value) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : null);
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;
const ids = (value) =>
  Array.isArray(value) &&
  value.length <= 2048 &&
  value.every((id) => typeof id === "string" && /^[a-zA-Z0-9_.-]{1,160}$/u.test(id))
    ? value
    : null;
function sameIds(actual, expected) {
  if (!ids(actual) || actual.length !== expected.length) {
    return false;
  }
  const sorted = expected.toSorted(compareText);
  return actual.toSorted(compareText).every((id, index) => id === sorted[index]);
}

function canonicalPath(filePath) {
  let ancestor = path.resolve(filePath);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function collect() {
  const env = process.env;
  if (
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(env.QA_PROFILE ?? "") ||
    (env.QA_PROFILE?.length ?? 0) > 160 ||
    !/^[0-9a-f]{40}$/u.test(env.TARGET_SHA ?? "") ||
    !/^[0-9a-f]{40}$/u.test(env.PROTOCOL_BASE_SHA ?? "") ||
    !/^[1-9][0-9]{0,19}$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]{0,5}$/u.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !env.INPUT_DIR ||
    !env.OUTPUT_DIR
  ) {
    throw new Error("Invalid workflow identity");
  }
  const inputRoot = canonicalPath(env.INPUT_DIR);
  const outputRoot = canonicalPath(env.OUTPUT_DIR);
  const relativeOutput = path.relative(inputRoot, outputRoot);
  if (
    !relativeOutput ||
    (!relativeOutput.startsWith(`..${path.sep}`) &&
      relativeOutput !== ".." &&
      !path.isAbsolute(relativeOutput))
  ) {
    throw new Error("Diagnostic output must not modify downloaded inputs");
  }
  const matrixText = env.PLAN_MATRIX_JSON ?? "";
  if (Buffer.byteLength(matrixText) > MAX_MATRIX_BYTES) {
    throw new Error("Profile matrix exceeds diagnostic limit");
  }
  const matrix = JSON.parse(matrixText);
  if (
    !record(matrix) ||
    !Array.isArray(matrix.include) ||
    matrix.include.length < 1 ||
    matrix.include.length > MAX_SHARDS ||
    matrix.include.some(
      (shard) =>
        !record(shard) ||
        typeof shard.id !== "string" ||
        !/^shard-[0-9]{2}$/u.test(shard.id) ||
        !ids(shard.categoryIds) ||
        !ids(shard.scenarioIds),
    ) ||
    new Set(matrix.include.map((shard) => shard.id)).size !== matrix.include.length
  ) {
    throw new Error("Invalid profile matrix");
  }
  const planned = new Map(matrix.include.map((shard) => [shard.id, shard]));
  const diagnostics = [];
  const add = (source, reason) => diagnostics.push({ source, reason });
  const statusCounts = new Map();
  const evidenceIds = new Set();
  const shards = [];
  let statusFiles = 0;
  let evidenceFiles = 0;
  let entries = [];
  try {
    if (!fs.lstatSync(env.INPUT_DIR).isDirectory()) {
      throw new Error("Invalid input directory");
    }
    const directory = fs.opendirSync(env.INPUT_DIR);
    try {
      for (let entry; (entry = directory.readSync()) !== null;) {
        entries.push(entry);
        if (entries.length > MAX_ARTIFACTS) {
          // Never publish an enumeration-order-dependent partial inventory.
          entries = [];
          add(null, "artifact-limit");
          break;
        }
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    add(null, "input-unavailable");
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const [index, entry] of entries.entries()) {
    // Artifact names and payload prose are untrusted; publish only an ordinal and known IDs.
    const source = `artifact-${String(index + 1).padStart(3, "0")}`;
    if (!entry.isDirectory()) {
      add(source, "invalid-artifact-directory");
      continue;
    }
    const artifactMatch = /^qa-profile-evidence-shard-(shard-[0-9]{2})-([0-9a-f]{40})$/u.exec(
      entry.name,
    );
    const artifactId = artifactMatch?.[1] ?? null;
    if (!artifactMatch || !planned.has(artifactId)) {
      add(source, "unexpected-artifact");
    }
    if (artifactMatch && artifactMatch[2] !== env.TARGET_SHA) {
      add(source, "artifact-sha-mismatch");
    }
    const directory = path.join(env.INPUT_DIR, entry.name);
    try {
      if (fs.lstatSync(path.join(directory, "qa-evidence.json")).isFile()) {
        evidenceFiles += 1;
        if (planned.has(artifactId)) {
          evidenceIds.add(artifactId);
        }
      } else {
        add(source, "invalid-evidence-file");
      }
    } catch {
      add(source, "missing-evidence-file");
    }
    let status;
    let fd;
    try {
      const statusPath = path.join(directory, "qa-profile-run-status.json");
      if (!fs.lstatSync(statusPath).isFile()) {
        throw new Error("Invalid status file");
      }
      fd = fs.openSync(statusPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      statusFiles += 1;
      if (bytes > MAX_STATUS_BYTES) {
        add(source, "status-size-limit");
        continue;
      }
      status = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
      if (!record(status) || !record(status.shard)) {
        throw new Error("Invalid status");
      }
    } catch {
      add(source, "missing-or-malformed-status");
      continue;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
    const id =
      typeof status.shard.id === "string" && /^shard-[0-9]{2}$/u.test(status.shard.id)
        ? status.shard.id
        : null;
    const expected = planned.get(id);
    if (!expected) {
      add(source, "unexpected-shard");
    }
    if (id !== artifactId) {
      add(source, "artifact-shard-mismatch");
    }
    if (expected) {
      statusCounts.set(id, (statusCounts.get(id) ?? 0) + 1);
    }
    for (const [matches, reason] of [
      [status.profile === env.QA_PROFILE, "profile-mismatch"],
      [status.target?.sha === env.TARGET_SHA, "target-sha-mismatch"],
      [status.target?.protocolBaseSha === env.PROTOCOL_BASE_SHA, "protocol-sha-mismatch"],
      [status.run?.id === env.GITHUB_RUN_ID, "run-id-mismatch"],
      [status.run?.attempt === Number(env.GITHUB_RUN_ATTEMPT), "run-attempt-mismatch"],
    ]) {
      if (!matches) {
        add(source, reason);
      }
    }
    const categoryIds = expected && sameIds(status.shard.categoryIds, expected.categoryIds);
    const scenarioIds = expected && sameIds(status.shard.scenarioIds, expected.scenarioIds);
    if (!categoryIds) {
      add(source, "category-membership-mismatch");
    }
    if (!scenarioIds) {
      add(source, "scenario-membership-mismatch");
    }
    const code = exitCode(status.exitCode);
    const timedOut = typeof status.timedOut === "boolean" ? status.timedOut : null;
    const timeoutOutcome = timeoutOutcomes.has(status.timeoutOutcome)
      ? status.timeoutOutcome
      : null;
    if (code === null || timedOut === null || timeoutOutcome === null) {
      add(source, "invalid-outcome");
    }
    if (timedOut !== null && timeoutOutcome !== null && timedOut !== (timeoutOutcome !== "none")) {
      add(source, "timeout-outcome-mismatch");
    }
    const completedAt = timestamp(status.completedAt);
    if (!completedAt) {
      add(source, "invalid-completion-time");
    }
    shards.push({
      id,
      source,
      exitCode: code,
      timedOut,
      timeoutOutcome,
      completedAt,
    });
  }
  const expectedIds = [...planned.keys()].toSorted(compareText);
  const knownTimeouts =
    shards.length === expectedIds.length &&
    expectedIds.every((id) => statusCounts.get(id) === 1) &&
    shards.every((shard) => shard.timedOut !== null);
  const timedOut = shards.some((shard) => shard.timedOut === true)
    ? true
    : knownTimeouts
      ? false
      : null;
  const result = {
    target: { sha: env.TARGET_SHA, protocolBaseSha: env.PROTOCOL_BASE_SHA },
    profile: env.QA_PROFILE,
    run: { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    shards,
    // Only the existing aggregate step owns this exit code. Missing output stays unknown.
    exitCode: /^(0|[1-9][0-9]{0,2})$/u.test(env.QA_EXIT_CODE ?? "")
      ? exitCode(Number(env.QA_EXIT_CODE))
      : null,
    timedOut,
    timeoutOutcome: shards.some((shard) => shard.timeoutOutcome === "kill")
      ? "kill"
      : shards.some((shard) => shard.timeoutOutcome === "term")
        ? "term"
        : timedOut === false
          ? "none"
          : null,
    completedAt:
      shards
        .map((shard) => shard.completedAt)
        .filter(Boolean)
        .toSorted(compareText)
        .at(-1) ?? null,
    diagnostics: {
      stages: Object.fromEntries(
        ["SHARD_JOB_OUTCOME", "DOWNLOAD_OUTCOME", "AGGREGATE_OUTCOME", "FINALIZE_OUTCOME"].map(
          (key) => [key, outcomes.has(env[key]) ? env[key] : "unknown"],
        ),
      ),
      expectedShards: expectedIds,
      statusFiles,
      evidenceFiles,
      missingStatuses: expectedIds.filter((id) => !statusCounts.has(id)),
      missingEvidence: expectedIds.filter((id) => !evidenceIds.has(id)),
      duplicateStatuses: expectedIds.filter((id) => statusCounts.get(id) > 1),
      issues: diagnostics,
    },
  };
  fs.mkdirSync(env.OUTPUT_DIR, { recursive: true });
  const fd = fs.openSync(
    path.join(env.OUTPUT_DIR, "qa-profile-run-status.json"),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

try {
  collect();
} catch {
  // Raw parser/filesystem errors can contain downloaded names or payloads.
  console.error("::warning::QA profile diagnostics could not be retained.");
  console.error("[qa-profile-run-status] FAILED (exit 1)");
  process.exitCode = 1;
}
