import { isRecord } from "./record-shared.mjs";
// Publication policy only. Candidate workflows must never consume this declaration.
import lanes from "./release-validation-waivable-lanes.json" with { type: "json" };
import { parseReleaseVersion } from "./release-version.mjs";

const SCHEMA = "openclaw.release-validation-waivers/v1";
const RELEASE_CHECK_ROLES = new Set([
  "releaseChecks",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
]);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`Invalid release validation waiver: ${message}`);
  }
}

function exactKeys(value, keys, label) {
  requireValue(
    isRecord(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${label} fields`,
  );
}

function text(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function parseReleaseValidationWaivers(input) {
  let value = input;
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    requireValue(Buffer.byteLength(value) <= 64 * 1024, "declaration is oversized");
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Invalid release validation waiver: expected JSON object");
    }
  }
  exactKeys(
    value,
    ["schema", "targetVersion", "candidateSha", "parentRunId", "parentRunAttempt", "waivers"],
    "declaration",
  );
  requireValue(value.schema === SCHEMA, "unsupported schema");
  requireValue(
    typeof value.targetVersion === "string" &&
      parseReleaseVersion(value.targetVersion)?.version === value.targetVersion,
    "target version",
  );
  requireValue(
    typeof value.candidateSha === "string" && /^[a-f0-9]{40}$/u.test(value.candidateSha),
    "candidate SHA",
  );
  requireValue(
    typeof value.parentRunId === "string" && /^[1-9][0-9]*$/u.test(value.parentRunId),
    "parent run ID",
  );
  requireValue(
    Number.isSafeInteger(value.parentRunAttempt) && value.parentRunAttempt > 0,
    "parent attempt",
  );
  requireValue(
    Array.isArray(value.waivers) && value.waivers.length > 0 && value.waivers.length <= 64,
    "nonempty bounded waiver roster",
  );
  const identities = new Set();
  for (const row of value.waivers) {
    exactKeys(
      row,
      ["childRole", "childRunId", "childRunAttempt", "jobName", "suiteId", "reason", "approvedBy"],
      "lane",
    );
    requireValue(
      typeof row.childRunId === "string" && /^[1-9][0-9]*$/u.test(row.childRunId),
      "child run ID",
    );
    requireValue(
      Number.isSafeInteger(row.childRunAttempt) && row.childRunAttempt > 0,
      "child attempt",
    );
    requireValue(text(row.jobName, 512) && text(row.suiteId, 128), "exact job name and suite ID");
    requireValue(text(row.reason, 2048), "reason");
    requireValue(
      typeof row.approvedBy === "string" &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(row.approvedBy),
      "approving maintainer login",
    );
    const role = RELEASE_CHECK_ROLES.has(row.childRole) ? "releaseChecks" : row.childRole;
    const allowed =
      typeof row.childRole === "string" && Object.hasOwn(lanes, role)
        ? lanes[role][row.suiteId]
        : undefined;
    requireValue(
      Array.isArray(allowed) ? allowed.includes(row.jobName) : allowed === row.jobName,
      `lane is not allowlisted: ${row.childRole} / ${row.jobName} (${row.suiteId})`,
    );
    const identity = `${row.childRole}\0${row.childRunId}\0${row.jobName}`;
    requireValue(!identities.has(identity), "duplicate lane");
    identities.add(identity);
  }
  return value;
}

export function validateReleaseWaiverApproverAuthority(login, permission) {
  requireValue(
    ["admin", "maintain", "write"].includes(permission.permission) &&
      permission.user?.login === login,
    "approving maintainer must retain current repository write authority",
  );
}

// Frozen release branches and their retained artifacts bind these empty fields
// into existing digests. Never reinterpret a legacy skip as a failed-lane waiver.
// Remove after the last pre-cutover release line and retained recovery window retire.
export function validateLegacyReleaseTelegramWaiver(record) {
  for (const source of [
    record,
    record?.validationInputs,
    record?.coverage,
    record?.sourceAdmission?.coverage,
    record?.qualificationInputs,
  ]) {
    for (const key of ["telegram_waiver", "telegramWaiver"]) {
      if (source?.[key] !== undefined && source[key] !== "") {
        throw new Error(
          "Non-empty legacy telegram_waiver/telegramWaiver cannot authorize omitted coverage. Use validation_waivers_json (--validation-waivers-json) for exact failed jobs from an already-run FRV; missing or skipped lanes cannot be waived.",
        );
      }
    }
  }
}

export function validateReleaseWaiverBinding(
  declaration,
  { targetSha, targetVersion, runId, runAttempt },
) {
  requireValue(
    declaration.candidateSha === targetSha &&
      declaration.targetVersion === targetVersion &&
      declaration.parentRunId === String(runId) &&
      declaration.parentRunAttempt === Number(runAttempt),
    "candidate SHA/version or parent run/attempt mismatch",
  );
}

export function releaseChildWaivers(declaration, role, runId, runAttempt) {
  const selected = declaration.waivers.filter((row) => row.childRole === role);
  requireValue(
    selected.every((row) => row.childRunId === String(runId) && row.childRunAttempt === runAttempt),
    "child run/attempt mismatch",
  );
  return selected;
}

export function validateReleaseWaivedJobs(jobs, waivers) {
  for (const waiver of waivers) {
    const matches = jobs.filter((job) => job.name === waiver.jobName);
    requireValue(matches.length === 1, `waived job missing or duplicated: ${waiver.jobName}`);
    requireValue(
      matches[0].status === "completed" && matches[0].conclusion === "failure",
      `waived job must be failed, not cancelled/missing/skipped: ${waiver.jobName}`,
    );
    // The declaration pins the current composite, not a rerun of every leaf.
    // P authenticates any carried execution and preserves its original attempt.
    requireValue(
      Number.isSafeInteger(matches[0].acceptedRunAttempt) &&
        matches[0].acceptedRunAttempt > 0 &&
        matches[0].acceptedRunAttempt <= waiver.childRunAttempt,
      `waived job attempt mismatch: ${waiver.jobName}`,
    );
  }
}

function markdown(value) {
  return String(value)
    .replace(/[\\`*_[\]<>|]/gu, "\\$&")
    .replace(/[\r\n]+/gu, " ");
}

export function formatReleaseValidationWaivers(value) {
  const declaration = parseReleaseValidationWaivers(value);
  if (!declaration) {
    return "";
  }
  return [
    "### Release validation waivers",
    "",
    `Candidate ${declaration.targetVersion} (${declaration.candidateSha}); FRV ${declaration.parentRunId}, attempt ${declaration.parentRunAttempt}.`,
    "",
    ...declaration.waivers.map(
      (row) =>
        `- **waived — not a pass**: ${markdown(row.childRole)} / ${markdown(row.jobName)} (${markdown(row.suiteId)}); run ${row.childRunId}, attempt ${row.childRunAttempt}. Reason: ${markdown(row.reason)}. Approver: @${row.approvedBy}.`,
    ),
  ].join("\n");
}
