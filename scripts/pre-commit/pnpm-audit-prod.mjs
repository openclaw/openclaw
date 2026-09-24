#!/usr/bin/env node

// Production dependency audit helper using pnpm lock data and npm bulk advisories.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
// This zero-install hook runs on Node 24.16.0+, where native TypeScript stripping is enabled.
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.ts";
import { cancelResponseReaderSoon, readBoundedResponseText } from "../lib/bounded-response.mjs";
import {
  parsePnpmLockfileSections,
  parseSnapshotKey,
  pnpmLockfileDocuments,
  resolveSnapshot,
} from "../lib/pnpm-lockfile-documents.mjs";
export { parseSnapshotKey, stripVersionDecorators } from "../lib/pnpm-lockfile-documents.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const BULK_ADVISORY_PATH = "/-/npm/v1/security/advisories/bulk";
const MIN_SEVERITY = "high";
/** Maximum advisory error body characters retained in messages. */
const BULK_ADVISORY_ERROR_BODY_MAX_CHARS = 4096;
const BULK_ADVISORY_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const BULK_ADVISORY_REQUEST_TIMEOUT_MS = 60_000;
const BULK_ADVISORY_REQUEST_BUDGET_MS = 240_000;
const BULK_ADVISORY_MAX_ATTEMPTS = 4;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const SEVERITY_RANK = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const SNAPSHOT_SECTIONS = ["dependencies", "optionalDependencies"];
// GitHub's GHSA-3q49-cfcf-g5fm feed includes an overbroad ">=0" range alongside
// the compromised @mistralai/mistralai versions. Keep the production audit
// blocking for the compromised releases while allowing pinned safe locks.
const AUDIT_ADVISORY_VERSION_OVERRIDES = [
  {
    packageName: "@mistralai/mistralai",
    advisoryIds: new Set(["1118204", "GHSA-3q49-cfcf-g5fm"]),
    unaffectedVersions: new Set(["2.2.1", "2.2.5"]),
  },
];

class AdvisoryUnavailableError extends Error {}
class AdvisoryRequestTimeoutError extends AdvisoryUnavailableError {}

// Node fetch wraps transport failures in cause; invalid URLs, TLS validation,
// malformed responses, and programming errors must remain blocking.
const ADVISORY_TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** @typedef {{ write: (chunk: string) => boolean }} AuditOutput */
/**
 * @typedef {object} BulkAdvisory
 * @property {number | string} id
 * @property {keyof typeof SEVERITY_RANK} severity
 * @property {string} vulnerable_versions
 * @property {string} [name]
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [overview]
 */
/**
 * @typedef {object} PnpmAuditOptions
 * @property {string} [rootDir]
 * @property {typeof fetch} [fetchImpl]
 * @property {AuditOutput} [stdout]
 * @property {AuditOutput} [stderr]
 * @property {string} [minSeverity]
 * @property {number} [budgetMs]
 */

function normalizeAuditLevel(level) {
  const normalized = String(level ?? "").toLowerCase();
  if (Object.hasOwn(SEVERITY_RANK, normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported audit level "${String(level)}". Expected one of: ${Object.keys(SEVERITY_RANK).join(", ")}`,
  );
}

export function collectProdResolvedPackagesFromLockfile(lockfileText) {
  const lockfile = parsePnpmLockfileSections(pnpmLockfileDocuments(lockfileText).dependencies);
  if (!lockfile.hasImportersSection) {
    throw new Error("pnpm-lock.yaml is missing the importers section.");
  }
  if (!lockfile.hasSnapshotsSection) {
    throw new Error("pnpm-lock.yaml is missing the snapshots section.");
  }

  const versionsByPackage = new Map();
  const seenSnapshots = new Set();
  const queue = [...lockfile.importers];

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next) {
      continue;
    }
    const resolved = resolveSnapshot({
      dependencyName: next.dependencyName,
      reference: next.reference,
      snapshots: lockfile.snapshots,
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

    const snapshot = lockfile.snapshots[resolved.snapshotKey];
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

export function collectAllResolvedPackagesFromLockfile(lockfileText) {
  const versionsByPackage = new Map();
  for (const document of Object.values(pnpmLockfileDocuments(lockfileText))) {
    if (document === null) {
      continue;
    }
    const lockfile = parsePnpmLockfileSections(document);
    if (!lockfile.hasSnapshotsSection) {
      throw new Error("pnpm-lock.yaml is missing the snapshots section.");
    }

    for (const snapshotKey of Object.keys(lockfile.snapshots)) {
      const resolved = parseSnapshotKey(snapshotKey);
      let versions = versionsByPackage.get(resolved.packageName);
      if (!versions) {
        versions = new Set();
        versionsByPackage.set(resolved.packageName, versions);
      }
      versions.add(resolved.version);
    }
  }

  return versionsByPackage;
}

/**
 * @param {Map<string, Set<string>>} versionsByPackage
 * @returns {Record<string, string[]>}
 */
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

function advisoryMatchesOverride(advisory, override) {
  const advisoryId = String(advisory?.id ?? "");
  const advisoryUrl = typeof advisory?.url === "string" ? advisory.url : "";
  return (
    override.advisoryIds.has(advisoryId) ||
    [...override.advisoryIds].some((id) => advisoryUrl.includes(id))
  );
}

function shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage }) {
  if (!versionsByPackage) {
    return false;
  }
  const override = AUDIT_ADVISORY_VERSION_OVERRIDES.find(
    (candidate) =>
      candidate.packageName === packageName && advisoryMatchesOverride(advisory, candidate),
  );
  if (!override) {
    return false;
  }
  const resolvedVersions = versionsByPackage.get(packageName);
  if (!resolvedVersions || resolvedVersions.size === 0) {
    return false;
  }
  return [...resolvedVersions].every((version) => override.unaffectedVersions.has(version));
}

export function filterFindingsBySeverity(advisoriesByPackage, minSeverity, versionsByPackage) {
  const threshold = normalizeAuditLevel(minSeverity);
  const findings = [];

  for (const [packageName, advisories] of Object.entries(advisoriesByPackage)) {
    for (const advisory of advisories) {
      const severity = advisory.severity;
      if ((SEVERITY_RANK[severity] ?? -1) < SEVERITY_RANK[threshold]) {
        continue;
      }
      if (shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage })) {
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

export function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    DEFAULT_REGISTRY;
  return configured.replace(/\/+$/u, "");
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveBulkAdvisoryRequestTimeoutMs() {
  return clampBulkAdvisoryTimeoutMs(
    parsePositiveIntegerEnv(
      "OPENCLAW_PNPM_AUDIT_BULK_TIMEOUT_MS",
      BULK_ADVISORY_REQUEST_TIMEOUT_MS,
    ),
  );
}

function resolveBulkAdvisoryResponseBodyMaxBytes() {
  return parsePositiveIntegerEnv(
    "OPENCLAW_PNPM_AUDIT_BULK_RESPONSE_MAX_BYTES",
    BULK_ADVISORY_RESPONSE_BODY_MAX_BYTES,
  );
}

function clampBulkAdvisoryTimeoutMs(valueMs) {
  const value = Number.isFinite(valueMs) ? valueMs : BULK_ADVISORY_REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMER_TIMEOUT_MS);
}

/**
 * @template T
 * @param {{ label: string, timeoutMs: number, run: (options: { signal: AbortSignal, timeoutPromise: Promise<never> }) => Promise<T> }} options
 * @returns {Promise<T>}
 */
export async function withAdvisoryRequestTimeout({ label, timeoutMs, run }) {
  const resolvedTimeoutMs = clampBulkAdvisoryTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timeout;
  /** @type {Promise<never>} */
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AdvisoryRequestTimeoutError(
        `${label} exceeded timeout of ${resolvedTimeoutMs}ms`,
      );
      controller.abort(error);
      reject(error);
    }, resolvedTimeoutMs);
  });
  try {
    return await Promise.race([run({ signal: controller.signal, timeoutPromise }), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function readBoundedBulkAdvisoryErrorText(
  response,
  maxChars = BULK_ADVISORY_ERROR_BODY_MAX_CHARS,
  options = {},
) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  let canceled = false;

  try {
    while (text.length <= maxChars) {
      const read = reader.read();
      const readWithTimeout = options.timeoutPromise
        ? Promise.race([
            read,
            options.timeoutPromise.catch((error) => {
              canceled = true;
              cancelResponseReaderSoon(reader);
              throw error;
            }),
          ])
        : read;
      const { done, value } = await readWithTimeout;
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = truncateUtf16Safe(text, maxChars);
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    } else if (!canceled) {
      reader.releaseLock();
    }
  }

  return truncated ? `${text}\n[truncated]` : text;
}

async function readBulkAdvisoryJson(response, maxBytes, options = {}) {
  const text = await readBoundedResponseText(response, "Bulk advisory", maxBytes, options);
  if (!text.trim()) {
    throw new Error("Bulk advisory response body was empty");
  }
  const body = JSON.parse(text);
  validateBulkAdvisoryResponse(body);
  return body;
}

/** @param {unknown} body @returns {asserts body is Record<string, BulkAdvisory[]>} */
function validateBulkAdvisoryResponse(body) {
  // Invalid data is not an empty audit. Both CI and release callers consume
  // this boundary, so reject it before either can discard unknown findings.
  if (!isRecord(body)) {
    throw new Error("Invalid bulk advisory response: expected a package map");
  }
  for (const advisories of Object.values(body)) {
    if (
      !Array.isArray(advisories) ||
      advisories.some((advisory) => {
        if (!isRecord(advisory)) {
          return true;
        }
        const validId =
          (typeof advisory.id === "number" && Number.isFinite(advisory.id)) ||
          (typeof advisory.id === "string" && advisory.id.length > 0);
        return (
          !validId ||
          typeof advisory.severity !== "string" ||
          !Object.hasOwn(SEVERITY_RANK, advisory.severity) ||
          typeof advisory.vulnerable_versions !== "string" ||
          !advisory.vulnerable_versions.trim() ||
          ["name", "title", "url", "overview"].some(
            (key) => advisory[key] !== undefined && typeof advisory[key] !== "string",
          )
        );
      })
    ) {
      throw new Error(
        "Invalid bulk advisory response: expected advisory arrays with an id, known severity, and vulnerable_versions",
      );
    }
  }
}

/**
 * @param {{ payload: Record<string, string[]>, fetchImpl?: typeof fetch, registryBaseUrl?: string,
 * responseBodyMaxBytes?: number, timeoutMs?: number, budgetMs?: number, stderr?: AuditOutput }} options
 */
export async function fetchBulkAdvisories({
  payload,
  fetchImpl = fetch,
  registryBaseUrl = resolveRegistryBaseUrl(),
  responseBodyMaxBytes = resolveBulkAdvisoryResponseBodyMaxBytes(),
  timeoutMs = resolveBulkAdvisoryRequestTimeoutMs(),
  budgetMs = BULK_ADVISORY_REQUEST_BUDGET_MS,
  stderr = process.stderr,
}) {
  const url = `${registryBaseUrl}${BULK_ADVISORY_PATH}`;
  const deadline =
    performance.now() +
    Math.min(clampBulkAdvisoryTimeoutMs(budgetMs), BULK_ADVISORY_REQUEST_BUDGET_MS);
  let budgetFailure = new AdvisoryRequestTimeoutError(
    "Bulk advisory total request budget exhausted",
  );
  // One deadline bounds requests, body reads, and backoff, even with an oversized
  // timeout or Retry-After. Each timed-out attempt aborts before the next starts.
  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      stderr.write("Bulk advisory total request budget exhausted; no clearance was obtained.\n");
      throw budgetFailure;
    }
    let responseStatus;
    let retryAt = 0;
    const attemptLabel = `Bulk advisory attempt ${attempt + 1}/${BULK_ADVISORY_MAX_ATTEMPTS}`;
    /** @type {Error | undefined} */
    let permanentHttpError;
    try {
      const advisories = await withAdvisoryRequestTimeout({
        label: "Bulk advisory request",
        timeoutMs: Math.min(timeoutMs, remainingMs),
        run: async ({ signal, timeoutPromise }) => {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          });
          responseStatus = response.status;
          if (!response.ok) {
            const retryAfter = response.headers.get("retry-after") ?? "";
            const retryAfterMs = /^\d+$/u.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
            retryAt = performance.now() + Math.max(0, retryAfterMs || 0);
            const ErrorType =
              response.status >= 500 || response.status === 408 || response.status === 429
                ? AdvisoryUnavailableError
                : Error;
            const httpError = new ErrorType(
              `Bulk advisory request failed (${response.status} ${response.statusText})`,
            );
            // A diagnostic-body timeout cannot soften an already-known permanent failure.
            if (ErrorType === Error) {
              permanentHttpError = httpError;
            }
            const bodyText = await readBoundedBulkAdvisoryErrorText(response, undefined, {
              timeoutPromise,
            });
            httpError.message += `: ${bodyText}`;
            throw httpError;
          }
          return await readBulkAdvisoryJson(response, responseBodyMaxBytes, {
            signal,
            timeoutPromise,
          });
        },
      });
      if (attempt > 0) {
        stderr.write(`${attemptLabel} succeeded.\n`);
      }
      return advisories;
    } catch (error) {
      if (permanentHttpError) {
        throw permanentHttpError;
      }
      const code = error?.cause?.code ?? error?.code;
      const failure = ADVISORY_TRANSPORT_ERROR_CODES.has(code)
        ? new AdvisoryUnavailableError(`Bulk advisory request unavailable (${code})`, {
            cause: error,
          })
        : error;
      const retryable =
        responseStatus === undefined || responseStatus < 400
          ? error instanceof AdvisoryRequestTimeoutError || error instanceof TypeError
          : (responseStatus >= 500 && responseStatus < 600) || responseStatus === 429;
      if (!retryable) {
        throw failure;
      }
      budgetFailure = failure;
      const waitMs = Math.ceil(
        Math.max(1000 * 2 ** attempt * (1 + Math.random()), retryAt - performance.now()),
      );
      const budgetExhausted = waitMs >= deadline - performance.now();
      const exhausted = attempt + 1 === BULK_ADVISORY_MAX_ATTEMPTS || budgetExhausted;
      stderr.write(
        `${attemptLabel} failed: ${JSON.stringify(failure.message)}; ${exhausted ? "stopping" : `retrying in ${waitMs}ms`}.\n`,
      );
      if (exhausted) {
        const ErrorType =
          failure instanceof AdvisoryUnavailableError ? AdvisoryUnavailableError : Error;
        throw new ErrorType(
          `Bulk advisory request failed after ${attempt + 1} attempts${budgetExhausted ? " (total request budget exhausted)" : ""}. Check npm registry availability and retry the audit; no clearance was obtained. Last failure: ${failure.message}`,
          { cause: failure },
        );
      }
      await delay(waitMs);
    }
  }
}

/** @param {PnpmAuditOptions} [options] */
export async function runPnpmAuditProd({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  minSeverity = MIN_SEVERITY,
  budgetMs,
} = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  let packageCount;
  let result = { outcome: "error", reason: "Audit did not complete." };
  try {
    const normalizedMinSeverity = normalizeAuditLevel(minSeverity);
    const lockfileText = await readFile(path.join(rootDir, "pnpm-lock.yaml"), "utf8");
    const versionsByPackage = collectProdResolvedPackagesFromLockfile(lockfileText);
    const payload = createBulkAdvisoryPayload(versionsByPackage);
    packageCount = versionsByPackage.size;
    if (packageCount === 0) {
      result = {
        outcome: "complete",
        reason: "No production dependencies found in pnpm-lock.yaml.",
      };
      stdout.write(`${result.reason}\n`);
      return 0;
    }
    const advisoryResults = await fetchBulkAdvisories({ payload, fetchImpl, budgetMs, stderr });
    const findings = filterFindingsBySeverity(
      advisoryResults,
      normalizedMinSeverity,
      versionsByPackage,
    );
    if (findings.length === 0) {
      result = {
        outcome: "complete",
        reason: `No matching ${normalizedMinSeverity} or higher advisories returned by npm bulk for production dependencies.`,
      };
      stdout.write(
        `${result.reason} Upstream repository advisories were not checked; this is not comprehensive vulnerability clearance.\n`,
      );
      return 0;
    }
    result = {
      outcome: "findings",
      reason: `Found ${findings.length} ${normalizedMinSeverity} or higher advisories from npm bulk in production dependencies`,
    };
    stderr.write(`${result.reason} (upstream repository advisories not checked):\n`);
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
  } catch (error) {
    result = { outcome: "error", reason: error instanceof Error ? error.message : String(error) };
    if (!(error instanceof AdvisoryUnavailableError)) {
      throw error;
    }
    result.outcome = "unavailable";
    stderr.write(`Production dependency audit incomplete: ${result.reason}\n`);
    return 2;
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY) {
      const reason = JSON.stringify(truncateUtf16Safe(result.reason, 1000)).replace(
        /`/gu,
        "\\u0060",
      );
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          "## Production dependency audit",
          `Outcome: **${result.outcome}**`,
          `Packages: ${packageCount ?? "unknown"} · Duration: ${((performance.now() - startedMs) / 1000).toFixed(1)}s · Started: ${startedAt}`,
          "Coverage: npm bulk advisories only. Unavailable or error outcomes provide no clearance.",
          "```text",
          reason,
          "```",
          "",
        ].join("\n\n"),
      );
    }
  }
}

function readSeverityValue(value, optionName) {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  let minSeverity = MIN_SEVERITY;
  let budgetMs;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ci") {
      budgetMs = 30_000;
      continue;
    }
    if (argument === "--audit-level" || argument === "--min-severity") {
      minSeverity = readSeverityValue(argv[index + 1], argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--audit-level=")) {
      minSeverity = readSeverityValue(argument.slice("--audit-level=".length), "--audit-level");
      continue;
    }
    if (argument.startsWith("--min-severity=")) {
      minSeverity = readSeverityValue(argument.slice("--min-severity=".length), "--min-severity");
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  return { minSeverity, ...(budgetMs === undefined ? {} : { budgetMs }) };
}

async function main() {
  try {
    process.exitCode = await runPnpmAuditProd(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  if (process.exitCode) {
    process.stderr.write(`[pnpm-audit-prod] FAILED (exit ${process.exitCode})\n`);
  }
}
