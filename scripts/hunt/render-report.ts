#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import type { HuntCheckResult, HuntReportV1 } from "./types.js";

type CliArgs = {
  input: string;
  jsonOut: string;
  mdOut: string;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  node --import tsx scripts/hunt/render-report.ts \\",
      "    --input <report-input.json> \\",
      "    --json-out <hunt-report.json> \\",
      "    --md-out <hunt-report.md>",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  let input = "";
  let jsonOut = "";
  let mdOut = "";

  while (args.length > 0) {
    const key = args.shift() ?? "";
    if (key === "--") {
      continue;
    }
    if (key === "--input") {
      input = args.shift() ?? "";
      continue;
    }
    if (key === "--json-out") {
      jsonOut = args.shift() ?? "";
      continue;
    }
    if (key === "--md-out") {
      mdOut = args.shift() ?? "";
      continue;
    }
    if (key === "--help" || key === "-h") {
      usage();
    }
    console.error(`Unknown argument: ${key}`);
    usage();
  }

  if (!input || !jsonOut || !mdOut) {
    usage();
  }

  return { input, jsonOut, mdOut };
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "n/a";
  }
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function statusRank(status: HuntCheckResult["status"]): number {
  switch (status) {
    case "fail":
      return 0;
    case "warn":
      return 1;
    case "pass":
      return 2;
    case "skip":
      return 3;
    default:
      return 9;
  }
}

function summarizeChecks(checks: HuntCheckResult[]): Record<HuntCheckResult["status"], number> {
  return checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<HuntCheckResult["status"], number>,
  );
}

function renderMarkdown(report: HuntReportV1): string {
  const summary = summarizeChecks(report.checks);
  const sortedChecks = [...report.checks].toSorted((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) {
      return byStatus;
    }
    return a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  lines.push(`# OpenClaw Release-Gate Hunt Report`);
  lines.push("");
  lines.push(`- Release: \`${report.release}\``);
  lines.push(`- Lane: \`${report.lane}\``);
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Ended: ${report.endedAt}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Checks | ${report.checks.length} |`);
  lines.push(`| Pass | ${summary.pass} |`);
  lines.push(`| Warn | ${summary.warn} |`);
  lines.push(`| Fail | ${summary.fail} |`);
  lines.push(`| Skip | ${summary.skip} |`);
  lines.push(`| Signatures tracked | ${report.signatures.length} |`);
  lines.push(`| Classified findings | ${report.classification.length} |`);
  lines.push("");

  lines.push("## Check Results");
  lines.push("");
  lines.push("| Status | Check | Summary | Duration |");
  lines.push("| --- | --- | --- | ---: |");
  for (const check of sortedChecks) {
    lines.push(
      `| ${check.status.toUpperCase()} | ${check.title} | ${check.summary.replace(/\|/g, "\\|")} | ${formatDuration(check.durationMs)} |`,
    );
  }
  lines.push("");

  lines.push("## Signature Counts");
  lines.push("");
  lines.push("| Signature | Source | Window | Baseline | Delta | Issue |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- |");
  for (const sig of report.signatures) {
    const baseline = Number.isFinite(sig.baselineWindowCount)
      ? String(sig.baselineWindowCount)
      : "-";
    const delta = Number.isFinite(sig.delta) ? String(sig.delta) : "-";
    const issue = sig.issueUrl ? `[link](${sig.issueUrl})` : "-";
    lines.push(
      `| ${sig.name} | ${sig.source} | ${sig.countWindow} | ${baseline} | ${delta} | ${issue} |`,
    );
  }
  lines.push("");

  lines.push("## Classification");
  lines.push("");
  if (report.classification.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of report.classification) {
      const linkParts = [
        entry.issueUrl ? `[issue](${entry.issueUrl})` : "",
        entry.prUrl ? `[pr](${entry.prUrl})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `- **${entry.severity.toUpperCase()} ${entry.category} ${entry.status}** \`${entry.id}\`: ${entry.summary}${linkParts ? ` (${linkParts})` : ""}`,
      );
      if (entry.expected) {
        lines.push(`  expected: ${entry.expected}`);
      }
      if (entry.actual) {
        lines.push(`  actual: ${entry.actual}`);
      }
      if (entry.suggestedFix) {
        lines.push(`  suggested fix: ${entry.suggestedFix}`);
      }
    }
  }
  lines.push("");

  lines.push("## Upstream Links");
  lines.push("");
  if (report.upstreamLinks.length === 0) {
    lines.push("- none");
  } else {
    for (const link of report.upstreamLinks) {
      lines.push(`- ${link}`);
    }
  }
  lines.push("");

  if (report.metadata && Object.keys(report.metadata).length > 0) {
    lines.push("## Metadata");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(report.metadata, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown schema error";
  }
  return errors
    .map((err) => `${err.instancePath || "<root>"} ${err.message ?? "invalid"}`)
    .join("; ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "report.schema.json",
  );

  const inputText = await fs.readFile(args.input, "utf-8");
  const raw = JSON.parse(inputText) as HuntReportV1;

  const schemaText = await fs.readFile(schemaPath, "utf-8");
  const schema = JSON.parse(schemaText) as object;

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile<HuntReportV1>(schema);
  if (!validate(raw)) {
    throw new Error(`Invalid hunt report: ${formatAjvErrors(validate.errors)}`);
  }

  await fs.mkdir(path.dirname(args.jsonOut), { recursive: true });
  await fs.mkdir(path.dirname(args.mdOut), { recursive: true });

  await fs.writeFile(args.jsonOut, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  const markdown = renderMarkdown(raw);
  await fs.writeFile(args.mdOut, `${markdown}\n`, "utf-8");

  console.log(`Wrote JSON report: ${args.jsonOut}`);
  console.log(`Wrote Markdown report: ${args.mdOut}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
