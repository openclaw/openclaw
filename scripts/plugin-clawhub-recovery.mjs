#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.runtime.mjs";
import { isClawHubPublishAttemptId } from "./lib/clawhub-publication-state.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

export function formatClawHubRecoveryCommand({ attemptId, clawhubSource, reason }) {
  if (!isClawHubPublishAttemptId(attemptId)) {
    throw new Error("Invalid ClawHub publish attempt.");
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "bun",
    quote(join(clawhubSource, "packages/clawhub/src/cli.ts")),
    "--no-input package recover",
    quote(attemptId),
    "--manual-override-reason",
    quote(reason),
    "--wait --wait-timeout 1800 --json",
  ].join(" ");
}

function main() {
  const { values, positionals } = parseArgs({
    args: stripLeadingPackageManagerSeparator(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      version: { type: "string" },
      reason: { type: "string" },
      "clawhub-source": { type: "string" },
    },
  });
  const reason = values.reason?.trim();
  if (
    !values.version ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(values.version) ||
    !reason ||
    reason.length > 500 ||
    !values["clawhub-source"] ||
    !positionals.length
  ) {
    throw new Error(
      "Usage: node scripts/plugin-clawhub-recovery.mjs --version <version> --reason <1-500 characters> --clawhub-source <pinned checkout> <package-publish.json>...",
    );
  }
  const names = new Set();
  const attempts = new Set();
  const commands = [];
  for (const path of positionals) {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      !/^@openclaw\/[a-z0-9][a-z0-9._-]*$/u.test(record.name) ||
      record.version !== values.version ||
      !["published", "pending", "failed"].includes(record.publicationStatus) ||
      names.has(record.name)
    ) {
      throw new Error(`Invalid, mixed-version, or duplicate publish artifact: ${path}`);
    }
    names.add(record.name);
    if (record.publicationStatus === "published") {
      continue;
    }
    if (!isClawHubPublishAttemptId(record.attemptId) || attempts.has(record.attemptId)) {
      throw new Error(`Missing, invalid, or duplicate publish attempt: ${path}`);
    }
    attempts.add(record.attemptId);
    commands.push(
      `# ${record.name}@${record.version}: recorded ${record.publicationStatus}`,
      formatClawHubRecoveryCommand({
        attemptId: record.attemptId,
        clawhubSource: resolve(values["clawhub-source"]),
        reason,
      }),
    );
  }
  // Artifact snapshots select attempts; ClawHub remains the live state and recovery owner.
  console.error(
    "Review these commands against the original child/parent attempt before executing; no recovery was performed.",
  );
  if (commands.length) {
    console.log(commands.join("\n"));
  }
}

if (process.argv[1] && isDirectRunUrl(realpathSync(process.argv[1]), import.meta.url)) {
  main();
}
