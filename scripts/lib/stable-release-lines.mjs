import { createHash } from "node:crypto";

const MONTH_PATTERN = /^([1-9]\d{3,})\.(1[0-2]|[1-9])$/u;
const VERSION_PATTERN = /^([1-9]\d{3,})\.(1[0-2]|[1-9])\.([1-9]\d*)$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LINE_STATUSES = new Set(["planned", "active", "retired"]);
const OPERATIONS = new Set([
  "plan",
  "record-published",
  "activate",
  "patch",
  "rollback-version",
  "rollback-unset",
]);
const ROOT_KEYS = ["version", "lines", "lastTransition"];
const LINE_KEYS = [
  "month",
  "baseVersion",
  "branch",
  "status",
  "publishedVersions",
  "publicationEvidence",
  "currentVersion",
  "supportStartedOn",
  "targetRotationOn",
  "retiredOn",
  "rollbackTarget",
];
const PUBLICATION_EVIDENCE_KEYS = ["version", "evidenceRef", "evidenceSha256"];
const LAST_TRANSITION_KEYS = [
  "operation",
  "fromVersion",
  "toVersion",
  "publishedVersion",
  "proofRef",
  "proofSha256",
  "effectiveDate",
];

export class StableReleaseLinesError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = "StableReleaseLinesError";
    this.code = code;
  }
}

function reject(reason, code = "stable-lines-invalid") {
  throw new StableReleaseLinesError(code, reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    reject(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.includes(key)) {
      reject(`${label} has unknown field: ${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      reject(`${label} is missing field: ${key}`);
    }
  }
}

export function parseStableMonth(value, label = "month", code = "stable-lines-invalid") {
  if (typeof value !== "string") {
    reject(`${label} must be YYYY.M`, code);
  }
  const match = MONTH_PATTERN.exec(value);
  if (!match) {
    reject(`${label} must be YYYY.M`, code);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isSafeInteger(year) || year <= 0) {
    reject(`${label} year must be a positive safe integer`, code);
  }
  const ordinal = BigInt(year) * 12n + BigInt(month) - 1n;
  return { value, year, month, ordinal };
}

export function parseStableVersion(value, label = "version", code = "stable-lines-invalid") {
  if (typeof value !== "string") {
    reject(`${label} must be YYYY.M.PATCH`, code);
  }
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    reject(`${label} must be YYYY.M.PATCH`, code);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = Number(match[3]);
  if (![year, month, patch].every((part) => Number.isSafeInteger(part) && part > 0)) {
    reject(`${label} components must be positive safe integers`, code);
  }
  return { value, year, month, patch, monthValue: `${year}.${month}` };
}

export function validateIsoDate(value, label = "date", code = "stable-lines-invalid") {
  if (typeof value !== "string") {
    reject(`${label} must be YYYY-MM-DD`, code);
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    reject(`${label} must be YYYY-MM-DD`, code);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    reject(`${label} must be a real ISO date`, code);
  }
  return value;
}

function requireNullableDate(value, label) {
  if (value === null) {
    return;
  }
  validateIsoDate(value, label);
}

function requireSha256(value, label, code = "stable-lines-invalid") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(`${label} must be 64 lowercase hexadecimal characters`, code);
  }
}

function requireReference(value, label, code = "stable-lines-invalid") {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    reject(`${label} must be a non-empty immutable reference`, code);
  }
}

function monthFromOrdinal(ordinal) {
  const year = ordinal / 12n;
  const month = (ordinal % 12n) + 1n;
  return `${year}.${month}`;
}

export function precedingStableMonth(dailyMonth) {
  const parsed = parseStableMonth(dailyMonth, "dailyMonth");
  return monthFromOrdinal(parsed.ordinal - 1n);
}

function validatePublicationEvidence(value, expectedVersion, label) {
  const record = requireRecord(value, label);
  requireExactKeys(record, PUBLICATION_EVIDENCE_KEYS, label);
  if (record.version !== expectedVersion) {
    reject(`${label}.version must equal the aligned published version`);
  }
  requireReference(record.evidenceRef, `${label}.evidenceRef`);
  if (typeof record.evidenceSha256 !== "string" || !SHA256_PATTERN.test(record.evidenceSha256)) {
    reject(`${label}.evidenceSha256 must be 64 lowercase hexadecimal characters`);
  }
}

function validateRollbackTarget(value, label) {
  const record = requireRecord(value, label);
  if (record.kind === "selector-unset") {
    requireExactKeys(record, ["kind"], label);
    return;
  }
  if (record.kind === "version") {
    requireExactKeys(record, ["kind", "version"], label);
    parseStableVersion(record.version, `${label}.version`);
    return;
  }
  reject(`${label}.kind must be selector-unset or version`);
}

function validateLine(value, index) {
  const label = `lines[${index}]`;
  const line = requireRecord(value, label);
  requireExactKeys(line, LINE_KEYS, label);
  const month = parseStableMonth(line.month, `${label}.month`);
  const base = parseStableVersion(line.baseVersion, `${label}.baseVersion`);
  if (base.monthValue !== month.value || base.patch !== 33) {
    reject(`${label}.baseVersion must be exactly ${line.month}.33`);
  }
  if (line.branch !== `stable/${line.baseVersion}`) {
    reject(`${label}.branch must be exactly stable/${line.baseVersion}`);
  }
  if (!LINE_STATUSES.has(line.status)) {
    reject(`${label}.status must be planned, active, or retired`);
  }
  if (!Array.isArray(line.publishedVersions)) {
    reject(`${label}.publishedVersions must be an array`);
  }
  if (!Array.isArray(line.publicationEvidence)) {
    reject(`${label}.publicationEvidence must be an array`);
  }
  if (line.publishedVersions.length !== line.publicationEvidence.length) {
    reject(`${label}.publicationEvidence must align with publishedVersions`);
  }
  for (let historyIndex = 0; historyIndex < line.publishedVersions.length; historyIndex += 1) {
    const version = line.publishedVersions[historyIndex];
    const parsed = parseStableVersion(version, `${label}.publishedVersions[${historyIndex}]`);
    if (parsed.monthValue !== line.month) {
      reject(`${label}.publishedVersions must remain in ${line.month}`);
    }
    if (parsed.patch !== 33 + historyIndex) {
      if (historyIndex === 0) {
        reject("publishedVersions must start at baseVersion");
      }
      reject(`${label}.publishedVersions must be contiguous from baseVersion`);
    }
    validatePublicationEvidence(
      line.publicationEvidence[historyIndex],
      version,
      `${label}.publicationEvidence[${historyIndex}]`,
    );
  }
  if (line.currentVersion !== null) {
    parseStableVersion(line.currentVersion, `${label}.currentVersion`);
    if (!line.publishedVersions.includes(line.currentVersion)) {
      reject(`${label}.currentVersion must be retained in publishedVersions`);
    }
  }
  requireNullableDate(line.supportStartedOn, `${label}.supportStartedOn`);
  validateIsoDate(line.targetRotationOn, `${label}.targetRotationOn`);
  requireNullableDate(line.retiredOn, `${label}.retiredOn`);
  validateRollbackTarget(line.rollbackTarget, `${label}.rollbackTarget`);

  if (line.status === "planned") {
    if (line.currentVersion !== null || line.supportStartedOn !== null || line.retiredOn !== null) {
      reject(`${label} planned line must have null current, support, and retirement fields`);
    }
  } else if (line.currentVersion === null || line.supportStartedOn === null) {
    reject(`${label} ${line.status} line must have a current version and support start`);
  }
  if ((line.status === "retired") !== (line.retiredOn !== null)) {
    reject(`${label}.retiredOn must be non-null exactly for retired lines`);
  }
  if (line.retiredOn !== null && line.retiredOn < line.supportStartedOn) {
    reject(`${label}.retiredOn cannot precede supportStartedOn`);
  }
  if (line.supportStartedOn !== null && line.targetRotationOn < line.supportStartedOn) {
    reject(`${label}.targetRotationOn cannot precede supportStartedOn`);
  }
  return { line, month };
}

function validateLastTransition(value) {
  const transition = requireRecord(value, "lastTransition");
  requireExactKeys(transition, LAST_TRANSITION_KEYS, "lastTransition");
  if (!OPERATIONS.has(transition.operation)) {
    reject("lastTransition.operation is invalid");
  }
  for (const key of ["fromVersion", "toVersion", "publishedVersion"]) {
    if (transition[key] !== null) {
      parseStableVersion(transition[key], `lastTransition.${key}`);
    }
  }
  validateIsoDate(transition.effectiveDate, "lastTransition.effectiveDate");
  if (transition.operation === "plan") {
    if (
      transition.publishedVersion !== null ||
      transition.proofRef !== null ||
      transition.proofSha256 !== null
    ) {
      reject("plan transition must not contain publication or proof fields");
    }
    if (transition.fromVersion !== transition.toVersion) {
      reject("plan transition must not change selection");
    }
    return;
  }
  requireReference(transition.proofRef, "lastTransition.proofRef");
  if (typeof transition.proofSha256 !== "string" || !SHA256_PATTERN.test(transition.proofSha256)) {
    reject("lastTransition.proofSha256 must be 64 lowercase hexadecimal characters");
  }
  if (transition.operation === "record-published") {
    if (transition.publishedVersion === null || transition.fromVersion !== transition.toVersion) {
      reject("record-published must record one version without changing selection");
    }
  } else if (transition.publishedVersion !== null) {
    reject(`${transition.operation} must not set publishedVersion`);
  }
  if (transition.operation === "rollback-unset") {
    if (transition.fromVersion === null || transition.toVersion !== null) {
      reject("rollback-unset must move one selected version to null");
    }
  } else if (transition.operation !== "record-published" && transition.toVersion === null) {
    reject(`${transition.operation} must select a version`);
  }
}

function validateLastTransitionAgainstLines(metadata) {
  const transition = metadata.lastTransition;
  const active = metadata.lines.find((line) => line.status === "active") ?? null;
  const current = active?.currentVersion ?? null;
  if (transition.operation === "plan") {
    if (transition.fromVersion !== current || transition.toVersion !== current) {
      reject("plan transition selection must equal the current active selection");
    }
    return;
  }
  if (transition.operation === "record-published") {
    const line = metadata.lines.find((item) =>
      item.publishedVersions.includes(transition.publishedVersion),
    );
    if (line === undefined) {
      reject("record-published transition version must be retained in publication history");
    }
    const index = line.publishedVersions.indexOf(transition.publishedVersion);
    const evidence = line.publicationEvidence[index];
    if (
      evidence.evidenceRef !== transition.proofRef ||
      evidence.evidenceSha256 !== transition.proofSha256 ||
      transition.fromVersion !== current ||
      transition.toVersion !== current
    ) {
      reject("record-published transition must match its publication evidence and selection");
    }
    return;
  }
  if (transition.operation === "rollback-unset") {
    if (active !== null || !metadata.lines.some((line) => line.status === "planned")) {
      reject("rollback-unset transition must leave the genesis line planned and unselected");
    }
    return;
  }
  if (current !== transition.toVersion) {
    reject(`${transition.operation} transition target must equal the active selection`);
  }
  const target = active.rollbackTarget;
  if (transition.fromVersion === null) {
    if (target.kind !== "selector-unset") {
      reject(`${transition.operation} bootstrap target must retain selector-unset rollback`);
    }
  } else if (target.kind !== "version" || target.version !== transition.fromVersion) {
    reject(`${transition.operation} rollback target must equal its displaced selection`);
  }
}

function deriveFromValidated(metadata, dailyMonth) {
  const daily = parseStableMonth(dailyMonth, "dailyMonth");
  const previous = monthFromOrdinal(daily.ordinal - 1n);
  const twoMonthsBack = monthFromOrdinal(daily.ordinal - 2n);
  const active = metadata.lines.find((line) => line.status === "active") ?? null;
  const planned = metadata.lines.find((line) => line.status === "planned") ?? null;
  const retired = metadata.lines.filter((line) => line.status === "retired");

  if (
    active === null &&
    planned?.month === previous &&
    retired.length === 0 &&
    metadata.lines.length === 1
  ) {
    return "bootstrap";
  }
  if (active?.month === previous && planned === null) {
    return "steady";
  }
  if (active?.month === twoMonthsBack && planned?.month === previous) {
    return "staging";
  }
  if (
    active !== null &&
    parseStableMonth(active.month).ordinal < daily.ordinal - 1n &&
    planned === null &&
    retired.some((line) => line.month === previous)
  ) {
    return "cross-line-rollback";
  }
  return reject("active and planned lines do not form a valid live state");
}

export function validateStableReleaseLines(value, options = {}) {
  const metadata = requireRecord(value, "stable lines");
  requireExactKeys(metadata, ROOT_KEYS, "stable lines");
  if (metadata.version !== 1) {
    reject("stable lines version must be exactly 1");
  }
  if (!Array.isArray(metadata.lines) || metadata.lines.length === 0) {
    reject("stable lines lines must be a non-empty array");
  }

  const seenMonths = new Set();
  const seenBases = new Set();
  const seenBranches = new Set();
  const allPublishedVersions = new Set();
  let previousMonth = null;
  let activeCount = 0;
  let plannedCount = 0;
  for (let index = 0; index < metadata.lines.length; index += 1) {
    const { line, month } = validateLine(metadata.lines[index], index);
    if (previousMonth !== null && month.ordinal <= previousMonth) {
      reject("lines must be ordered by ascending month without duplicates");
    }
    previousMonth = month.ordinal;
    for (const [set, key, label] of [
      [seenMonths, line.month, "month"],
      [seenBases, line.baseVersion, "baseVersion"],
      [seenBranches, line.branch, "branch"],
    ]) {
      if (set.has(key)) {
        reject(`lines must not duplicate ${label}: ${key}`);
      }
      set.add(key);
    }
    for (const version of line.publishedVersions) {
      if (allPublishedVersions.has(version)) {
        reject(`published version is duplicated: ${version}`);
      }
      allPublishedVersions.add(version);
    }
    activeCount += line.status === "active" ? 1 : 0;
    plannedCount += line.status === "planned" ? 1 : 0;
  }
  if (activeCount > 1 || plannedCount > 1) {
    reject("stable lines may contain at most one active and one planned line");
  }
  for (let index = 0; index < metadata.lines.length; index += 1) {
    const target = metadata.lines[index].rollbackTarget;
    if (target.kind === "version" && !allPublishedVersions.has(target.version)) {
      reject(`lines[${index}].rollbackTarget.version must be retained in publication history`);
    }
  }
  validateLastTransition(metadata.lastTransition);
  validateLastTransitionAgainstLines(metadata);
  if (options.dailyMonth !== undefined) {
    deriveFromValidated(metadata, options.dailyMonth);
  }
  return metadata;
}

export function deriveStableReleaseLinesState(metadata, dailyMonth) {
  validateStableReleaseLines(metadata);
  return deriveFromValidated(metadata, dailyMonth);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeCanonicalJson(value) {
  return `${canonicalJson(value)}\n`;
}

export function serializeStableReleaseLines(metadata) {
  validateStableReleaseLines(metadata);
  return serializeCanonicalJson(metadata);
}

export function stableReleaseLinesSha256(metadata) {
  return createHash("sha256").update(serializeStableReleaseLines(metadata), "utf8").digest("hex");
}

function cloneMetadata(metadata) {
  return structuredClone(metadata);
}

function selectedVersion(metadata) {
  return metadata.lines.find((line) => line.status === "active")?.currentVersion ?? null;
}

function requireEffectiveDate(command, metadata) {
  validateIsoDate(command.effectiveDate, "effective-date", "invalid-arguments");
  if (metadata !== null && command.effectiveDate < metadata.lastTransition.effectiveDate) {
    reject("effective-date cannot precede the prior transition date", "transition-not-allowed");
  }
}

function requireRotationDate(command) {
  validateIsoDate(command.rotationDate, "rotation-date", "invalid-arguments");
  if (command.rotationDate < command.effectiveDate) {
    reject("rotation-date cannot precede effective-date", "transition-not-allowed");
  }
}

function requireHandoff(command) {
  requireReference(command.handoffRef, "handoff-ref", "invalid-arguments");
  requireSha256(command.handoffSha256, "handoff-sha", "invalid-arguments");
}

function requireEvidence(command) {
  requireReference(command.evidenceRef, "evidence-ref", "invalid-arguments");
  requireSha256(command.evidenceSha256, "evidence-sha", "invalid-arguments");
}

function transitionError(reason) {
  reject(reason, "transition-not-allowed");
}

function setLastTransition(metadata, transition) {
  metadata.lastTransition = {
    operation: transition.operation,
    fromVersion: transition.fromVersion,
    toVersion: transition.toVersion,
    publishedVersion: transition.publishedVersion,
    proofRef: transition.proofRef,
    proofSha256: transition.proofSha256,
    effectiveDate: transition.effectiveDate,
  };
}

function applyPlan(metadata, dailyMonth, command) {
  parseStableMonth(command.month, "month", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireRotationDate(command);
  const requiredMonth = precedingStableMonth(dailyMonth);
  if (command.month !== requiredMonth) {
    transitionError(`plan month must be the preceding daily month ${requiredMonth}`);
  }

  let candidate;
  let current = null;
  if (metadata === null) {
    if (dailyMonth !== "2026.7" || command.month !== "2026.6") {
      transitionError("bootstrap without metadata requires dailyMonth 2026.7 and month 2026.6");
    }
    candidate = { version: 1, lines: [], lastTransition: null };
  } else {
    candidate = cloneMetadata(metadata);
    const active = candidate.lines.find((line) => line.status === "active") ?? null;
    if (active === null) {
      transitionError("plan requires bootstrap without metadata or one active stable line");
    }
    const daily = parseStableMonth(dailyMonth, "dailyMonth");
    const priorDailyMonth = monthFromOrdinal(daily.ordinal - 1n);
    if (deriveFromValidated(metadata, priorDailyMonth) !== "steady") {
      transitionError("plan requires steady state from the preceding daily month");
    }
    if (parseStableMonth(active.month).ordinal !== daily.ordinal - 2n) {
      transitionError("plan requires the active line from two months before dailyMonth");
    }
    current = active.currentVersion;
  }
  const baseVersion = `${command.month}.33`;
  candidate.lines.push({
    month: command.month,
    baseVersion,
    branch: `stable/${baseVersion}`,
    status: "planned",
    publishedVersions: [],
    publicationEvidence: [],
    currentVersion: null,
    supportStartedOn: null,
    targetRotationOn: command.rotationDate,
    retiredOn: null,
    rollbackTarget:
      current === null ? { kind: "selector-unset" } : { kind: "version", version: current },
  });
  candidate.lines.sort((left, right) => {
    const leftOrdinal = parseStableMonth(left.month).ordinal;
    const rightOrdinal = parseStableMonth(right.month).ordinal;
    return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
  });
  setLastTransition(candidate, {
    operation: "plan",
    fromVersion: current,
    toVersion: current,
    publishedVersion: null,
    proofRef: null,
    proofSha256: null,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

function applyRecordPublished(metadata, command) {
  const parsedVersion = parseStableVersion(command.version, "version", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireEvidence(command);
  const line = metadata.lines.find((item) => item.month === parsedVersion.monthValue);
  if (line === undefined || (line.status !== "planned" && line.status !== "active")) {
    transitionError("record-published requires the matching planned or active line");
  }
  if (line.status === "planned") {
    if (command.version !== line.baseVersion || line.publishedVersions.length !== 0) {
      transitionError("a planned line records only its unpublished base version");
    }
  } else {
    const nextPatch = 33 + line.publishedVersions.length;
    if (parsedVersion.patch <= 33 || parsedVersion.patch !== nextPatch) {
      transitionError(
        `active line publication must be the next contiguous patch ${line.month}.${nextPatch}`,
      );
    }
  }
  const candidate = cloneMetadata(metadata);
  const candidateLine = candidate.lines.find((item) => item.month === parsedVersion.monthValue);
  candidateLine.publishedVersions.push(command.version);
  candidateLine.publicationEvidence.push({
    version: command.version,
    evidenceRef: command.evidenceRef,
    evidenceSha256: command.evidenceSha256,
  });
  const current = selectedVersion(metadata);
  setLastTransition(candidate, {
    operation: "record-published",
    fromVersion: current,
    toVersion: current,
    publishedVersion: command.version,
    proofRef: command.evidenceRef,
    proofSha256: command.evidenceSha256,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

function applyActivate(metadata, command) {
  parseStableMonth(command.month, "month", "invalid-arguments");
  const version = parseStableVersion(command.version, "version", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireHandoff(command);
  const line = metadata.lines.find((item) => item.month === command.month);
  if (
    line === undefined ||
    line.status !== "planned" ||
    version.monthValue !== command.month ||
    command.version !== line.baseVersion ||
    !line.publishedVersions.includes(command.version)
  ) {
    transitionError("activate requires a recorded planned base version");
  }
  const candidate = cloneMetadata(metadata);
  const oldActive = candidate.lines.find((item) => item.status === "active") ?? null;
  const fromVersion = oldActive?.currentVersion ?? null;
  if (oldActive !== null) {
    oldActive.status = "retired";
    oldActive.retiredOn = command.effectiveDate;
  }
  const activated = candidate.lines.find((item) => item.month === command.month);
  activated.status = "active";
  activated.currentVersion = command.version;
  activated.supportStartedOn = command.effectiveDate;
  activated.retiredOn = null;
  setLastTransition(candidate, {
    operation: "activate",
    fromVersion,
    toVersion: command.version,
    publishedVersion: null,
    proofRef: command.handoffRef,
    proofSha256: command.handoffSha256,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

function applyPatch(metadata, dailyMonth, command) {
  const version = parseStableVersion(command.version, "version", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireHandoff(command);
  if (deriveFromValidated(metadata, dailyMonth) !== "steady") {
    transitionError("patch requires steady state");
  }
  const active = metadata.lines.find((line) => line.status === "active");
  const current = parseStableVersion(active.currentVersion, "currentVersion");
  if (
    version.monthValue !== active.month ||
    version.patch <= 33 ||
    version.patch <= current.patch ||
    !active.publishedVersions.includes(command.version)
  ) {
    transitionError("patch requires a newer recorded patch on the active line");
  }
  const candidate = cloneMetadata(metadata);
  const candidateActive = candidate.lines.find((line) => line.status === "active");
  candidateActive.currentVersion = command.version;
  candidateActive.rollbackTarget = { kind: "version", version: active.currentVersion };
  setLastTransition(candidate, {
    operation: "patch",
    fromVersion: active.currentVersion,
    toVersion: command.version,
    publishedVersion: null,
    proofRef: command.handoffRef,
    proofSha256: command.handoffSha256,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

function applyRollbackVersion(metadata, command) {
  parseStableVersion(command.to, "to", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireHandoff(command);
  const active = metadata.lines.find((line) => line.status === "active");
  const target = metadata.lines.find((line) => line.publishedVersions.includes(command.to));
  if (active === undefined || target === undefined || command.to === active.currentVersion) {
    transitionError("rollback-version requires a different retained published version");
  }
  const candidate = cloneMetadata(metadata);
  const candidateActive = candidate.lines.find((line) => line.status === "active");
  const candidateTarget = candidate.lines.find((line) => line.month === target.month);
  const fromVersion = active.currentVersion;
  if (target.month === active.month) {
    if (command.rotationDate !== undefined) {
      transitionError("same-line rollback forbids rotation-date");
    }
    candidateActive.currentVersion = command.to;
    candidateActive.rollbackTarget = { kind: "version", version: fromVersion };
  } else {
    if (command.rotationDate === undefined) {
      transitionError("cross-line rollback requires rotation-date");
    }
    requireRotationDate(command);
    if (target.status !== "retired") {
      transitionError("cross-line rollback target must be a retired line");
    }
    candidateActive.status = "retired";
    candidateActive.retiredOn = command.effectiveDate;
    candidateTarget.status = "active";
    candidateTarget.currentVersion = command.to;
    candidateTarget.retiredOn = null;
    candidateTarget.targetRotationOn = command.rotationDate;
    candidateTarget.rollbackTarget = { kind: "version", version: fromVersion };
  }
  setLastTransition(candidate, {
    operation: "rollback-version",
    fromVersion,
    toVersion: command.to,
    publishedVersion: null,
    proofRef: command.handoffRef,
    proofSha256: command.handoffSha256,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

function applyRollbackUnset(metadata, command) {
  parseStableMonth(command.month, "month", "invalid-arguments");
  requireEffectiveDate(command, metadata);
  requireRotationDate(command);
  requireHandoff(command);
  if (metadata.lines.length !== 1) {
    transitionError("rollback-unset is allowed only for the sole genesis line");
  }
  const line = metadata.lines[0];
  if (
    line.month !== command.month ||
    line.month !== "2026.6" ||
    line.status !== "active" ||
    line.currentVersion !== line.baseVersion ||
    line.publishedVersions.length !== 1 ||
    line.rollbackTarget.kind !== "selector-unset"
  ) {
    transitionError("rollback-unset requires the initially activated genesis base version");
  }
  const candidate = cloneMetadata(metadata);
  const candidateLine = candidate.lines[0];
  candidateLine.status = "planned";
  candidateLine.currentVersion = null;
  candidateLine.supportStartedOn = null;
  candidateLine.retiredOn = null;
  candidateLine.targetRotationOn = command.rotationDate;
  candidateLine.rollbackTarget = { kind: "selector-unset" };
  setLastTransition(candidate, {
    operation: "rollback-unset",
    fromVersion: line.currentVersion,
    toVersion: null,
    publishedVersion: null,
    proofRef: command.handoffRef,
    proofSha256: command.handoffSha256,
    effectiveDate: command.effectiveDate,
  });
  return candidate;
}

export function applyStableReleaseLinesTransition({ metadata, dailyMonth, command }) {
  const operation = command?.operation;
  if (operation === "plan" && isRecord(metadata) && Array.isArray(metadata.lines)) {
    if (metadata.lines.some((line) => isRecord(line) && line.status === "planned")) {
      reject("a planned stable line already exists", "planned-line-exists");
    }
  }
  parseStableMonth(dailyMonth, "dailyMonth");
  if (!isRecord(command) || !OPERATIONS.has(operation)) {
    reject("operation is invalid", "invalid-arguments");
  }
  const commandKeys = {
    plan: ["operation", "month", "effectiveDate", "rotationDate"],
    "record-published": ["operation", "version", "effectiveDate", "evidenceRef", "evidenceSha256"],
    activate: ["operation", "month", "version", "effectiveDate", "handoffRef", "handoffSha256"],
    patch: ["operation", "version", "effectiveDate", "handoffRef", "handoffSha256"],
    "rollback-version": [
      "operation",
      "to",
      "effectiveDate",
      "handoffRef",
      "handoffSha256",
      ...(command.rotationDate === undefined ? [] : ["rotationDate"]),
    ],
    "rollback-unset": [
      "operation",
      "month",
      "effectiveDate",
      "rotationDate",
      "handoffRef",
      "handoffSha256",
    ],
  }[operation];
  const actualCommandKeys = Object.keys(command);
  const unexpectedCommandKey = actualCommandKeys.find((key) => !commandKeys.includes(key));
  if (unexpectedCommandKey !== undefined) {
    reject(`command has unknown field: ${unexpectedCommandKey}`, "invalid-arguments");
  }
  const missingCommandKey = commandKeys.find((key) => !Object.hasOwn(command, key));
  if (missingCommandKey !== undefined) {
    reject(`command is missing field: ${missingCommandKey}`, "invalid-arguments");
  }
  if (metadata === null && operation !== "plan") {
    reject("release/stable-lines.json is absent", "stable-lines-missing");
  }
  if (metadata !== null) {
    validateStableReleaseLines(metadata);
    if (operation !== "plan") {
      deriveFromValidated(metadata, dailyMonth);
    }
  }

  let candidate;
  switch (operation) {
    case "plan":
      candidate = applyPlan(metadata, dailyMonth, command);
      break;
    case "record-published":
      candidate = applyRecordPublished(metadata, command);
      break;
    case "activate":
      candidate = applyActivate(metadata, command);
      break;
    case "patch":
      candidate = applyPatch(metadata, dailyMonth, command);
      break;
    case "rollback-version":
      candidate = applyRollbackVersion(metadata, command);
      break;
    case "rollback-unset":
      candidate = applyRollbackUnset(metadata, command);
      break;
    default:
      reject("operation is invalid", "invalid-arguments");
  }
  validateStableReleaseLines(candidate, { dailyMonth });
  return candidate;
}

export function buildStableReleaseLinesStatus(metadata, dailyMonth, sourceSha) {
  validateStableReleaseLines(metadata, { dailyMonth });
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    reject("sourceSha must be 40 lowercase hexadecimal characters", "source-unavailable");
  }
  const state = deriveFromValidated(metadata, dailyMonth);
  const active = metadata.lines.find((line) => line.status === "active") ?? null;
  const planned = metadata.lines.find((line) => line.status === "planned") ?? null;
  const retired = metadata.lines.filter((line) => line.status === "retired");
  return {
    schemaVersion: 1,
    state,
    sourceSha,
    stableLinesSha256: stableReleaseLinesSha256(metadata),
    dailyMonth,
    active: active === null ? null : cloneMetadata(active),
    planned: planned === null ? null : cloneMetadata(planned),
    retired: cloneMetadata(retired),
    lastTransition: cloneMetadata(metadata.lastTransition),
  };
}
