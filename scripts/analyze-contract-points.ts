#!/usr/bin/env bun
/**
 * Contract Points Distribution Analyzer
 *
 * Analyzes all existing run artifacts from docs/internal/clarityburst-run-claims/
 * to produce concrete numbers for contract/decision inflection points per run.
 *
 * Outputs:
 * - CSV histogram to docs/internal/contract_points_histogram.csv
 * - Summary markdown to docs/internal/contract_points_summary.md
 * - Human-readable summary to stdout
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface ClaimsEntry {
  mode?: string;
  workloadId?: string;
  contractPointsTotal?: number;
  outcomes?: {
    proceeds?: number;
    abstains?: number;
    confirms?: number;
    modifies?: number;
  };
  [key: string]: unknown;
}

interface AnalysisResult {
  totalRuns: number;
  contractPoints: number[];
  minPoints: number;
  maxPoints: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  runsExceeding127: number;
  percentExceeding127: number;
  histogram: Record<string, number>;
}

/**
 * Calculate percentile from sorted array
 */
function calculatePercentile(sorted: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Extract contract points from a claims entry
 */
function extractContractPoints(entry: ClaimsEntry): number | null {
  // Prefer explicit contractPointsTotal if available
  if (entry.contractPointsTotal !== undefined && typeof entry.contractPointsTotal === "number") {
    return entry.contractPointsTotal;
  }

  // Fallback: compute from outcomes
  if (entry.outcomes) {
    const { proceeds = 0, abstains = 0, confirms = 0, modifies = 0 } = entry.outcomes;
    return proceeds + abstains + confirms + modifies;
  }

  return null;
}

/**
 * Load all claims JSON files from the specified directory
 */
function loadClaimsFiles(claimsDir: string): ClaimsEntry[] {
  const entries: ClaimsEntry[] = [];

  if (!fs.existsSync(claimsDir)) {
    console.warn(`Claims directory not found: ${claimsDir}`);
    return entries;
  }

  const files = fs.readdirSync(claimsDir);
  const claimsFiles = files.filter(
    (f) => f.endsWith(".baseline.claims.json") || f.endsWith(".gated.claims.json")
  );

  for (const file of claimsFiles) {
    const filePath = path.join(claimsDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (!content) {
        console.warn(`Skipping empty file: ${file}`);
        continue;
      }
      const entry = JSON.parse(content) as ClaimsEntry;
      entries.push(entry);
    } catch (err) {
      console.warn(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return entries;
}

/**
 * Generate histogram buckets
 */
function generateHistogram(points: number[]): Record<string, number> {
  const buckets: Record<string, number> = {
    "0-25": 0,
    "26-50": 0,
    "51-75": 0,
    "76-100": 0,
    "101-127": 0,
    "128-150": 0,
    "151-200": 0,
    "201-300": 0,
    "301-500": 0,
    "501+": 0,
  };

  for (const p of points) {
    if (p <= 25) buckets["0-25"]++;
    else if (p <= 50) buckets["26-50"]++;
    else if (p <= 75) buckets["51-75"]++;
    else if (p <= 100) buckets["76-100"]++;
    else if (p <= 127) buckets["101-127"]++;
    else if (p <= 150) buckets["128-150"]++;
    else if (p <= 200) buckets["151-200"]++;
    else if (p <= 300) buckets["201-300"]++;
    else if (p <= 500) buckets["301-500"]++;
    else buckets["501+"]++;
  }

  return buckets;
}

/**
 * Analyze contract points and generate statistics
 */
function analyzeContractPoints(claimsDir: string): AnalysisResult {
  const entries = loadClaimsFiles(claimsDir);

  // Extract contract points from all entries
  const contractPoints: number[] = [];
  for (const entry of entries) {
    const points = extractContractPoints(entry);
    if (points !== null) {
      contractPoints.push(points);
    }
  }

  if (contractPoints.length === 0) {
    return {
      totalRuns: 0,
      contractPoints: [],
      minPoints: 0,
      maxPoints: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      runsExceeding127: 0,
      percentExceeding127: 0,
      histogram: {},
    };
  }

  const sorted = contractPoints.slice().sort((a, b) => a - b);
  const minPoints = sorted[0];
  const maxPoints = sorted[sorted.length - 1];
  const p50 = calculatePercentile(sorted, 50);
  const p90 = calculatePercentile(sorted, 90);
  const p95 = calculatePercentile(sorted, 95);
  const p99 = calculatePercentile(sorted, 99);

  const runsExceeding127 = contractPoints.filter((p) => p > 127).length;
  const percentExceeding127 = Number(((runsExceeding127 / contractPoints.length) * 100).toFixed(2));

  const histogram = generateHistogram(contractPoints);

  return {
    totalRuns: contractPoints.length,
    contractPoints,
    minPoints,
    maxPoints,
    p50,
    p90,
    p95,
    p99,
    runsExceeding127,
    percentExceeding127,
    histogram,
  };
}

/**
 * Format analysis result as markdown summary
 */
function formatMarkdownSummary(result: AnalysisResult): string {
  const lines: string[] = [
    "# Contract Points Distribution Summary",
    "",
    "This document contains aggregate statistics about contract/decision inflection points",
    "across all OpenClaw agentic runs in the test suite.",
    "",
    "## Overview",
    "",
    `- **Total runs analyzed**: ${result.totalRuns}`,
    `- **Min contract points**: ${result.minPoints}`,
    `- **Max contract points**: ${result.maxPoints}`,
    "",
    "## Percentiles",
    "",
    `- **p50 (median)**: ${result.p50}`,
    `- **p90**: ${result.p90}`,
    `- **p95**: ${result.p95}`,
    `- **p99**: ${result.p99}`,
    "",
    "## Threshold Analysis (127 points)",
    "",
    `- **Runs exceeding 127 points**: ${result.runsExceeding127}`,
    `- **Percentage exceeding 127**: ${result.percentExceeding127}%`,
    "",
    "## Distribution by Bucket",
    "",
  ];

  const bucketOrder = [
    "0-25",
    "26-50",
    "51-75",
    "76-100",
    "101-127",
    "128-150",
    "151-200",
    "201-300",
    "301-500",
    "501+",
  ];

  for (const bucket of bucketOrder) {
    const count = result.histogram[bucket] ?? 0;
    const percent = result.totalRuns > 0 ? Number(((count / result.totalRuns) * 100).toFixed(1)) : 0;
    lines.push(`- **${bucket}**: ${count} runs (${percent}%)`);
  }

  lines.push("");
  lines.push("## Field Reference");
  lines.push("");
  lines.push(
    "Contract points are calculated as the sum of all decision outcomes per run:",
    "",
    "```",
    "contractPointsTotal = outcomes.proceeds + outcomes.abstains + outcomes.confirms + outcomes.modifies",
    "```",
    "",
    "- **PROCEED**: Decision point where the router cleared the request",
    "- **ABSTAIN_CLARIFY**: Decision point requiring clarification or routing failure",
    "- **ABSTAIN_CONFIRM**: Decision point requiring user confirmation",
    "- **MODIFY**: Decision point where the router modified the request",
    ""
  );

  return lines.join("\n");
}

/**
 * Format analysis result as CSV histogram
 */
function formatCsvHistogram(result: AnalysisResult): string {
  const lines: string[] = ["bucket,count,percentage"];

  const bucketOrder = [
    "0-25",
    "26-50",
    "51-75",
    "76-100",
    "101-127",
    "128-150",
    "151-200",
    "201-300",
    "301-500",
    "501+",
  ];

  for (const bucket of bucketOrder) {
    const count = result.histogram[bucket] ?? 0;
    const percent = result.totalRuns > 0 ? Number(((count / result.totalRuns) * 100).toFixed(2)) : 0;
    lines.push(`"${bucket}",${count},${percent}`);
  }

  return lines.join("\n");
}

/**
 * Format analysis result as human-readable summary for stdout
 */
function formatHumanSummary(result: AnalysisResult): string {
  const lines: string[] = [
    "=== Contract Points Distribution Analysis ===",
    "",
    `Total runs analyzed: ${result.totalRuns}`,
    "",
    "Statistics:",
    `  Min:     ${result.minPoints}`,
    `  Max:     ${result.maxPoints}`,
    `  p50:     ${result.p50}`,
    `  p90:     ${result.p90}`,
    `  p95:     ${result.p95}`,
    `  p99:     ${result.p99}`,
    "",
    `Runs exceeding 127 points: ${result.runsExceeding127} (${result.percentExceeding127}%)`,
    "",
    "Histogram:",
  ];

  const bucketOrder = [
    "0-25",
    "26-50",
    "51-75",
    "76-100",
    "101-127",
    "128-150",
    "151-200",
    "201-300",
    "301-500",
    "501+",
  ];

  for (const bucket of bucketOrder) {
    const count = result.histogram[bucket] ?? 0;
    const percent = result.totalRuns > 0 ? Number(((count / result.totalRuns) * 100).toFixed(1)) : 0;
    lines.push(`  ${bucket.padEnd(10)} ${String(count).padStart(4)} (${String(percent).padStart(5)}%)`);
  }

  return lines.join("\n");
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const claimsDir = path.join(process.cwd(), "docs/internal/clarityburst-run-claims");

  console.log(`Loading claims from: ${claimsDir}`);

  const result = analyzeContractPoints(claimsDir);

  if (result.totalRuns === 0) {
    console.warn("No claims files found. Skipping output generation.");
    return;
  }

  // Write markdown summary
  const summaryPath = path.join(process.cwd(), "docs/internal/contract_points_summary.md");
  const summaryMarkdown = formatMarkdownSummary(result);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, summaryMarkdown);
  console.log(`\nWrote summary: ${summaryPath}`);

  // Write CSV histogram
  const csvPath = path.join(process.cwd(), "docs/internal/contract_points_histogram.csv");
  const csvHistogram = formatCsvHistogram(result);
  fs.writeFileSync(csvPath, csvHistogram);
  console.log(`Wrote histogram: ${csvPath}`);

  // Print human-readable summary to stdout
  console.log("\n" + formatHumanSummary(result));
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
