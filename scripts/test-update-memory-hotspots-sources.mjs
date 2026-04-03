import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function loadHotspotInputTexts({
  logPaths = [],
  ghJobs = [],
  ghRuns = [],
  ghRunJobMatches = [],
  readFileSyncImpl = fs.readFileSync,
  execFileSyncImpl = execFileSync,
}) {
  const inputs = [];
  for (const logPath of logPaths) {
    inputs.push({
      sourceName: path.basename(logPath, path.extname(logPath)),
      text: readFileSyncImpl(logPath, "utf8"),
    });
  }
  const normalizedRunJobMatches = ghRunJobMatches
    .map((match) => (typeof match === "string" ? match.trim() : String(match ?? "").trim()))
    .filter((match) => match.length > 0)
    .map((match) => match.toLowerCase());
  const shouldIncludeRunJob = (jobName) => {
    if (normalizedRunJobMatches.length === 0) {
      return true;
    }
    if (typeof jobName !== "string") {
      return false;
    }
    const normalizedName = jobName.toLowerCase();
    return normalizedRunJobMatches.some((match) => normalizedName.includes(match));
  };
  const ghJobIds = new Set(
    ghJobs
      .map((jobId) => (typeof jobId === "string" ? jobId.trim() : String(jobId ?? "").trim()))
      .filter((jobId) => jobId.length > 0),
  );
  for (const ghRunId of ghRuns) {
    const normalizedRunId =
      typeof ghRunId === "string" ? ghRunId.trim() : String(ghRunId ?? "").trim();
    if (normalizedRunId.length === 0) {
      continue;
    }
    const rawJobs = execFileSyncImpl("gh", ["run", "view", normalizedRunId, "--json", "jobs"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    let jobs = [];
    try {
      const parsed = JSON.parse(rawJobs);
      jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    } catch (error) {
      throw new Error(
        `[test-update-memory-hotspots] failed to parse gh run ${normalizedRunId} jobs json`,
        { cause: error },
      );
    }
    for (const job of jobs) {
      if (!shouldIncludeRunJob(job?.name)) {
        continue;
      }
      const jobId = job?.databaseId;
      if (!Number.isFinite(jobId)) {
        continue;
      }
      ghJobIds.add(String(jobId));
    }
  }
  for (const ghJobId of ghJobIds) {
    inputs.push({
      sourceName: `gh-job-${String(ghJobId)}`,
      text: execFileSyncImpl("gh", ["run", "view", "--job", String(ghJobId), "--log"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    });
  }
  return inputs;
}
