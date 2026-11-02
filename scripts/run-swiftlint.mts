import { spawnSync } from "node:child_process";
import path from "node:path";
import { limitsAreAdvisory, reportLimitViolations } from "./lib/check-limits.mts";

const LIMIT_RULES = new Set([
  "cyclomatic_complexity",
  "file_length",
  "function_body_length",
  "function_parameter_count",
  "large_tuple",
  "line_length",
  "nesting",
  "type_body_length",
]);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

type SwiftLintViolation = {
  file: string | null;
  line: number | null;
  character: number | null;
  severity: "Error" | "Warning";
  rule_id: string;
  reason: string;
};

function isLimitViolation(violation: SwiftLintViolation): boolean {
  // Type naming rules also reject invalid characters and lowercase names; those remain blocking.
  return (
    LIMIT_RULES.has(violation.rule_id) ||
    ((violation.rule_id === "type_name" || violation.rule_id === "generic_type_name") &&
      /^(?:Type|Generic type) name '.+' should be between \d+ and \d+ characters long$/u.test(
        violation.reason,
      ))
  );
}

function parseReport(output: string): SwiftLintViolation[] {
  const report: unknown = JSON.parse(output);
  if (!Array.isArray(report)) {
    throw new Error("Expected a SwiftLint JSON array");
  }
  return report.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("file" in entry) ||
      !(entry.file === null || typeof entry.file === "string") ||
      !("line" in entry) ||
      !(entry.line === null || typeof entry.line === "number") ||
      !("character" in entry) ||
      !(entry.character === null || typeof entry.character === "number") ||
      !("severity" in entry) ||
      !(entry.severity === "Error" || entry.severity === "Warning") ||
      !("rule_id" in entry) ||
      typeof entry.rule_id !== "string" ||
      !("reason" in entry) ||
      typeof entry.reason !== "string"
    ) {
      throw new Error("Invalid SwiftLint violation in JSON report");
    }
    return {
      file: entry.file,
      line: entry.line,
      character: entry.character,
      severity: entry.severity,
      rule_id: entry.rule_id,
      reason: entry.reason,
    };
  });
}

function run(): number {
  const args = ["lint", ...process.argv.slice(2)];
  if (!limitsAreAdvisory()) {
    const result = spawnSync("swiftlint", args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  }

  const result = spawnSync("swiftlint", [...args, "--reporter", "json"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  // SwiftLint 0.65.1 reserves exit 2 for reported lint errors. Tool failures stay fatal.
  if (result.status !== 0 && result.status !== 2) {
    process.stdout.write(result.stdout);
    return result.status ?? 1;
  }

  const violations = parseReport(result.stdout);
  const limits = violations.filter(isLimitViolation);
  reportLimitViolations(
    limits.map((violation) => ({
      file: violation.file ? path.relative(REPO_ROOT, violation.file) : "config/swiftlint.yml",
      line: violation.line ?? undefined,
      title: `SwiftLint ${violation.rule_id}`,
      message: violation.reason,
    })),
  );
  const otherViolations = violations.filter((violation) => !isLimitViolation(violation));
  for (const violation of otherViolations) {
    console.error(
      `${violation.file ?? "SwiftLint"}:${violation.line ?? 0}:${violation.character ?? 0}: ${violation.severity.toLowerCase()}: ${violation.reason} (${violation.rule_id})`,
    );
  }
  // --strict upgrades every warning before reporting, including correctness warnings.
  if (otherViolations.some((violation) => violation.severity === "Error")) {
    return 2;
  }
  return limits.length > 0 ? 0 : (result.status ?? 1);
}

try {
  process.exitCode = run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
