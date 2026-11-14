// Shared helpers for running Vitest JSON reports and reading duration data.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";

const normalizeRepoPath = (value: string) => value.split(path.sep).join("/");
const identity = (value: string) => value;
const repoRoot = path.resolve(process.cwd());

/**
 * Normalizes absolute or relative file names to repo-relative POSIX paths.
 */
export function normalizeTrackedRepoPath(value: unknown) {
  const normalizedValue = typeof value === "string" ? value : "";
  const repoRelative = path.isAbsolute(normalizedValue)
    ? path.relative(repoRoot, path.resolve(normalizedValue))
    : normalizedValue;
  if (path.isAbsolute(repoRelative) || repoRelative.startsWith("..") || repoRelative === "") {
    return normalizeRepoPath(normalizedValue);
  }
  return normalizeRepoPath(repoRelative);
}

/**
 * Reads and parses a JSON file.
 */
export function readJsonFile(filePath: fs.PathOrFileDescriptor) {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed;
}

// Consumers use this admitted parse; rereading would validate one document and
// consume another if the report changes between reads.
export function readVitestJsonReport(
  reportPath: fs.PathLike,
): Result<Record<string, unknown>, string> {
  const displayPath = typeof reportPath === "string" ? reportPath : reportPath.toString();
  if (!fs.existsSync(reportPath)) {
    return err(`missing Vitest JSON report: ${displayPath}`);
  }
  try {
    const report = readJsonFile(reportPath);
    if (!isRecord(report)) {
      return err(`invalid Vitest JSON report: ${displayPath} (report must be an object)`);
    }
    if (!Array.isArray(report.testResults)) {
      return err(`invalid Vitest JSON report: ${displayPath} (missing testResults array)`);
    }
    return ok(report);
  } catch (error) {
    return err(
      `invalid Vitest JSON report: ${displayPath} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

function defaultVitestJsonReportPath(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${randomUUID()}.json`);
}

/**
 * Runs Vitest with the JSON reporter unless an existing report was supplied.
 */
export function runVitestJsonReport({
  config,
  reportPath = "",
  prefix = "openclaw-vitest-report",
}: {
  config: string;
  reportPath?: string;
  prefix?: string;
}) {
  const resolvedReportPath = reportPath || defaultVitestJsonReportPath(prefix);

  if (!(reportPath && fs.existsSync(resolvedReportPath))) {
    const run = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "run-vitest.mjs"),
        "run",
        "--config",
        config,
        "--reporter=json",
        "--outputFile",
        resolvedReportPath,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    if (run.status !== 0) {
      process.exit(run.status ?? 1);
    }
  }

  const report = readVitestJsonReport(resolvedReportPath);
  if (!report.ok) {
    console.error(`[test-report-utils] ${report.error}`);
    process.exit(1);
  }

  return report.value;
}

/**
 * Extracts per-file durations from a Vitest JSON report.
 */
export function collectVitestFileDurations(report: unknown, normalizeFile = identity) {
  return readTestResults(report)
    .map((result) => {
      const file = typeof result.name === "string" ? normalizeFile(result.name) : "";
      const start = typeof result.startTime === "number" ? result.startTime : 0;
      const end = typeof result.endTime === "number" ? result.endTime : 0;
      const testCount = Array.isArray(result.assertionResults) ? result.assertionResults.length : 0;
      return {
        file,
        durationMs: Math.max(0, end - start),
        testCount,
      };
    })
    .filter((entry) => entry.file.length > 0 && entry.durationMs > 0);
}

/**
 * Extracts per-assertion durations from a Vitest JSON report.
 */
export function collectVitestAssertionDurations(report: unknown, normalizeFile = identity) {
  return readTestResults(report).flatMap((result) => {
    const file = typeof result.name === "string" ? normalizeFile(result.name) : "";
    if (!file) {
      return [];
    }
    const assertions = Array.isArray(result.assertionResults)
      ? result.assertionResults.filter(isRecord)
      : [];
    return assertions
      .map((assertion) => {
        const durationMs =
          typeof assertion?.duration === "number" && Number.isFinite(assertion.duration)
            ? assertion.duration
            : 0;
        return {
          file,
          durationMs,
          fullName: typeof assertion?.fullName === "string" ? assertion.fullName : "",
          status: typeof assertion?.status === "string" ? assertion.status : "unknown",
        };
      })
      .filter((entry) => entry.durationMs > 0);
  });
}

function readTestResults(report: unknown) {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    return [];
  }
  return report.testResults.filter(isRecord);
}
