import { stripVTControlCharacters } from "node:util";

/** @typedef {{kind: "tsgo" | "oxlint", file: string, test: string}} StaticSignature */

/** @param {unknown} file */
export function isStaticEvidencePath(file) {
  return (
    typeof file === "string" &&
    /^(?:src|test|extensions|packages|ui)\/[\w./-]+\.[cm]?[jt]sx?$/u.test(file) &&
    !file.split("/").some((part) => part === "." || part === ".." || part === "")
  );
}

/** @returns {StaticSignature[] | null} */
function tsgoDiagnostics(output) {
  /** @type {StaticSignature[]} */
  const signatures = [];
  /** @type {StaticSignature | undefined} */
  let current;
  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = /^(.*)\(([1-9]\d*),([1-9]\d*)\): error (TS[1-9]\d*): (.+)$/u.exec(line);
    if (match) {
      if (!isStaticEvidencePath(match[1])) {
        return null;
      }
      current = {
        kind: "tsgo",
        file: match[1],
        test: `(${match[2]},${match[3]}) ${match[4]}: ${match[5]}`,
      };
      signatures.push(current);
    } else if (current && /^\s+\S/u.test(line)) {
      current.test += `\n${line}`;
    } else {
      return null;
    }
  }
  return signatures;
}

/** @returns {StaticSignature[] | null} */
function oxlintDiagnostics(output) {
  if (output.trimStart().startsWith("{")) {
    return oxlintJsonDiagnostics(output);
  }
  /** @type {StaticSignature[]} */
  const signatures = [];
  const counts = { warning: 0, error: 0 };
  /** @type {StaticSignature | undefined} */
  let current;
  let summaries = 0;
  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const total = /^Found (\d+) warnings? and (\d+) errors?\.$/u.exec(line);
    if (total) {
      if (Number(total[1]) !== counts.warning || Number(total[2]) !== counts.error) {
        return null;
      }
      summaries++;
      counts.warning = 0;
      counts.error = 0;
      current = undefined;
      continue;
    }
    const match = /^(.*):([1-9]\d*):(\d+): (warning|error): (.+) \(([^\n]+)\)$/u.exec(line);
    if (match) {
      if (!isStaticEvidencePath(match[1])) {
        return null;
      }
      current = {
        kind: "oxlint",
        file: match[1],
        test: `(${match[2]},${match[3]}) ${match[4]} ${match[6]}: ${match[5]}`,
      };
      counts[match[4]]++;
      if (match[4] === "error") {
        signatures.push(current);
      }
    } else if (current && /^ {2}\S/u.test(line)) {
      current.test += `\n${line}`;
    } else {
      return null;
    }
  }
  return summaries > 0 && counts.warning === 0 && counts.error === 0 ? signatures : null;
}

/** @returns {StaticSignature[] | null} */
function oxlintJsonDiagnostics(output) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.diagnostics)) {
    return null;
  }
  /** @type {StaticSignature[]} */
  const signatures = [];
  const counts = { warning: 0, error: 0 };
  for (const diagnostic of report.diagnostics) {
    const position = diagnostic?.labels?.[0]?.span;
    if (
      !isStaticEvidencePath(diagnostic?.filename) ||
      !["warning", "error"].includes(diagnostic.severity) ||
      typeof diagnostic.message !== "string" ||
      diagnostic.message.trim() === "" ||
      (diagnostic.code !== undefined && typeof diagnostic.code !== "string") ||
      (diagnostic.help !== undefined &&
        diagnostic.help !== null &&
        typeof diagnostic.help !== "string") ||
      (diagnostic.causes !== undefined &&
        (!Array.isArray(diagnostic.causes) || diagnostic.causes.length !== 0)) ||
      (diagnostic.related !== undefined &&
        (!Array.isArray(diagnostic.related) || diagnostic.related.length !== 0)) ||
      !Number.isSafeInteger(position?.line) ||
      position.line < 1 ||
      !Number.isSafeInteger(position?.column) ||
      position.column < 0
    ) {
      return null;
    }
    counts[diagnostic.severity]++;
    if (diagnostic.severity !== "error") {
      continue;
    }
    signatures.push({
      kind: "oxlint",
      file: diagnostic.filename,
      test:
        `(${position.line},${position.column}) ${diagnostic.severity} ${diagnostic.code ?? "oxlint"}: ${diagnostic.message}` +
        (diagnostic.help ? `\n  ${diagnostic.help}` : ""),
    });
  }
  for (const severity of ["warning", "error"]) {
    const total = report[`number_of_${severity}s`];
    if (total !== undefined && total !== counts[severity]) {
      return null;
    }
  }
  return signatures;
}

/**
 * Parses complete native diagnostic output, without runner telemetry.
 * @param {string} output
 * @param {"tsgo" | "oxlint"} kind
 * @returns {StaticSignature[] | null}
 */
export function parseStaticDiagnostics(output, kind) {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024) {
    return null;
  }
  const text = stripVTControlCharacters(output).replaceAll("\r\n", "\n");
  if (kind === "tsgo") {
    return tsgoDiagnostics(text);
  }
  return kind === "oxlint" ? oxlintDiagnostics(text) : null;
}

function logLines(log) {
  return stripVTControlCharacters(log)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/u, ""));
}

function completeReport(lines, kind) {
  const leaves = new Map();
  const groups = new Map();
  let step;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("[ci-static:")) {
      continue;
    }
    const frame = /^\[ci-static:(tsgo|oxlint):(leaf|completion|step)\] (.+)$/u.exec(line);
    if (!frame || frame[1] !== kind) {
      return [];
    }
    let value;
    try {
      value = JSON.parse(frame[3]);
    } catch {
      return [];
    }
    if (value?.version !== 1 || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const keys = {
      leaf: ["version", "id", "config", "exitCode", "stdout", "stderr"],
      completion: ["version", "id", "planned", "completed", "leaves"],
      step: ["version", "groups"],
    }[frame[2]];
    if (Object.keys(value).some((key) => !keys.includes(key))) {
      return [];
    }
    if (frame[2] === "step") {
      if (step || !Number.isSafeInteger(value.groups) || value.groups < 1 || value.groups > 800) {
        return [];
      }
      step = { ...value, index };
      continue;
    }
    if (typeof value.id !== "string" || !/^[\w:-]{1,160}$/u.test(value.id)) {
      return [];
    }
    const entries = frame[2] === "leaf" ? leaves : groups;
    if (entries.has(value.id)) {
      return [];
    }
    entries.set(value.id, { ...value, index });
  }
  if (!step || groups.size !== step.groups || leaves.size === 0) {
    return [];
  }
  const terminals = lines.flatMap((line, index) => {
    const match = /^##\[error\]Process completed with exit code (\d+)\.$/u.exec(line);
    return match ? [{ code: Number(match[1]), index }] : [];
  });
  if (
    terminals.length !== 1 ||
    ![1, 2].includes(terminals[0].code) ||
    terminals[0].index <= step.index ||
    lines.slice(step.index + 1, terminals[0].index).some((line) => line.trim() !== "")
  ) {
    return [];
  }
  const covered = new Set();
  for (const group of groups.values()) {
    if (
      !Number.isSafeInteger(group.planned) ||
      group.planned < 0 ||
      group.planned > 800 ||
      group.completed !== group.planned ||
      !Array.isArray(group.leaves) ||
      group.leaves.length !== group.planned ||
      group.index >= step.index
    ) {
      return [];
    }
    for (const id of group.leaves) {
      const leaf = leaves.get(id);
      if (
        typeof id !== "string" ||
        !id.startsWith(`${group.id}:`) ||
        !leaf ||
        leaf.index >= group.index ||
        covered.has(id)
      ) {
        return [];
      }
      covered.add(id);
    }
  }
  if (covered.size !== leaves.size) {
    return [];
  }
  const signatures = [];
  for (const leaf of leaves.values()) {
    if (
      typeof leaf.config !== "string" ||
      !/^[\w./-]+\.json$/u.test(leaf.config) ||
      leaf.config.split("/").some((part) => part === "." || part === ".." || part === "") ||
      ![0, kind === "tsgo" ? 2 : 1].includes(leaf.exitCode) ||
      typeof leaf.stdout !== "string" ||
      typeof leaf.stderr !== "string" ||
      leaf.stderr.trim() !== ""
    ) {
      return [];
    }
    const parsed = parseStaticDiagnostics(leaf.stdout, kind);
    if (
      !parsed ||
      (leaf.exitCode === 0 && parsed.length !== 0) ||
      (leaf.exitCode !== 0 && parsed.length === 0)
    ) {
      return [];
    }
    signatures.push(...parsed);
  }
  const start = lines.lastIndexOf(
    "##[endgroup]",
    Math.min(...[...leaves.values()].map((leaf) => leaf.index)),
  );
  if (start < 0 || [...leaves.values(), ...groups.values()].some((entry) => entry.index <= start)) {
    return [];
  }
  const diagnostics = new Map();
  for (const leaf of leaves.values()) {
    for (const line of stripVTControlCharacters(leaf.stdout).replaceAll("\r\n", "\n").split("\n")) {
      diagnostics.set(line, (diagnostics.get(line) ?? 0) + 1);
    }
  }
  for (const line of lines.slice(start + 1, step.index)) {
    if (line.startsWith(`[ci-static:${kind}:`) || isRunnerTelemetry(line, kind)) {
      continue;
    }
    const remaining = diagnostics.get(line) ?? 0;
    if (remaining === 0) {
      return [];
    }
    diagnostics.set(line, remaining - 1);
  }
  return signatures;
}

function isRunnerTelemetry(line, kind) {
  return (
    line.trim() === "" ||
    (kind === "tsgo" &&
      /^\[tsgo(?::[\w:.-]+)?\] (?:passed in \d+(?:\.\d+)?s|failed \(exit 2\) in \d+(?:\.\d+)?s|FAILED \(exit 2\))$/u.test(
        line,
      )) ||
    (kind === "oxlint" &&
      /^(?:\[oxlint\] shard concurrency \d+ \(cpus=\d+, memGB=\d+\)|\[oxlint(?::[\w:./-]+)?\] (?:starting|still running after \d+s|passed|failed \(exit 1\)|FAILED \(exit 1\)))$/u.test(
        line,
      )) ||
    /^> openclaw@[\w.+-]+ (?:tsgo(?::[\w:-]+)?|lint(?::[\w:-]+)?) \S+$/u.test(line) ||
    /^> node (?:--import (?:tsx|\.\/scripts\/tsx\.mjs) )?scripts\/run-(?:tsgo|oxlint)[\w.-]*\.[cm]?[jt]s\b[^\r\n]*$/u.test(
      line,
    ) ||
    /^\s*ELIFECYCLE\s+Command failed with exit code [12]\.$/u.test(line)
  );
}

function legacyReport(lines, kind) {
  const endings = lines.flatMap((line, index) => {
    const match = /^##\[error\]Process completed with exit code (\d+)\.$/u.exec(line);
    return match ? [{ index, code: Number(match[1]) }] : [];
  });
  if (endings.length !== 1 || endings[0].code !== (kind === "tsgo" ? 2 : 1)) {
    return [];
  }
  const end = endings[0].index;
  const start = lines.lastIndexOf("##[endgroup]", end);
  if (start < 0) {
    return [];
  }
  const output = [];
  for (const line of lines.slice(start + 1, end)) {
    if (isRunnerTelemetry(line, kind)) {
      continue;
    }
    output.push(line);
  }
  return parseStaticDiagnostics(output.join("\n"), kind) ?? [];
}

/**
 * Legacy evidence authorizes a fresh CI run, never a gate exemption.
 * @param {string} log
 * @param {"tsgo" | "oxlint"} kind
 * @param {boolean} [requireComplete]
 * @returns {StaticSignature[]}
 */
export function parseStaticFailureReport(log, kind, requireComplete = false) {
  if (typeof log !== "string" || log.length > 16 * 1024 * 1024) {
    return [];
  }
  const lines = logLines(log);
  if (kind !== "tsgo" && kind !== "oxlint") {
    return [];
  }
  if (requireComplete || lines.some((line) => line.startsWith("[ci-static:"))) {
    return completeReport(lines, kind);
  }
  return legacyReport(lines, kind);
}
