#!/usr/bin/env -S node --import tsx
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { decodeNodeTestGroups } from "./lib/ci-node-test-groups-codec.mts";
import {
  ciTestTimingsSchema,
  isRuntimePlacementIncludePatterns,
} from "./lib/ci-test-timings-schema.mts";
import { execGhRead } from "./lib/plain-gh.mjs";
import { createCompactSplitTimingGeneration } from "./lib/vitest-shard-metadata.mts";

const positiveId = z.number().int().positive();
const runSchema = z.object({
  id: positiveId,
  run_attempt: positiveId,
  path: z.literal(".github/workflows/ci.yml"),
  event: z.literal("workflow_dispatch"),
  status: z.literal("completed"),
  conclusion: z.string(),
  display_title: z.string().regex(/^CI full-release-validation-[1-9]\d*-[1-9]\d*-ci$/u),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  repository: z.object({ full_name: z.literal("openclaw/openclaw") }),
});
const jobSchema = z.object({
  id: positiveId,
  run_id: positiveId,
  run_attempt: positiveId,
  head_sha: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  labels: z.array(z.string()),
});
const groupSchema = z.object({
  shard_name: z.string().min(1),
  timing_key: z.string().optional(),
  configs: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()).optional(),
  includePatterns: z.array(z.string().min(1)).min(1).optional(),
});

function timingKey(log: string): string {
  const descriptors = new Set(
    [
      ...stripVTControlCharacters(log).matchAll(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: (\S+)\s*$/gmu,
      ),
    ].map((match) => match[1]!),
  );
  if (descriptors.size !== 1) {
    throw new Error("Hosted timing job must record one unambiguous shard descriptor");
  }
  const groups = z
    .array(groupSchema)
    .length(1)
    .parse(decodeNodeTestGroups([...descriptors][0]!));
  const group = groups[0]!;
  const observedKey = group.timing_key ?? group.shard_name;
  if (
    !log.includes(`[shard:${observedKey}] begin`) ||
    !log.includes(`[shard:${observedKey}] end (exit 0)`)
  ) {
    throw new Error("Hosted timing job lacks a successful matching shard span");
  }
  if (group.timing_key?.startsWith("release-full-")) {
    return group.timing_key;
  }
  const parentShardName = `release-full-${group.shard_name}`;
  return isRuntimePlacementIncludePatterns(group.includePatterns)
    ? createCompactSplitTimingGeneration({
        configs: group.configs,
        env: group.env,
        parentShardName,
        stripes: [group.includePatterns],
      }).timingKeys[0]!
    : parentShardName;
}

function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      out: {
        type: "string",
        default: fileURLToPath(new URL("../config/ci-test-timings.json", import.meta.url)),
      },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.run || !/^[1-9]\d*$/u.test(values.run) || !Number.isSafeInteger(Number(values.run))) {
    throw new Error("--run requires an exact positive CI child run ID");
  }
  const logFlags = execGhRead(["api", "--help"], { encoding: "utf8", timeout: 30_000 }).includes(
    "--allow-escape-sequences",
  )
    ? ["--allow-escape-sequences"]
    : [];
  const api = (endpoint: string) =>
    execGhRead(
      [
        "api",
        `repos/openclaw/openclaw/${endpoint}`,
        "-H",
        "Cache-Control: max-age=0",
        ...(endpoint.endsWith("/logs") ? logFlags : []),
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const readRun = () => runSchema.parse(JSON.parse(api(`actions/runs/${values.run}`)));
  const run = readRun();
  if (String(run.id) !== values.run) {
    throw new Error("CI child run ID differs from the requested run");
  }
  const timings = ciTestTimingsSchema.parse(JSON.parse(readFileSync(values.out, "utf8")));
  const measurements = new Map<string, number>();
  const seenIds = new Set<number>();
  let pageBudget = 100;
  for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
    let total: number | undefined;
    let count = 0;
    for (let page = 1; ; page += 1) {
      if (--pageBudget < 0) {
        throw new Error("CI timing job pagination limit exceeded");
      }
      const payload = z
        .object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema) })
        .parse(
          JSON.parse(
            api(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`),
          ),
        );
      if (total !== undefined && total !== payload.total_count) {
        throw new Error("CI timing job inventory changed during pagination");
      }
      total = payload.total_count;
      for (const job of payload.jobs) {
        if (
          job.run_id !== run.id ||
          job.run_attempt !== attempt ||
          job.head_sha !== run.head_sha ||
          seenIds.has(job.id)
        ) {
          throw new Error("CI timing job identity or attempt differs from its run");
        }
        seenIds.add(job.id);
        count += 1;
        if (
          job.status !== "completed" ||
          job.conclusion !== "success" ||
          !job.name.startsWith("checks-node-") ||
          job.name.startsWith("checks-node-compact-") ||
          !job.labels.includes("ubuntu-24.04") ||
          job.labels.some(
            (label) =>
              label === "self-hosted" ||
              label.startsWith("blacksmith-") ||
              label.startsWith("runson"),
          )
        ) {
          continue;
        }
        const start = Date.parse(job.started_at ?? "");
        const end = Date.parse(job.completed_at ?? "");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > Date.now()) {
          throw new Error(`Invalid wall clock for CI timing job ${job.id}`);
        }
        const key = timingKey(api(`actions/jobs/${job.id}/logs`));
        measurements.set(
          key,
          Math.max(measurements.get(key) ?? 0, Math.ceil((end - start) / 1000)),
        );
      }
      if (count === total) {
        break;
      }
      if (count > total || payload.jobs.length === 0) {
        throw new Error("CI timing job pagination is incomplete");
      }
    }
  }
  if (JSON.stringify(readRun()) !== JSON.stringify(run)) {
    throw new Error("CI child attempt changed while collecting timings; no timings written");
  }
  if (measurements.size === 0) {
    throw new Error("CI child supplied no successful hosted full-release shard timings");
  }
  for (const [key, seconds] of measurements) {
    timings.compactGroupSeconds.github[key] = Math.max(
      timings.compactGroupSeconds.github[key] ?? 0,
      seconds,
    );
  }
  timings.compactGroupSeconds.github = Object.fromEntries(
    Object.entries(timings.compactGroupSeconds.github).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  timings.updatedAt = new Date().toISOString().slice(0, 10);
  timings.source = `Release CI ${run.id} attempt ${run.run_attempt} hosted job walls; retained other timings: ${timings.source}`;
  ciTestTimingsSchema.parse(timings);
  if (!values["dry-run"]) {
    writeFileSync(values.out, `${JSON.stringify(timings, null, 2)}\n`);
  }
  console.log(
    `${values["dry-run"] ? "Measured" : "Refreshed"} ${measurements.size} hosted release shard costs from CI ${run.id} attempt ${run.run_attempt}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
