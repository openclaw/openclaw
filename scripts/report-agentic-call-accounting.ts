import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { argv } from 'process';

// Parse CLI arguments
let workloadId: string | undefined;
let mode: 'baseline' | 'gated' | 'both' = 'both';

for (let i = 2; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--workloadId') {
    workloadId = argv[i + 1];
    i++;
  } else if (arg === '--mode') {
    const modeVal = argv[i + 1];
    if (modeVal === 'baseline' || modeVal === 'gated' || modeVal === 'both') {
      mode = modeVal;
    }
    i++;
  }
}

if (!workloadId) {
  console.error('Missing required argument: --workloadId');
  console.error('Usage: pnpm tsx scripts/report-agentic-call-accounting.ts --workloadId <id> [--mode baseline|gated|both]');
  process.exit(1);
}

// Paths
const cwd = process.cwd();
const baselineClaimsPath = join(cwd, 'docs/internal/clarityburst-run-claims', `${workloadId}.baseline.claims.json`);
const gatedClaimsPath = join(cwd, 'docs/internal/clarityburst-run-claims', `${workloadId}.gated.claims.json`);

// Load claims
interface Claims {
  [key: string]: number | string | Record<string, any>;
}

let baselineClaims: Claims | null = null;
let gatedClaims: Claims | null = null;

if (mode === 'baseline' || mode === 'both') {
  try {
    const content = readFileSync(baselineClaimsPath, 'utf-8');
    baselineClaims = JSON.parse(content);
  } catch {
    baselineClaims = null;
  }
}

if (mode === 'gated' || mode === 'both') {
  try {
    const content = readFileSync(gatedClaimsPath, 'utf-8');
    gatedClaims = JSON.parse(content);
  } catch {
    gatedClaims = null;
  }
}

// Gracefully handle missing files
const baselineExists = existsSync(baselineClaimsPath);
const gatedExists = existsSync(gatedClaimsPath);

if (
  (mode === 'baseline' && !baselineExists) ||
  (mode === 'gated' && !gatedExists) ||
  (mode === 'both' && !baselineExists && !gatedExists)
) {
  console.log(`=== AGENTIC CYCLE CALL ACCOUNTING ===`);
  console.log(`workloadId: ${workloadId}`);
  console.log(`mode: ${mode}`);
  console.log(`status: missing`);
  process.exit(0);
}

// Print header
console.log(`=== AGENTIC CYCLE CALL ACCOUNTING ===`);
console.log(`workloadId: ${workloadId}`);
console.log(`mode: ${mode}`);
console.log();

// Print file status
if (mode === 'baseline' || mode === 'both') {
  console.log(`Baseline claims: ${baselineExists ? baselineClaimsPath : 'missing'}`);
}
if (mode === 'gated' || mode === 'both') {
  console.log(`Gated claims: ${gatedExists ? gatedClaimsPath : 'missing'}`);
}
console.log();

// Define counters to report
const primaryCounters = ['llmCalls', 'routerCalls', 'toolCalls', 'totalToolCalls', 'durationMs'];
const tokenCounters = ['tokensIn', 'tokensOut', 'totalTokens'];
const allCounters = [...primaryCounters, ...tokenCounters];

// Helper to extract numeric value
function getNumericValue(claims: Claims | null, key: string): number | null {
  if (!claims) return null;
  const val = claims[key];
  if (typeof val === 'number') return val;
  return null;
}

// Helper to format table
function formatTable(data: Array<{ name: string; baseline?: string; gated?: string; delta?: string }>) {
  if (data.length === 0) return;

  // Determine column widths
  const colName = Math.max(20, ...data.map((r) => r.name.length));
  const colBaseline = data.some((r) => r.baseline !== undefined) ? Math.max(12, 'BASELINE'.length) : 0;
  const colGated = data.some((r) => r.gated !== undefined) ? Math.max(12, 'GATED'.length) : 0;
  const colDelta = data.some((r) => r.delta !== undefined) ? Math.max(15, 'DELTA'.length) : 0;

  // Print header
  let header = `${String('Counter').padEnd(colName)}`;
  if (colBaseline > 0) header += `  ${String('BASELINE').padEnd(colBaseline)}`;
  if (colGated > 0) header += `  ${String('GATED').padEnd(colGated)}`;
  if (colDelta > 0) header += `  ${String('DELTA').padEnd(colDelta)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  // Print rows
  for (const row of data) {
    let line = row.name.padEnd(colName);
    if (colBaseline > 0) line += `  ${(row.baseline || '-').padEnd(colBaseline)}`;
    if (colGated > 0) line += `  ${(row.gated || '-').padEnd(colGated)}`;
    if (colDelta > 0) line += `  ${(row.delta || '-').padEnd(colDelta)}`;
    console.log(line);
  }
}

// Build totals table
const tableData: Array<{ name: string; baseline?: string; gated?: string; delta?: string }> = [];

for (const counter of allCounters) {
  const baselineVal = getNumericValue(baselineClaims, counter);
  const gatedVal = getNumericValue(gatedClaims, counter);

  // Only include if at least one value exists
  if (baselineVal !== null || gatedVal !== null) {
    const row: { name: string; baseline?: string; gated?: string; delta?: string } = { name: counter };

    if (baselineVal !== null) {
      row.baseline = String(baselineVal);
    }
    if (gatedVal !== null) {
      row.gated = String(gatedVal);
    }

    // Compute delta if both exist
    if (baselineVal !== null && gatedVal !== null) {
      const delta = gatedVal - baselineVal;
      const sign = delta >= 0 ? '+' : '';
      row.delta = `${sign}${delta}`;
    }

    tableData.push(row);
  }
}

if (tableData.length > 0) {
  console.log('TOTALS:');
  formatTable(tableData);
  console.log();
}

// Router effectiveness summary
const baselineRouterCalls = getNumericValue(baselineClaims, 'routerCalls');
const gatedRouterCalls = getNumericValue(gatedClaims, 'routerCalls');

console.log('ROUTER EFFECTIVENESS:');
console.log(`  Definition: "router hits per cycle" = routerCalls (count of router API calls)`);

if (baselineRouterCalls !== null) {
  console.log(`  Baseline: ${baselineRouterCalls} router calls`);
}
if (gatedRouterCalls !== null) {
  console.log(`  Gated: ${gatedRouterCalls} router calls`);
}

if (baselineRouterCalls !== null && gatedRouterCalls !== null) {
  const delta = gatedRouterCalls - baselineRouterCalls;
  const sign = delta >= 0 ? '+' : '';
  console.log(`  Delta (baseline→gated): ${sign}${delta}`);
}
console.log();

// Audit trail
console.log('AUDIT TRAIL:');
console.log(`  Evidence location: OpenClaw/ClarityBurst claims artifacts`);
console.log(`  Claims JSON fields used: ${allCounters.filter((c) => tableData.some((r) => r.name === c)).join(', ')}`);
console.log(`  External tool logs (Zapier-style): NOT included in these artifacts`);
console.log();

// Optional breakdowns
const breakdownFields = ['contractId', 'contractPack', 'DIP', 'toolName'];
let hasBreakdowns = false;

for (const mode_name of (() => {
  if (mode === 'both') return ['baseline', 'gated'];
  return [mode];
})()) {
  const claims = mode_name === 'baseline' ? baselineClaims : gatedClaims;
  if (!claims) continue;

  // Check for tool counts or contract breakdowns
  const toolCounts: Record<string, number> = {};
  const contractCounts: Record<string, number> = {};
  const contractPackCounts: Record<string, number> = {};

  // Try to extract from structured fields if they exist
  for (const [key, value] of Object.entries(claims)) {
    if (key.startsWith('tool_') && typeof value === 'number') {
      const toolName = key.replace(/^tool_/, '').replace(/_/g, ' ');
      toolCounts[toolName] = value;
      hasBreakdowns = true;
    }
    if (key.startsWith('contract_') && typeof value === 'number') {
      const contractId = key.replace(/^contract_/, '');
      contractCounts[contractId] = value;
      hasBreakdowns = true;
    }
    if (key.startsWith('pack_') && typeof value === 'number') {
      const packName = key.replace(/^pack_/, '').replace(/_/g, ' ');
      contractPackCounts[packName] = value;
      hasBreakdowns = true;
    }
  }

  // Print breakdowns if found
  if (Object.keys(toolCounts).length > 0) {
    console.log(`TOOL INVOCATIONS (${mode_name}):`);
    const sorted = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [tool, count] of sorted) {
      console.log(`  ${tool}: ${count}`);
    }
    console.log();
  }

  if (Object.keys(contractCounts).length > 0) {
    console.log(`CONTRACT CALLS (${mode_name}):`);
    const sorted = Object.entries(contractCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [contract, count] of sorted) {
      console.log(`  ${contract}: ${count}`);
    }
    console.log();
  }

  if (Object.keys(contractPackCounts).length > 0) {
    console.log(`CONTRACT PACKS (${mode_name}):`);
    const sorted = Object.entries(contractPackCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [pack, count] of sorted) {
      console.log(`  ${pack}: ${count}`);
    }
    console.log();
  }
}

process.exit(0);
