import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { inspectActionsArtifactZipWithPolicy, sha256Digest } from "./actions-artifact-archive.mjs";

const selectionSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.string(),
  counts: z
    .object({ candidates: z.number().int().nonnegative(), pruned: z.number().int().nonnegative() })
    .refine(({ candidates, pruned }) => pruned <= candidates),
  estimatedPrunedSeconds: z.number().nonnegative().optional(),
  codex: z.object({ durationMs: z.number().nonnegative() }),
});
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  failures: z
    .array(
      z.object({
        path: z.string(),
        classification: z.enum(["floor", "codex-kept", "codex-pruned", "outside-candidates"]),
      }),
    )
    .default([]),
  unknown: z.array(z.object({ job: z.string(), reason: z.string() })).default([]),
  errors: z.array(z.string()).default([]),
});
type Observation = {
  runUrl: string;
  selection?: z.infer<typeof selectionSchema>;
  report?: z.infer<typeof reportSchema>;
};

function distribution(values: number[]) {
  if (!values.length) {
    return { samples: 0, median: null, p90: null };
  }
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    samples: ordered.length,
    median: ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2,
    p90: ordered[Math.ceil(ordered.length * 0.9) - 1]!,
  };
}

/** One observation per run; skipped and fail-open selections retain their zero prune ratios. */
export function summarizeTestSelections(observations: readonly Observation[]) {
  const statusCounts = new Map<string, number>();
  const unknownJobReasons = new Map<string, number>();
  const ratios: number[] = [],
    durations: number[] = [],
    estimates: number[] = [];
  const failingFiles = { floor: 0, kept: 0, MISS: 0, outside: 0 };
  const misses: { runUrl: string; path: string }[] = [];
  let runsWithSelection = 0,
    reports = 0,
    reportsWithErrors = 0,
    unknownJobs = 0;
  for (const { runUrl, selection, report } of observations) {
    if (!selection) {
      continue;
    }
    runsWithSelection++;
    const status = selection.status === "shadow" ? "ready" : selection.status;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    if (selection.counts.candidates > 0) {
      ratios.push(selection.counts.pruned / selection.counts.candidates);
    }
    if (selection.codex.durationMs > 0) {
      durations.push(selection.codex.durationMs);
    }
    if (selection.estimatedPrunedSeconds !== undefined) {
      estimates.push(selection.estimatedPrunedSeconds);
    }
    if (!report) {
      continue;
    }
    reports++;
    reportsWithErrors += Number(report.errors.length > 0);
    unknownJobs += report.unknown.length;
    for (const { reason } of report.unknown) {
      unknownJobReasons.set(reason, (unknownJobReasons.get(reason) ?? 0) + 1);
    }
    const seen = new Set<string>();
    for (const failure of report.failures) {
      if (seen.has(failure.path)) {
        continue;
      }
      seen.add(failure.path);
      if (failure.classification === "codex-pruned") {
        failingFiles.MISS++;
        misses.push({ runUrl, path: failure.path });
      } else if (failure.classification === "codex-kept") {
        failingFiles.kept++;
      } else if (failure.classification === "outside-candidates") {
        failingFiles.outside++;
      } else {
        failingFiles.floor++;
      }
    }
  }
  return {
    runsConsidered: observations.length,
    runsWithSelection,
    runsWithoutSelection: observations.length - runsWithSelection,
    statusCounts: Object.fromEntries([...statusCounts].toSorted(([a], [b]) => a.localeCompare(b))),
    pruneRatio: distribution(ratios),
    codexDurationMs: distribution(durations),
    estimatedPrunedSeconds: estimates.length
      ? estimates.reduce((total, seconds) => total + seconds, 0)
      : null,
    runsWithTimingEstimates: estimates.length,
    reports,
    missingReports: runsWithSelection - reports,
    reportsWithErrors,
    unknownJobs,
    unknownJobsByReason: Object.fromEntries(
      [...unknownJobReasons].toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    failingFiles,
    misses: misses.toSorted(
      (a, b) => a.runUrl.localeCompare(b.runUrl) || a.path.localeCompare(b.path),
    ),
  };
}

const execFileAsync = promisify(execFile);
const ARCHIVE_BYTES = 32 * 1024 * 1024;
const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  expired: z.boolean(),
  digest: z.string().nullish(),
});
const artifactFiles = new Set([
  "selection.json",
  "prepared.json",
  "prompt.md",
  "codex-output.json",
  "summary.md",
  "report.json",
  "report-summary.md",
]);
async function gh(args: string[]) {
  return (
    await execFileAsync("gh", args, {
      encoding: "buffer",
      maxBuffer: ARCHIVE_BYTES,
      timeout: 120_000,
    })
  ).stdout;
}

export async function runSelectionSummary(repository: string, limit: number, scratch: string) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("summarize requires --repo owner/name and a positive --limit");
  }
  const listedRuns = z
    .array(z.object({ databaseId: z.number().int().positive(), url: z.string().url() }))
    .parse(
      JSON.parse(
        (
          await gh([
            "run",
            "list",
            "--repo",
            repository,
            "--workflow",
            "ci.yml",
            "--event",
            "pull_request",
            "--limit",
            String(limit),
            "--json",
            "databaseId,url",
          ])
        ).toString("utf8"),
      ),
    );
  const runs = [...new Map(listedRuns.map((run) => [run.databaseId, run])).values()];
  const cache = path.join(scratch, repository.replaceAll("/", "--"));
  mkdirSync(cache, { recursive: true });
  const observations: Observation[] = runs.map((run) => ({ runUrl: run.url }));
  const errors: { runUrl: string; artifactId?: number; reason: string }[] = [];
  let next = 0;
  const readArchive = async (artifact: z.infer<typeof artifactSchema>) => {
    const file = path.join(cache, `${artifact.id}.zip`);
    let bytes: Buffer;
    if (existsSync(file)) {
      bytes = readFileSync(file);
    } else {
      if (artifact.expired) {
        throw new Error("expired");
      }
      bytes = await gh(["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`]);
      const partial = `${file}.${randomUUID()}.partial`;
      try {
        writeFileSync(partial, bytes);
        renameSync(partial, file);
      } finally {
        rmSync(partial, { force: true });
      }
    }
    if (artifact.digest && sha256Digest(bytes) !== artifact.digest) {
      throw new Error("digest-mismatch");
    }
    return inspectActionsArtifactZipWithPolicy(bytes, {
      minEntries: 1,
      maxEntries: artifactFiles.size,
      maxArchiveBytes: ARCHIVE_BYTES,
      maxExpandedBytes: 64 * 1024 * 1024,
      maxEntryBytes: () => 8 * 1024 * 1024,
      allowPath: (name: string) => artifactFiles.has(name),
    });
  };
  // Each worker awaits its own list/download calls, bounding bare gh concurrency to four.
  await Promise.all(
    Array.from({ length: Math.min(4, runs.length) }, async () => {
      while (next < runs.length) {
        const index = next++,
          run = runs[index]!;
        const attempts = new Map<number, Observation>();
        try {
          const artifacts = z.array(artifactSchema).parse(
            (
              await gh([
                "api",
                `repos/${repository}/actions/runs/${run.databaseId}/artifacts?per_page=100`,
                "--paginate",
                "--jq",
                '.artifacts[] | select(.name | startswith("codex-test-selection-")) | {id,name,expired,digest} | tojson',
              ])
            )
              .toString("utf8")
              .split(/\r?\n/u)
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
          for (const artifact of artifacts.toSorted((a, b) => a.id - b.id)) {
            const match = /^codex-test-selection-(?:report-)?([1-9]\d*)$/u.exec(artifact.name);
            if (!match) {
              continue;
            }
            try {
              const files = await readArchive(artifact);
              const attempt = Number(match[1]);
              const observation = attempts.get(attempt) ?? { runUrl: run.url };
              attempts.set(attempt, observation);
              const selection = files.get("selection.json"),
                report = files.get("report.json");
              if (selection) {
                observation.selection = selectionSchema.parse(
                  JSON.parse(selection.toString("utf8")),
                );
              }
              if (report) {
                observation.report = reportSchema.parse(JSON.parse(report.toString("utf8")));
              }
            } catch {
              errors.push({
                runUrl: run.url,
                artifactId: artifact.id,
                reason: artifact.expired
                  ? "expired-or-invalid-cache"
                  : "artifact-unavailable-or-invalid",
              });
            }
          }
        } catch {
          errors.push({ runUrl: run.url, reason: "artifact-list-unavailable" });
        }
        const selected = [...attempts]
          .filter(([, value]) => value.selection)
          .toSorted(([a], [b]) => b - a)[0];
        if (selected) {
          observations[index] = selected[1];
        }
      }
    }),
  );
  console.log(
    JSON.stringify(
      {
        repository,
        cacheDirectory: cache,
        ...summarizeTestSelections(observations),
        errors: errors.toSorted(
          (a, b) => a.runUrl.localeCompare(b.runUrl) || (a.artifactId ?? 0) - (b.artifactId ?? 0),
        ),
      },
      null,
      2,
    ),
  );
}
