#!/usr/bin/env node
import { parseArgs } from "node:util";

const statuses = new Set(["complete", "partial", "failed", "missing", "incompatible"]);
const classifications = new Set(["runtime", "type", "mixed", "declarative"]);
const help = `Query current public ClawHub plugin SDK usage (read-only; no credentials).
Usage: node query.mjs <canonical-key> [--months <count> | --since <UTC-ISO-instant>] [--base-url https://clawhub.ai] [--max-pages 1000]
Examples:
  node query.mjs 'api-member:api.registerTool'
  node query.mjs 'api-member:api.registerTool' --months 3
  node query.mjs 'api-member:api.registerTool' --since 2026-07-16T12:00:00Z
  node query.mjs 'sdk-export:openclaw/plugin-sdk/core#OpenClawPluginApi'
Outputs JSON. Exit 1 means unavailable/incomplete traversal, never zero usage.
Exit 0 can still report incomplete coverage; inspect assessment and coverage.`;

function requireShape(condition, message) {
  if (!condition) {
    throw new Error(`Invalid ClawHub response: ${message}`);
  }
}

async function pages(baseUrl, path, params, maxPages, validate) {
  const items = [];
  const visited = new Set();
  let cursor = null;
  do {
    if (visited.size >= maxPages) {
      throw new Error(`Page limit reached for ${path}`);
    }
    if (visited.has(cursor)) {
      throw new Error(`Repeated cursor for ${path}`);
    }
    visited.add(cursor);
    const url = new URL(path, baseUrl);
    url.search = new URLSearchParams({ ...params, limit: "100" }).toString();
    if (cursor !== null) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`ClawHub ${path} returned HTTP ${response.status}`);
    }
    const page = await response.json();
    requireShape(page && Array.isArray(page.items), "missing items");
    requireShape(
      page.nextCursor === null ||
        (typeof page.nextCursor === "string" && page.nextCursor.length > 0),
      "missing pagination boundary",
    );
    validate(page);
    for (const item of page.items) {
      requireShape(
        item &&
          typeof item.packageName === "string" &&
          typeof item.releaseId === "string" &&
          typeof item.version === "string",
        "missing plugin/release identity",
      );
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

function validateReleaseWindow(page, releasedSince) {
  if (releasedSince === undefined) {
    return;
  }
  requireShape(page.releasedSince === releasedSince, "release cutoff was not applied");
  for (const item of page.items) {
    requireShape(
      Number.isSafeInteger(item.releaseCreatedAt) && item.releaseCreatedAt >= releasedSince,
      "missing release date or release outside the requested window",
    );
  }
}

async function query(key, baseUrl, maxPages, releasedSince) {
  const filter = releasedSince === undefined ? {} : { releasedSince: String(releasedSince) };
  const items = await pages(baseUrl, "/api/v1/sdk-usage", { key, ...filter }, maxPages, (page) => {
    validateReleaseWindow(page, releasedSince);
    requireShape(page.key === key, "wrong canonical key");
    for (const item of page.items) {
      requireShape(
        item.key === key && classifications.has(item.classification),
        "invalid usage identity or classification",
      );
      requireShape(
        Array.isArray(item.evidence) && Array.isArray(item.referenceKinds),
        "missing evidence or reference kinds",
      );
      requireShape(
        item.scan &&
          ["complete", "partial"].includes(item.scan.status) &&
          item.scan.schemaVersion === 1 &&
          item.scan.analysisVersion === "1" &&
          item.scan.inputKind === "artifact",
        "incompatible usage scan",
      );
    }
  });
  const roster = await pages(baseUrl, "/api/v1/sdk-usage/coverage", filter, maxPages, (page) => {
    validateReleaseWindow(page, releasedSince);
    requireShape(page.scope === "page", "unknown coverage scope");
    for (const item of page.items) {
      requireShape(
        statuses.has(item.status) &&
          Number.isSafeInteger(item.unknownCount) &&
          item.unknownCount >= 0,
        "invalid coverage status",
      );
    }
  });
  const warnings = [];
  const current = new Map();
  for (const item of roster) {
    if (current.has(item.packageName)) {
      warnings.push(`Coverage changed while paging: ${item.packageName}`);
    }
    current.set(item.packageName, item);
  }
  const consumers = new Map();
  for (const item of items) {
    if (consumers.has(item.packageName)) {
      warnings.push(`Usage changed while paging: ${item.packageName}`);
    }
    if (current.get(item.packageName)?.releaseId !== item.releaseId) {
      warnings.push(`Release or visibility changed while querying: ${item.packageName}`);
    }
    consumers.set(item.packageName, item);
  }
  const coverage = {
    eligible: current.size,
    complete: 0,
    partial: 0,
    failed: 0,
    missing: 0,
    incompatible: 0,
    unresolvedReferences: 0,
  };
  for (const item of current.values()) {
    coverage[item.status] += 1;
    coverage.unresolvedReferences += item.unknownCount;
  }
  const referenceCounts = { runtime: 0, type: 0, declarative: 0 };
  for (const item of consumers.values()) {
    if (["runtime", "mixed"].includes(item.classification)) {
      referenceCounts.runtime += 1;
    }
    if (["type", "mixed"].includes(item.classification)) {
      referenceCounts.type += 1;
    }
    if (item.classification === "declarative") {
      referenceCounts.declarative += 1;
    }
  }
  const complete =
    coverage.eligible === coverage.complete &&
    coverage.unresolvedReferences === 0 &&
    warnings.length === 0;
  return {
    key,
    source: new URL(baseUrl).origin,
    observedAt: new Date().toISOString(),
    releaseWindow:
      releasedSince === undefined
        ? null
        : {
            latestReleaseUploadedSince: new Date(releasedSince).toISOString(),
            timezone: "UTC",
            inclusive: true,
          },
    traversalComplete: true,
    assessment: !complete
      ? "incomplete-coverage"
      : coverage.eligible === 0
        ? "empty-corpus"
        : consumers.size
          ? "observed-consumers"
          : "no-observed-consumers",
    distinctPlugins: consumers.size,
    referenceCounts,
    coverage,
    items: [...consumers.values()].toSorted((a, b) => a.packageName.localeCompare(b.packageName)),
    gaps: [...current.values()].filter(
      (item) => item.status !== "complete" || item.unknownCount > 0,
    ),
    warnings,
    scope:
      "Observed static references in latest eligible public plugin artifacts. Pages are live reads, not an atomic snapshot. Private, unpublished and separately installed dependency code is outside this corpus.",
  };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "base-url": { type: "string", default: "https://clawhub.ai" },
      "max-pages": { type: "string", default: "1000" },
      since: { type: "string" },
      months: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
  } else {
    const [key] = positionals;
    if (
      positionals.length !== 1 ||
      !/^(sdk-module|sdk-export|api-member|runtime-member|hook|manifest-contract):.+/.test(key)
    ) {
      throw new Error(help);
    }
    const maxPages = Number(values["max-pages"]);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new Error("--max-pages must be a positive integer");
    }
    if (values.since !== undefined && values.months !== undefined) {
      throw new Error("Use either --since or --months, not both");
    }
    let releasedSince;
    if (values.months !== undefined) {
      const months = Number(values.months);
      if (!Number.isSafeInteger(months) || months < 1 || months > 1200) {
        throw new Error("--months must be an integer from 1 to 1200");
      }
      const cutoff = new Date();
      const day = cutoff.getUTCDate();
      // Set day 1 before moving months so May 31 minus 3 months stays in February.
      cutoff.setUTCDate(1);
      cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
      const monthEnd = new Date(cutoff);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
      cutoff.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
      releasedSince = cutoff.getTime();
      if (releasedSince < 0) {
        throw new Error("Release cutoff must be on or after 1970-01-01");
      }
    }
    if (values.since !== undefined) {
      releasedSince = Date.parse(values.since);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(values.since) ||
        !Number.isSafeInteger(releasedSince) ||
        releasedSince < 0 ||
        new Date(releasedSince).toISOString() !==
          (values.since.includes(".") ? values.since : values.since.replace("Z", ".000Z"))
      ) {
        throw new Error("--since must be a valid UTC ISO instant, e.g. 2026-07-16T12:00:00Z");
      }
    }
    console.log(
      JSON.stringify(await query(key, values["base-url"], maxPages, releasedSince), null, 2),
    );
  }
} catch (error) {
  console.log(
    JSON.stringify(
      {
        assessment: "unavailable",
        traversalComplete: false,
        distinctPlugins: null,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
