#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRootDefault = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_CONFIG_REL = "config/openclaw-blackbox-autonomy.json";
const DEFAULT_UPSTREAM_REL = "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json";
const DEFAULT_DOWNSTREAM_REL =
  "reports/hermes-agent/state/openclaw-live-architecture-feedback-latest.json";
const DEFAULT_REPORT_REL = "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function parseArgs(argv) {
  const options = {
    repoRoot: repoRootDefault,
    configPath: null,
    upstreamPath: null,
    downstreamPath: null,
    reportPath: null,
    writeState: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
      continue;
    }
    if (arg === "--config") {
      options.configPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--upstream") {
      options.upstreamPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--upstream=")) {
      options.upstreamPath = arg.slice("--upstream=".length);
      continue;
    }
    if (arg === "--downstream") {
      options.downstreamPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--downstream=")) {
      options.downstreamPath = arg.slice("--downstream=".length);
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--write-state") {
      options.writeState = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  options.repoRoot = path.resolve(options.repoRoot);
  return options;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function writeJsonWithSha(filePath, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function normalizeVersion(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function deriveVersion(payload, fallbackSeed) {
  const fromFields =
    normalizeVersion(payload?.version) ??
    normalizeVersion(payload?.upstreamVersion) ??
    normalizeVersion(payload?.downstreamVersion) ??
    normalizeVersion(payload?.cycleId) ??
    normalizeVersion(payload?.generatedAt);
  if (fromFields) {
    return fromFields;
  }
  return `sha256:${sha256Text(JSON.stringify(fallbackSeed)).slice(0, 12)}`;
}

function toRepoRel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function resolvePath(repoRoot, rawPath, fallbackRel) {
  const value = typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath.trim() : null;
  if (!value) {
    return path.join(repoRoot, fallbackRel);
  }
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function buildConflictResolution(syncStatus) {
  return {
    policy: {
      downstreamExecutionStatusPriority: true,
      upstreamCandidatePayloadPriority: true,
      coreFieldOverwriteDenied: true,
    },
    resolvedBy: syncStatus === "synced" ? "dual_priority_merge" : "upstream_only",
    winnerByField: {
      executionStatus: "downstream",
      candidatePayload: "upstream",
      safetyFlags: "upstream",
      metadata: "dual",
    },
    conflicts: [],
  };
}

export async function runBlackboxSyncBridge(rawOptions = {}) {
  const repoRoot = path.resolve(rawOptions.repoRoot ?? repoRootDefault);
  const configPath = resolvePath(repoRoot, rawOptions.configPath, DEFAULT_CONFIG_REL);
  const config = (await readJsonIfExists(configPath)) ?? {};
  const upstreamPath = resolvePath(
    repoRoot,
    rawOptions.upstreamPath,
    config?.paths?.autonomyLatest ?? DEFAULT_UPSTREAM_REL,
  );
  const downstreamPath = resolvePath(
    repoRoot,
    rawOptions.downstreamPath,
    config?.sync?.downstreamStatusPath ?? DEFAULT_DOWNSTREAM_REL,
  );
  const reportPath = resolvePath(
    repoRoot,
    rawOptions.reportPath,
    config?.sync?.reportPath ?? DEFAULT_REPORT_REL,
  );
  const writeState = rawOptions.writeState === true;

  const upstream = await readJsonIfExists(upstreamPath);
  const downstream = await readJsonIfExists(downstreamPath);
  const generatedAt = new Date().toISOString();

  const upstreamVersion = deriveVersion(upstream, { generatedAt, seed: "upstream-missing" });
  const downstreamVersion = deriveVersion(downstream, { generatedAt, seed: "downstream-missing" });

  let syncStatus = "synced";
  if (!upstream) {
    syncStatus = "blocked_missing_upstream";
  } else if (!downstream) {
    syncStatus = "degraded_downstream_missing";
  }

  const lastAckAt =
    normalizeVersion(downstream?.lastAckAt) ??
    normalizeVersion(downstream?.generatedAt) ??
    generatedAt;
  const conflictResolution = buildConflictResolution(syncStatus);
  const mergedState = {
    executionStatus: downstream?.executionStatus ?? downstream?.status ?? "downstream_unavailable",
    candidatePayloadVersion: upstreamVersion,
    candidateCount:
      typeof upstream?.generatedCandidates === "number"
        ? upstream.generatedCandidates
        : Array.isArray(upstream?.candidates)
          ? upstream.candidates.length
          : 0,
    noOrderWrite: upstream?.safety?.noOrderWrite === true || upstream?.noOrderWrite === true,
    allowLiveTrading:
      upstream?.safety?.allowLiveTrading === true || upstream?.allowLiveTrading === true,
  };

  const report = {
    schema: "openclaw.blackbox.sync-bridge.v1",
    generatedAt,
    upstreamPath: toRepoRel(repoRoot, upstreamPath),
    downstreamPath: toRepoRel(repoRoot, downstreamPath),
    reportPath: toRepoRel(repoRoot, reportPath),
    upstreamVersion,
    downstreamVersion,
    syncStatus,
    conflictResolution,
    lastAckAt,
    mergedState,
    safety: {
      noOrderWrite: true,
      allowLiveTrading: false,
      sentOrder: false,
      writeBrokerOrders: false,
    },
  };
  report.machineLine = [
    "blackboxSync=ready",
    `syncStatus=${report.syncStatus}`,
    `upstreamVersion=${report.upstreamVersion}`,
    `downstreamVersion=${report.downstreamVersion}`,
    `lastAckAt=${report.lastAckAt}`,
    "noOrderWrite=true",
    "allowLiveTrading=false",
  ].join(";");

  if (writeState) {
    await writeJsonWithSha(reportPath, report);
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/openclaw-blackbox-sync-bridge.mjs [--write-state] [--json]\n",
    );
    return;
  }
  const report = await runBlackboxSyncBridge(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write("OpenClaw blackbox sync bridge\n");
  process.stdout.write(`syncStatus=${report.syncStatus}\n`);
  process.stdout.write(`upstreamVersion=${report.upstreamVersion}\n`);
  process.stdout.write(`downstreamVersion=${report.downstreamVersion}\n`);
  process.stdout.write(`lastAckAt=${report.lastAckAt}\n`);
  process.stdout.write(`machineLine=${report.machineLine}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    process.stderr.write(
      `openclaw blackbox sync bridge failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
