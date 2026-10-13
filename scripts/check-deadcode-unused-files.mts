#!/usr/bin/env node
// Enforces a hard-zero policy for Knip's unused files.
import { fileURLToPath } from "node:url";
import {
  isLikelyRepoFilePath,
  runKnipScans,
  type KnipRunResult,
  uniqueSorted,
} from "./deadcode-knip-runner.mts";

const KNIP_COMMON_ARGS = ["--no-progress", "--reporter", "compact", "--files", "--no-config-hints"];

const KNIP_SCANS = [
  {
    name: "production unused-file scan",
    args: ["--config", "config/knip.config.ts", "--production"],
  },
  {
    name: "full-tree unused-file scan",
    args: ["--config", "config/knip.all-exports.config.ts"],
  },
] as const;

export function parseKnipCompactUnusedFiles(output: string) {
  const files = [];
  let inUnusedFilesSection = false;

  for (const line of output.split(/\r?\n/u)) {
    if (/^Unused files \(\d+\)$/u.test(line)) {
      inUnusedFilesSection = true;
      continue;
    }
    if (inUnusedFilesSection && line.trim() === "") {
      break;
    }

    const separatorIndex = line.lastIndexOf(": ");
    if (separatorIndex === -1) {
      continue;
    }
    const file = line.slice(separatorIndex + 2).trim();
    if (isLikelyRepoFilePath(file)) {
      files.push(file);
    }
  }

  return uniqueSorted(files);
}

export function checkUnusedFiles(output: string) {
  const files = parseKnipCompactUnusedFiles(output);
  return {
    ok: files.length === 0,
    files,
    message:
      files.length === 0
        ? ""
        : [
            "Unused files are not allowed:",
            ...files.map((file) => `  ${file}`),
            "Delete the files or model their real entrypoints in Knip.",
          ].join("\n"),
  };
}

export function checkKnipUnusedFileScanResult(result: KnipRunResult) {
  if (result.errorCode || result.status === null || result.status !== 0) {
    return {
      ok: false,
      failureReason: result.errorCode ?? result.signal ?? `exit status ${String(result.status)}`,
      message: "",
    };
  }
  const check = checkUnusedFiles(result.output);
  return { ok: check.ok, failureReason: "", message: check.message };
}

function reportUnusedFileScan(scan: (typeof KNIP_SCANS)[number], result: KnipRunResult) {
  const validation = checkKnipUnusedFileScanResult(result);
  if (validation.failureReason) {
    console.error(
      `deadcode ${scan.name} failed: ${validation.failureReason}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    return false;
  }
  if (!validation.ok) {
    if (validation.message) {
      console.error(`${scan.name}:\n${validation.message}`);
    }
    return false;
  }
  console.log(`[deadcode] Knip ${scan.name} passed with 0 entries.`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runKnipScans(KNIP_SCANS, KNIP_COMMON_ARGS, reportUnusedFileScan);
}
