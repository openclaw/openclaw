#!/usr/bin/env -S node --import tsx
// Emits stable plugin support drift reports from local JSON evidence inputs.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  generateStablePluginDriftReport,
  parseStablePluginSupportManifest,
  type StablePluginAcceptanceProof,
  type StablePluginCatalogEntry,
  type StablePluginInstalledEntry,
  type StablePluginLineMetadata,
  type StablePluginRegistryProof,
} from "../src/plugins/plugin-version-drift.ts";

type ParsedArgs = {
  stableLine?: string;
  stableLinesPath?: string;
  manifestPath?: string;
  registryProofPath?: string;
  packageAcceptancePath?: string;
  catalogPath?: string;
  installedStatePath?: string;
  outputPath?: string;
  issuesOutputPath?: string;
  updateIssues?: boolean;
  generatedAt?: string;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValues(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (isRecord(raw)) {
    if (Array.isArray(raw.entries)) {
      return raw.entries;
    }
    if (Array.isArray(raw.packages)) {
      return raw.packages;
    }
    if (Array.isArray(raw.proofs)) {
      return raw.proofs;
    }
    if (Array.isArray(raw.installedPlugins)) {
      return raw.installedPlugins;
    }
    return Object.values(raw);
  }
  return [];
}

function registryProofs(raw: unknown): StablePluginRegistryProof[] {
  return objectValues(raw)
    .filter(isRecord)
    .map((entry) => {
      const version = normalizeString(entry.version ?? entry.registryVersion);
      const targetNpmSpec = normalizeString(entry.targetNpmSpec);
      const observedAt = normalizeString(entry.observedAt ?? entry.generatedAt);
      return {
        packageName: normalizeString(entry.packageName ?? entry.name) ?? "",
        ...(version ? { version } : {}),
        ...(targetNpmSpec ? { targetNpmSpec } : {}),
        exists: entry.exists === undefined ? true : entry.exists === true,
        ...(observedAt ? { observedAt } : {}),
      };
    })
    .filter((entry) => entry.packageName);
}

function acceptanceProofs(raw: unknown): StablePluginAcceptanceProof[] {
  return objectValues(raw)
    .filter(isRecord)
    .map((entry) => {
      const targetVersion = normalizeString(entry.targetVersion ?? entry.version);
      const targetNpmSpec = normalizeString(entry.targetNpmSpec);
      const stableLine = normalizeString(entry.stableLine);
      const stablePluginSupportSha256 = normalizeString(entry.stablePluginSupportSha256);
      const manifestSha256 = normalizeString(entry.manifestSha256);
      const result = normalizeString(entry.result) as StablePluginAcceptanceProof["result"];
      const completedAt = normalizeString(entry.completedAt);
      const generatedAt = normalizeString(entry.generatedAt);
      const observedAt = normalizeString(entry.observedAt);
      return {
        packageName: normalizeString(entry.packageName ?? entry.name) ?? "",
        ...(targetVersion ? { targetVersion } : {}),
        ...(targetNpmSpec ? { targetNpmSpec } : {}),
        ...(stableLine ? { stableLine } : {}),
        ...(stablePluginSupportSha256 ? { stablePluginSupportSha256 } : {}),
        ...(manifestSha256 ? { manifestSha256 } : {}),
        ...(entry.passed === true ? { passed: true } : {}),
        ...(result ? { result } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(generatedAt ? { generatedAt } : {}),
        ...(observedAt ? { observedAt } : {}),
      };
    })
    .filter((entry) => entry.packageName);
}

function catalogEntries(raw: unknown): StablePluginCatalogEntry[] {
  return objectValues(raw)
    .filter(isRecord)
    .map((entry) => {
      const openclaw = isRecord(entry.openclaw) ? entry.openclaw : {};
      const plugin = isRecord(openclaw.plugin) ? openclaw.plugin : {};
      const kind = normalizeString(entry.kind);
      const source = normalizeString(entry.source);
      return {
        packageName: normalizeString(entry.packageName ?? entry.name) ?? "",
        pluginId: normalizeString(entry.pluginId ?? plugin.id) ?? "",
        ...(kind ? { kind } : {}),
        ...(source ? { source } : {}),
      };
    })
    .filter((entry) => entry.packageName && entry.pluginId);
}

function installedEntries(raw: unknown): StablePluginInstalledEntry[] {
  return objectValues(raw)
    .filter(isRecord)
    .map((entry) => {
      const packageName = normalizeString(entry.packageName ?? entry.resolvedName);
      const installedVersion = normalizeString(entry.installedVersion);
      const resolvedVersion = normalizeString(entry.resolvedVersion);
      const version = normalizeString(entry.version);
      const spec = normalizeString(entry.spec);
      return {
        pluginId: normalizeString(entry.pluginId ?? entry.id) ?? "",
        ...(packageName ? { packageName } : {}),
        ...(installedVersion ? { installedVersion } : {}),
        ...(resolvedVersion ? { resolvedVersion } : {}),
        ...(version ? { version } : {}),
        ...(spec ? { spec } : {}),
      };
    })
    .filter((entry) => entry.pluginId);
}

function stableLineMetadata(
  raw: unknown,
  requestedLine: string | undefined,
): StablePluginLineMetadata | undefined {
  if (!isRecord(raw)) {
    return requestedLine ? { stableLine: requestedLine } : undefined;
  }
  const candidates = objectValues(raw).filter(isRecord);
  const selected =
    candidates.find(
      (entry) => normalizeString(entry.stableLine ?? entry.baseVersion) === requestedLine,
    ) ??
    (isRecord(raw.active) ? raw.active : undefined) ??
    raw;
  const stableLine = normalizeString(selected.stableLine ?? selected.baseVersion) ?? requestedLine;
  const baseVersion = normalizeString(selected.baseVersion);
  const targetBranch = normalizeString(selected.targetBranch ?? selected.branch);
  const updatedAt = normalizeString(selected.updatedAt ?? selected.lastRefreshed);
  const manifestSha256 = normalizeString(
    selected.manifestSha256 ?? selected.stablePluginSupportSha256,
  );
  return stableLine
    ? {
        stableLine,
        ...(baseVersion ? { baseVersion } : {}),
        ...(targetBranch ? { targetBranch } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(manifestSha256 ? { manifestSha256 } : {}),
      }
    : undefined;
}

export function parseStablePluginDriftReportArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stable-line") {
      parsed.stableLine = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--stable-lines") {
      parsed.stableLinesPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      parsed.manifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--registry-proof") {
      parsed.registryProofPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--package-acceptance") {
      parsed.packageAcceptancePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--catalog") {
      parsed.catalogPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--installed-state") {
      parsed.installedStatePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--output") {
      parsed.outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--issues-output") {
      parsed.issuesOutputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--update-issues") {
      parsed.updateIssues = true;
      continue;
    }
    if (arg === "--dry-run-issues") {
      parsed.updateIssues = false;
      continue;
    }
    if (arg === "--generated-at") {
      parsed.generatedAt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

export function collectStablePluginDriftReport(argv: string[]) {
  const args = parseStablePluginDriftReportArgs(argv);
  if (!args.manifestPath) {
    throw new Error("--manifest is required.");
  }
  const manifest = parseStablePluginSupportManifest(readJson(args.manifestPath));
  const stableLine = args.stableLinesPath
    ? stableLineMetadata(readJson(args.stableLinesPath), args.stableLine)
    : undefined;
  const requestedStableLine = args.stableLine ? { stableLine: args.stableLine } : undefined;
  return generateStablePluginDriftReport({
    manifest,
    ...((stableLine ?? requestedStableLine)
      ? { stableLine: stableLine ?? requestedStableLine }
      : {}),
    registryProofs: args.registryProofPath ? registryProofs(readJson(args.registryProofPath)) : [],
    acceptanceProofs: args.packageAcceptancePath
      ? acceptanceProofs(readJson(args.packageAcceptancePath))
      : [],
    catalogEntries: args.catalogPath ? catalogEntries(readJson(args.catalogPath)) : [],
    installedEntries: args.installedStatePath
      ? installedEntries(readJson(args.installedStatePath))
      : [],
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
    updateIssues: args.updateIssues === true,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseStablePluginDriftReportArgs(process.argv.slice(2));
  const report = collectStablePluginDriftReport(process.argv.slice(2));
  const reportJson = JSON.stringify(report, null, 2);
  if (args.outputPath) {
    writeFileSync(args.outputPath, `${reportJson}\n`);
  } else {
    console.log(reportJson);
  }
  if (args.issuesOutputPath) {
    writeFileSync(args.issuesOutputPath, `${JSON.stringify(report.issues, null, 2)}\n`);
  }
}
