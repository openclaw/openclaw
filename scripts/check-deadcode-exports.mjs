#!/usr/bin/env node
// Enforces a hard-zero policy for Knip's unused exports.
import { fileURLToPath } from "node:url";
import { isLikelyRepoFilePath, runKnip, uniqueSorted } from "./deadcode-knip-runner.mjs";

const KNIP_ISSUES = "exports,nsExports,types,nsTypes,enumMembers,namespaceMembers";

// One config, two modes: production fails on exports no production module
// consumes, full-tree makes tests entrypoints and fails on dead test support.
const KNIP_SCANS = [
  {
    name: "production unused-export scan",
    args: ["--config", "config/knip.config.ts", "--production"],
  },
  {
    name: "full-tree unused-export scan",
    args: ["--config", "config/knip.config.ts"],
  },
];

// Config hints are left enabled, but the compact reporter does not render them.
// To audit stale ignore entries, rerun a scan with `--reporter symbols`.
const KNIP_COMMON_ARGS = ["--no-progress", "--reporter", "compact", "--include", KNIP_ISSUES];

/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExportsResult(output) {
  const entries = [];
  let inExportSection = false;
  let sawExportSection = false;

  for (const line of output.split(/\r?\n/u)) {
    const sectionMatch =
      /^(Unused exports|Exports in used namespace|Unused exported types|Exported types in used namespace|Unused exported enum members|Unused exported namespace members) \(\d+\)$/u.exec(
        line,
      );
    if (sectionMatch) {
      inExportSection = true;
      sawExportSection = true;
      continue;
    }
    if (/^Unused .+ \(\d+\)$/u.test(line)) {
      inExportSection = false;
      continue;
    }
    if (!inExportSection) {
      continue;
    }

    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) {
      continue;
    }
    const file = line.slice(0, separatorIndex).trim();
    if (!isLikelyRepoFilePath(file)) {
      continue;
    }
    const symbols = line.slice(separatorIndex + 2).split(", ");
    for (const symbol of symbols) {
      const trimmedSymbol = symbol.trim();
      if (trimmedSymbol) {
        entries.push(`${file}: ${trimmedSymbol}`);
      }
    }
  }

  return { entries: uniqueSorted(entries), sawExportSection };
}

/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExports(output) {
  return parseKnipCompactUnusedExportsResult(output).entries;
}

/** Rejects every unused export reported by Knip. */
export function checkUnusedExports(output) {
  const entries = parseKnipCompactUnusedExports(output);
  return {
    ok: entries.length === 0,
    entries,
    message:
      entries.length === 0
        ? ""
        : [
            "Unused exports are not allowed:",
            ...entries.map((entry) => `  ${entry}`),
            "Delete the exports or model their real production consumers in Knip.",
          ].join("\n"),
  };
}

async function main() {
  // The scans are independent Knip child processes over the same config;
  // running them concurrently cuts the lane's serial wall clock roughly 2x.
  const results = await Promise.all(
    KNIP_SCANS.map(async (scan) => ({
      scan,
      result: await runKnip([...scan.args, ...KNIP_COMMON_ARGS], { scanName: scan.name }),
    })),
  );
  for (const { scan, result } of results) {
    if (!reportUnusedExportScan(scan, result)) {
      process.exitCode = 1;
      return;
    }
  }
  console.log(
    "[deadcode] Knip production and full-tree unused-export checks passed with 0 entries.",
  );
}

function reportUnusedExportScan(scan, result) {
  if (result.errorCode || result.status === null) {
    console.error(
      `deadcode ${scan.name} failed: ${result.errorCode ?? result.signal ?? "unknown"}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    return false;
  }

  const parsed = parseKnipCompactUnusedExportsResult(result.output);
  // Knip's compact reporter omits empty sections, so a clean scan (exit 0)
  // legitimately prints no export sections; sectionless output is only a
  // failure signal when Knip also exited nonzero (crash/config error).
  if (!parsed.sawExportSection && result.status !== 0) {
    console.error(`deadcode ${scan.name} produced no export sections.`);
    if (result.output) {
      console.error(result.output);
    }
    return false;
  }

  const check = checkUnusedExports(result.output);
  if (!check.ok) {
    console.error(`${scan.name}:\n${check.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`deadcode ${scan.name} exited with status ${result.status}.`);
    if (result.output) {
      console.error(result.output);
    }
    return false;
  }
  console.log(`[deadcode] Knip ${scan.name} passed with 0 entries.`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
