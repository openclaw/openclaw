#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCatalogList, type CliCatalogList } from "../src/cli-catalog-overlay/list.js";

export const COMMAND_REFERENCE_DOC_PATH = "docs/cli/commands.md";

function withPublicCommandEnvironment<T>(callback: () => T): T {
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  try {
    return callback();
  } finally {
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
  }
}

function escapeCell(value: string): string {
  return value.replace(/\r\n?|\n/gu, " ").replace(/\|/gu, "\\|");
}

function code(value: string): string {
  return `\`${value}\``;
}

function effectLabel(descriptor: CliCatalogList["cli"]["descriptors"][number]): string {
  const profile = descriptor.effectProfile;
  if (!profile) {
    return "Unknown";
  }
  const details = [profile.effectMode];
  if (profile.risk) {
    details.push(`${profile.risk} risk`);
  }
  if (profile.confirmationRequired) {
    details.push("confirmation required");
  }
  return details.join("; ");
}

function paddedRow(cells: readonly string[], widths: readonly number[]): string {
  return `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const escapedHeaders = headers.map(escapeCell);
  const escapedRows = rows.map((row) => row.map(escapeCell));
  const widths = escapedHeaders.map((header, index) =>
    Math.max(header.length, 3, ...escapedRows.map((row) => row[index]?.length ?? 0)),
  );
  return [
    paddedRow(escapedHeaders, widths),
    paddedRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...escapedRows.map((row) => paddedRow(row, widths)),
  ];
}

function descriptorRows(list: CliCatalogList): readonly (readonly string[])[] {
  return list.cli.descriptors
    .filter((descriptor) => descriptor.visibility.includes("docs"))
    .map((descriptor) => [
      code(descriptor.name),
      descriptor.description,
      effectLabel(descriptor),
      code(descriptor.sourceKind),
    ]);
}

export function buildCommandReferenceMarkdown(): string {
  return withPublicCommandEnvironment(() => {
    const list = buildCatalogList();
    const rows = descriptorRows(list);
    return [
      "---",
      'summary: "Generated reference for OpenClaw command inventory and effect metadata"',
      "read_when:",
      "  - Looking up available top-level OpenClaw commands",
      "  - Reviewing command effect or provenance metadata",
      'title: "Command inventory"',
      "---",
      "",
      "# Command inventory",
      "",
      "This page is generated from OpenClaw's static command descriptors. Do not edit it by hand.",
      "Regenerate it with `pnpm docs:commands:gen`; CI verifies freshness with",
      "`pnpm docs:commands:check`.",
      "",
      "Use [`openclaw commands list`](/cli/index#command-inventory) for the current",
      "invocation's runtime tree and opt-in plugin descriptors. Runtime plugin, paired-node,",
      "and external-provider state is deployment-specific and is not checked into this page.",
      "",
      "An **Unknown** effect means the owning command descriptor has not classified the",
      "command. It does not mean read-only, low risk, or confirmation-free.",
      "",
      `Generated entries: ${rows.length}.`,
      "",
      ...markdownTable(["Command", "Description", "Effect", "Source"], rows),
      "",
    ].join("\n");
  });
}

export function runCommandReferenceGenerator(argv = process.argv.slice(2)): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error(
      "usage: node --import tsx scripts/generate-command-reference-doc.ts --write|--check",
    );
    return 1;
  }

  const outputPath = path.join(process.cwd(), COMMAND_REFERENCE_DOC_PATH);
  const next = buildCommandReferenceMarkdown();
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (check) {
    if (current !== next) {
      console.error(`${COMMAND_REFERENCE_DOC_PATH} is stale; run pnpm docs:commands:gen`);
      return 1;
    }
    return 0;
  }
  if (current !== next) {
    writeFileSync(outputPath, next);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCommandReferenceGenerator();
}
