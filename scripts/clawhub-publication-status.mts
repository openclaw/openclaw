#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.js";
import type { ClawHubPublicationState } from "./lib/clawhub-publication-state.mjs";
import {
  collectClawHubPublishablePluginPackages,
  readClawHubPublication,
} from "./lib/plugin-clawhub-release.ts";
import { parsePluginReleaseSelection, resolveGitCommitSha } from "./lib/plugin-npm-release.ts";

const DEFAULT_STALL_THRESHOLD_MINUTES = 60;
const STATUS_READ_CONCURRENCY = 8;

type PublicationObservation = {
  name: string;
  publication: ClawHubPublicationState;
};

type StatusArgs = {
  json: boolean;
  lastProgressAt?: string;
  plugins: string[];
  stallThresholdMinutes: number;
  version: string;
};

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("--stall-threshold-minutes must be a positive number.");
  }
  return minutes;
}

function parseTimestamp(value: string, flag: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = Number(match?.[9]);
  const offsetMinute = Number(match?.[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validFields =
    match !== null &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (match[8] === undefined || (offsetHour <= 23 && offsetMinute <= 59));
  const normalizedValue =
    match === null || match[7] === undefined
      ? value
      : value.replace("." + match[7], "." + match[7].slice(0, 3).padEnd(3, "0"));
  const timestamp = validFields ? Date.parse(normalizedValue) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${flag} must be an ISO-8601 timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

export function parseClawHubPublicationStatusArgs(argv: string[]): StatusArgs {
  let json = false;
  let lastProgressAt: string | undefined;
  let plugins: string[] = [];
  let stallThresholdMinutes = DEFAULT_STALL_THRESHOLD_MINUTES;
  let version: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--last-progress-at":
        lastProgressAt = parseTimestamp(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--plugins":
        plugins = parsePluginReleaseSelection(readValue(argv, index, arg));
        if (plugins.length === 0) {
          throw new Error("--plugins must include at least one package name.");
        }
        index += 1;
        break;
      case "--stall-threshold-minutes":
        stallThresholdMinutes = parsePositiveMinutes(readValue(argv, index, arg));
        index += 1;
        break;
      case "--version":
        version = readValue(argv, index, arg).trim();
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!version) {
    throw new Error("--version is required.");
  }
  return { json, lastProgressAt, plugins, stallThresholdMinutes, version };
}

export function summarizeClawHubPublicationStatus(
  observations: PublicationObservation[],
  options: {
    lastProgressAt?: string;
    observedAt: string;
    stallThresholdMinutes?: number;
    version: string;
  },
) {
  const stallThresholdMinutes = options.stallThresholdMinutes ?? DEFAULT_STALL_THRESHOLD_MINUTES;
  const counts = {
    total: observations.length,
    published: 0,
    absent: 0,
    pending: 0,
    staging: 0,
    checks: 0,
    finalization: 0,
    failed: 0,
  };
  const pendingNames = {
    staging: [] as string[],
    checks: [] as string[],
    finalization: [] as string[],
  };
  const failedNames: string[] = [];

  for (const { name, publication } of observations) {
    switch (publication.state) {
      case "published":
        counts.published += 1;
        break;
      case "absent":
        counts.absent += 1;
        break;
      case "failed":
        counts.failed += 1;
        failedNames.push(name);
        break;
      case "pending":
        counts.pending += 1;
        counts[publication.stage] += 1;
        pendingNames[publication.stage].push(name);
        break;
    }
  }

  const observedAtMs = Date.parse(options.observedAt);
  const lastProgressAtMs = options.lastProgressAt ? Date.parse(options.lastProgressAt) : undefined;
  if (lastProgressAtMs !== undefined && lastProgressAtMs > observedAtMs) {
    throw new Error("--last-progress-at must not be after the observation time.");
  }
  const stalled =
    lastProgressAtMs === undefined
      ? null
      : counts.pending > 0 && observedAtMs - lastProgressAtMs >= stallThresholdMinutes * 60 * 1000;
  const stalledNames = stalled
    ? [...pendingNames.staging, ...pendingNames.checks, ...pendingNames.finalization].toSorted()
    : [];

  return {
    version: options.version,
    observedAt: new Date(observedAtMs).toISOString(),
    lastProgressAt: options.lastProgressAt,
    stallThresholdMinutes,
    stalled,
    counts,
    pendingNames,
    failedNames: failedNames.toSorted(),
    stalledNames,
  };
}

function formatNames(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

function printHuman(summary: ReturnType<typeof summarizeClawHubPublicationStatus>) {
  console.log(`ClawHub ${summary.version} status at ${summary.observedAt}`);
  console.log(
    `published=${summary.counts.published} absent=${summary.counts.absent} pending=${summary.counts.pending} failed=${summary.counts.failed} total=${summary.counts.total}`,
  );
  console.log(
    `pending stages: staging=${summary.counts.staging} checks=${summary.counts.checks} finalization=${summary.counts.finalization}`,
  );
  console.log(`failed packages: ${formatNames(summary.failedNames)}`);
  console.log(
    `stall threshold: ${summary.stallThresholdMinutes} minutes without observed public-state progress`,
  );
  if (summary.stalled === null) {
    console.log("stalled: unknown (pass --last-progress-at to classify)");
  } else {
    console.log(`stalled: ${summary.stalled ? "yes" : "no"}`);
    if (summary.stalled) {
      console.log(`stalled packages: ${formatNames(summary.stalledNames)}`);
    }
  }
}

export async function collectClawHubPublicationStatus(
  args: StatusArgs,
  options: {
    now?: () => number;
    readPublication?: typeof readClawHubPublication;
    rootDir?: string;
  } = {},
) {
  const rootDir = options.rootDir ?? resolve(".");
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "extensions"],
    { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (dirty) {
    throw new Error("ClawHub status requires a clean extensions tree from the exact release tag.");
  }
  const headSha = resolveGitCommitSha(rootDir, "HEAD", "ClawHub status checkout");
  const releaseTag = `refs/tags/v${args.version}`;
  const releaseSha = resolveGitCommitSha(rootDir, releaseTag, "ClawHub status release tag");
  if (headSha !== releaseSha) {
    throw new Error(
      `ClawHub status checkout ${headSha} does not match ${releaseTag} at ${releaseSha}. Check out the exact release tag.`,
    );
  }

  const publishable = collectClawHubPublishablePluginPackages(rootDir);
  const available = new Map(publishable.map((plugin) => [plugin.packageName, plugin]));
  const names = args.plugins.length > 0 ? args.plugins : [...available.keys()].toSorted();
  const unknown = names.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown or non-publishable ClawHub package: ${unknown.join(", ")}.`);
  }
  const mismatched = names.filter((name) => available.get(name)?.version !== args.version);
  if (mismatched.length > 0) {
    throw new Error(
      `Checked-out ClawHub package versions do not match ${args.version}: ${mismatched.join(", ")}. Run this command from the exact release source.`,
    );
  }

  const readPublication =
    options.readPublication ??
    ((name: string, version: string) =>
      readClawHubPublication(name, version, { allowLegacyVersionFallback: false }));
  const tasks = names.map((name) => async () => ({
    name,
    publication: await readPublication(name, args.version),
  }));
  const result = await runTasksWithConcurrency({
    tasks,
    limit: STATUS_READ_CONCURRENCY,
    errorMode: "stop",
  });
  if (result.hasError) {
    throw result.firstError;
  }
  return summarizeClawHubPublicationStatus(result.results, {
    version: args.version,
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    lastProgressAt: args.lastProgressAt,
    stallThresholdMinutes: args.stallThresholdMinutes,
  });
}

async function main() {
  const args = parseClawHubPublicationStatusArgs(process.argv.slice(2));
  const summary = await collectClawHubPublicationStatus(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    printHuman(summary);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
