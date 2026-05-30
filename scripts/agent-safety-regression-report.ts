#!/usr/bin/env -S node --import tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentSafetyRegressionSafeCandidates,
  evaluateAgentSafetyCandidates,
  type AgentSafetyEvaluation,
} from "../src/security/agent-safety-regression.ts";

type Args = {
  check: boolean;
  jsonPath: string;
  markdownPath: string;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    check: false,
    jsonPath: ".artifacts/agent-safety-regression/report.json",
    markdownPath: ".artifacts/agent-safety-regression/report.md",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--json") {
      args.jsonPath = argv[++index] ?? "";
      continue;
    }
    if (arg === "--markdown") {
      args.markdownPath = argv[++index] ?? "";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node --import tsx scripts/agent-safety-regression-report.ts [--check] [--json path] [--markdown path]

Runs deterministic RAMPART-style OpenClaw agent safety scenarios and writes a
report. Default mode is report-only and exits 0 so new prompt/tool/runtime gates
can observe failures before becoming blocking.`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.jsonPath || !args.markdownPath) {
    throw new Error("--json and --markdown require non-empty paths.");
  }
  return args;
}

function ensureParent(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function statusFor(evaluation: AgentSafetyEvaluation): string {
  return evaluation.passed ? "pass" : "fail";
}

function renderMarkdown(evaluations: readonly AgentSafetyEvaluation[]): string {
  const failed = evaluations.filter((evaluation) => !evaluation.passed);
  const lines = [
    "# Agent Safety Regression Report",
    "",
    "Deterministic, pytest-style scenarios adapted for OpenClaw release gates.",
    "",
    `- Cases: ${evaluations.length}`,
    `- Passed: ${evaluations.length - failed.length}`,
    `- Failed: ${failed.length}`,
    "",
    "| Scenario | Status | Findings |",
    "| --- | --- | --- |",
  ];

  for (const evaluation of evaluations) {
    const findings =
      evaluation.findings.length === 0
        ? "-"
        : evaluation.findings.map((finding) => `${finding.code}: ${finding.message}`).join("<br>");
    lines.push(`| ${evaluation.scenarioId} | ${statusFor(evaluation)} | ${findings} |`);
  }

  lines.push(
    "",
    "Report-only mode is intentional until the release team promotes this gate to blocking.",
  );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const evaluations = evaluateAgentSafetyCandidates(agentSafetyRegressionSafeCandidates);
  const failed = evaluations.filter((evaluation) => !evaluation.passed);
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: args.check ? "check" : "report-only",
    passed: failed.length === 0,
    evaluations,
  };

  ensureParent(args.jsonPath);
  ensureParent(args.markdownPath);
  writeFileSync(args.jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(args.markdownPath, renderMarkdown(evaluations));

  console.log(
    `agent-safety-regression: ${evaluations.length - failed.length}/${evaluations.length} passed (${args.check ? "check" : "report-only"})`,
  );
  console.log(`agent-safety-regression: wrote ${args.jsonPath} and ${args.markdownPath}`);

  if (args.check && failed.length > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
