#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const BULK_ADVISORY_PATH = "/-/npm/v1/security/advisories/bulk";
const MIN_SEVERITY = "high";
const SEVERITY_RANK = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const SNAPSHOT_SECTIONS = ["dependencies", "optionalDependencies"];
const IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const LOCAL_REFERENCE_PREFIXES = ["file:", "link:", "portal:", "workspace:"];

export function normalizeAuditLevel(level) {
  const normalized = String(level ?? "").toLowerCase();
  if (normalized in SEVERITY_RANK) {
    return normalized;
  }
  throw new Error(
    `Unsupported audit level "${String(level)}". Expected one of: ${Object.keys(SEVERITY_RANK).join(", ")}`,
  );
}

export function stripVersionDecorators(reference) {
  const openParenIndex = reference.indexOf("(");
  if (openParenIndex === -1) {
    return reference;
  }
  return reference.slice(0, openParenIndex);
}

export function parseSnapshotKey(snapshotKey) {
  let separatorIndex = -1;
  let parenDepth = 0;
  for (let index = 1; index < snapshotKey.length; index += 1) {
    const character = snapshotKey[index];
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "@" && parenDepth === 0) {
      separatorIndex = index;
    }
  }
  if (separatorIndex <= 0) {
    throw new Error(`Unable to parse pnpm snapshot key "${snapshotKey}".`);
  }
  const packageName = snapshotKey.slice(0, separatorIndex);
  const reference = snapshotKey.slice(separatorIndex + 1);
  return {
    packageName,
    reference,
    version: stripVersionDecorators(reference),
  };
}

function readResolvedReference(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && typeof entry.version === "string") {
    return entry.version;
  }
  return null;
}

function isLocalReference(reference) {
  return LOCAL_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function resolveSnapshot({ dependencyName, reference, snapshots }) {
  if (isLocalReference(reference)) {
    return null;
  }

  const directKey = `${dependencyName}@${reference}`;
  if (directKey in snapshots) {
    return {
      snapshotKey: directKey,
      ...parseSnapshotKey(directKey),
    };
  }

  if (reference in snapshots) {
    return {
      snapshotKey: reference,
      ...parseSnapshotKey(reference),
    };
  }

  if (reference.startsWith("npm:")) {
    const aliasKey = reference.slice(4);
    if (aliasKey in snapshots) {
      return {
        snapshotKey: aliasKey,
        ...parseSnapshotKey(aliasKey),
      };
    }
  }

  throw new Error(
    `Unable to resolve pnpm snapshot for dependency "${dependencyName}" with reference "${reference}".`,
  );
}

export function collectProdResolvedPackagesFromLockfile(lockfileText) {
  const lockfile = YAML.parse(lockfileText);
  const importers = lockfile?.importers;
  const snapshots = lockfile?.snapshots;
  if (!importers || typeof importers !== "object") {
    throw new Error("pnpm-lock.yaml is missing the importers section.");
  }
  if (!snapshots || typeof snapshots !== "object") {
    throw new Error("pnpm-lock.yaml is missing the snapshots section.");
  }

  const versionsByPackage = new Map();
  const seenSnapshots = new Set();
  const queue = [];

  for (const importer of Object.values(importers)) {
    if (!importer || typeof importer !== "object") {
      continue;
    }
    for (const sectionName of IMPORTER_SECTIONS) {
      const dependencies = importer[sectionName];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }
      for (const [dependencyName, entry] of Object.entries(dependencies)) {
        const reference = readResolvedReference(entry);
        if (!reference) {
          continue;
        }
        queue.push({ dependencyName, reference });
      }
    }
  }

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next) {
      continue;
    }
    const resolved = resolveSnapshot({
      dependencyName: next.dependencyName,
      reference: next.reference,
      snapshots,
    });
    if (!resolved) {
      continue;
    }

    let versions = versionsByPackage.get(resolved.packageName);
    if (!versions) {
      versions = new Set();
      versionsByPackage.set(resolved.packageName, versions);
    }
    versions.add(resolved.version);

    if (seenSnapshots.has(resolved.snapshotKey)) {
      continue;
    }
    seenSnapshots.add(resolved.snapshotKey);

    const snapshot = snapshots[resolved.snapshotKey];
    if (!snapshot || typeof snapshot !== "object") {
      continue;
    }
    for (const sectionName of SNAPSHOT_SECTIONS) {
      const dependencies = snapshot[sectionName];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }
      for (const [dependencyName, reference] of Object.entries(dependencies)) {
        if (typeof reference !== "string") {
          continue;
        }
        queue.push({ dependencyName, reference });
      }
    }
  }

  return versionsByPackage;
}

export function createBulkAdvisoryPayload(versionsByPackage) {
  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [
        packageName,
        [...versions].toSorted((left, right) => left.localeCompare(right)),
      ]),
  );
}

function normalizeSeverity(severity) {
  if (typeof severity !== "string") {
    return "info";
  }
  return severity.toLowerCase();
}

export function filterFindingsBySeverity(advisoriesByPackage, minSeverity) {
  const threshold = normalizeAuditLevel(minSeverity);
  const findings = [];

  for (const [packageName, advisories] of Object.entries(advisoriesByPackage ?? {})) {
    if (!Array.isArray(advisories)) {
      continue;
    }
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== "object") {
        continue;
      }
      const severity = normalizeSeverity(advisory.severity);
      if ((SEVERITY_RANK[severity] ?? -1) < SEVERITY_RANK[threshold]) {
        continue;
      }
      findings.push({
        packageName,
        id: advisory.id ?? "unknown",
        severity,
        title: advisory.title ?? "Untitled advisory",
        url: advisory.url ?? null,
        vulnerableVersions: advisory.vulnerable_versions ?? null,
      });
    }
  }

  findings.sort((left, right) => {
    const severityDelta =
      (SEVERITY_RANK[right.severity] ?? -1) - (SEVERITY_RANK[left.severity] ?? -1);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.packageName.localeCompare(right.packageName);
  });

  return findings;
}

function chunkEntries(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    DEFAULT_REGISTRY;
  return configured.replace(/\/+$/u, "");
}

export async function fetchBulkAdvisories({
  payload,
  fetchImpl = fetch,
  registryBaseUrl = resolveRegistryBaseUrl(),
}) {
  const url = `${registryBaseUrl}${BULK_ADVISORY_PATH}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Bulk advisory request failed (${response.status} ${response.statusText}): ${bodyText}`,
    );
  }

  return response.json();
}

export async function runPnpmAuditProd({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  minSeverity = MIN_SEVERITY,
} = {}) {
  const normalizedMinSeverity = normalizeAuditLevel(minSeverity);
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const lockfileText = await readFile(lockfilePath, "utf8");
  const payload = createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfileText));
  const payloadEntries = Object.entries(payload);

  if (payloadEntries.length === 0) {
    stdout.write("No production dependencies found in pnpm-lock.yaml.\n");
    return 0;
  }

  const advisoryResults = {};
  for (const payloadChunk of chunkEntries(payloadEntries, 400)) {
    const chunkPayload = Object.fromEntries(payloadChunk);
    const chunkResults = await fetchBulkAdvisories({
      payload: chunkPayload,
      fetchImpl,
    });
    Object.assign(advisoryResults, chunkResults);
  }

  const findings = filterFindingsBySeverity(advisoryResults, normalizedMinSeverity);
  if (findings.length === 0) {
    stdout.write(
      `No ${normalizedMinSeverity} or higher advisories found for production dependencies.\n`,
    );
    return 0;
  }

  stderr.write(
    `Found ${findings.length} ${normalizedMinSeverity} or higher advisories in production dependencies:\n`,
  );
  for (const finding of findings.slice(0, 25)) {
    const details = [
      `${finding.severity.toUpperCase()} ${finding.packageName}`,
      `id=${finding.id}`,
      `title=${finding.title}`,
    ];
    if (finding.vulnerableVersions) {
      details.push(`range=${finding.vulnerableVersions}`);
    }
    if (finding.url) {
      details.push(`url=${finding.url}`);
    }
    stderr.write(`- ${details.join(" · ")}\n`);
  }
  if (findings.length > 25) {
    stderr.write(`...and ${findings.length - 25} more advisories.\n`);
  }
  return 1;
}

function parseArgs(argv) {
  let minSeverity = MIN_SEVERITY;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--audit-level" || argument === "--min-severity") {
      minSeverity = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--audit-level=")) {
      minSeverity = argument.slice("--audit-level=".length);
      continue;
    }
    if (argument.startsWith("--min-severity=")) {
      minSeverity = argument.slice("--min-severity=".length);
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  return { minSeverity };
}

async function main() {
  try {
    const { minSeverity } = parseArgs(process.argv.slice(2));
    process.exitCode = await runPnpmAuditProd({ minSeverity });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
