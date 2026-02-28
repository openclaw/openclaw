import { spawnSync } from 'child_process';
import { argv } from 'process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Workload registry: defines built-in deterministic workloads
const WORKLOAD_REGISTRY: Record<string, { cmd: string; description: string }> = {
  x_cycle: {
    description: 'X automation growth cycle: poll → decide → act (deterministic)',
    cmd: 'npx tsx scripts/test-workload-x-cycle.ts',
  },
};

// Parse CLI arguments
let workloadId: string | undefined;
let cmd: string | undefined;

for (let i = 2; i < argv.length; i++) {
  const arg = argv[i];

  if (arg === '--workloadId') {
    workloadId = argv[i + 1];
    i++; // skip the value
  } else if (arg === '--cmd') {
    // Capture all remaining tokens from i+1 to end (not just the next one)
    cmd = argv.slice(i + 1).join(' ');
    break; // Exit loop since we've consumed everything after --cmd
  }
}

// If workloadId is provided but cmd is not, check registry for built-in workload
if (workloadId && !cmd) {
  const registered = WORKLOAD_REGISTRY[workloadId];
  if (registered) {
    cmd = registered.cmd;
  }
}

if (!workloadId || !cmd) {
  console.error('Missing required arguments.\n');
  console.error('Usage example (with built-in workload):');
  console.error('pnpm tsx scripts/run-paired-workload.ts --workloadId x_cycle\n');
  console.error('Usage example (with custom command):');
  console.error('pnpm tsx scripts/run-paired-workload.ts --workloadId demo1 --cmd "<agent command>"\n');
  console.error('Built-in workloads:');
  for (const [id, spec] of Object.entries(WORKLOAD_REGISTRY)) {
    console.error(`  ${id}: ${spec.description}`);
  }
  console.error('\nThis script runs baseline then gated automatically.');
  process.exit(1);
}

let failedRuns = 0;

// BASELINE RUN
console.log('\n=== BASELINE RUN ===\n');
const cwd = process.cwd();
const baselineDigest = `CLARITYBURST_RUN_DIGEST {workloadId="${workloadId}", mode="baseline", cmd="${cmd}", cwd="${cwd}"}`;
console.log(baselineDigest);
const baselineEnv = {
  ...process.env,
  CLARITYBURST_RUN_MODE: 'baseline',
  CLARITYBURST_WORKLOAD_ID: workloadId,
};

const baselineResult = spawnSync(cmd, {
  shell: true,
  env: baselineEnv,
  stdio: 'inherit',
});

if (baselineResult.status !== 0 && baselineResult.status !== null) {
  failedRuns++;
}

// GATED RUN
console.log('\n=== GATED RUN ===\n');
const gatedDigest = `CLARITYBURST_RUN_DIGEST {workloadId="${workloadId}", mode="gated", cmd="${cmd}", cwd="${cwd}"}`;
console.log(gatedDigest);
const gatedEnv = {
  ...process.env,
  CLARITYBURST_RUN_MODE: 'gated',
  CLARITYBURST_WORKLOAD_ID: workloadId,
};

const gatedResult = spawnSync(cmd, {
  shell: true,
  env: gatedEnv,
  stdio: 'inherit',
});

if (gatedResult.status !== 0 && gatedResult.status !== null) {
  failedRuns++;
}

// Exit with non-zero if either run failed
if (failedRuns > 0) {
  process.exit(1);
}

// Cost regression guard: load both claims files and compare
const baselineClaimsPath = join(cwd, 'docs/internal/clarityburst-run-claims', `${workloadId}.baseline.claims.json`);
const gatedClaimsPath = join(cwd, 'docs/internal/clarityburst-run-claims', `${workloadId}.gated.claims.json`);

let baselineClaims: Record<string, any> = {};
let gatedClaims: Record<string, any> = {};

try {
  const baselineContent = readFileSync(baselineClaimsPath, 'utf-8');
  baselineClaims = JSON.parse(baselineContent);
} catch {
  // File missing or unparseable; skip cost regression check
}

try {
  const gatedContent = readFileSync(gatedClaimsPath, 'utf-8');
  gatedClaims = JSON.parse(gatedContent);
} catch {
  // File missing or unparseable; skip cost regression check
}

// If both files loaded successfully, check for regressions
if (Object.keys(baselineClaims).length > 0 && Object.keys(gatedClaims).length > 0) {
  const primaryCounters = ['llmCalls', 'routerCalls', 'toolCalls', 'totalToolCalls', 'durationMs'];
  const fallbackCounters = ['tokensIn', 'tokensOut', 'totalTokens', 'subagentSpawns', 'retries'];
  const allCounters = [...primaryCounters, ...fallbackCounters];

  const regressions: Array<{ name: string; baseline: number; gated: number }> = [];
  let checkedCount = 0;

  for (const counter of allCounters) {
    const baselineVal = baselineClaims[counter];
    const gatedVal = gatedClaims[counter];

    // Only compare if both are present and numeric
    if (
      baselineVal !== undefined &&
      gatedVal !== undefined &&
      typeof baselineVal === 'number' &&
      typeof gatedVal === 'number'
    ) {
      checkedCount++;
      const delta = gatedVal - baselineVal;
      if (delta > 0) {
        regressions.push({ name: counter, baseline: baselineVal, gated: gatedVal });
      }
    }
  }

  if (regressions.length > 0) {
    const regressionParts = regressions.map((r) => `${r.name}=${r.baseline}->${r.gated}`).join(' ');
    console.log(`CLARITYBURST_COST_REGRESSION workloadId="${workloadId}" ${regressionParts}`);
    process.exitCode = 1;
  } else {
     console.log(`CLARITYBURST_COST_OK workloadId="${workloadId}" checked=${checkedCount}`);
  }
}

// Verify usage ledger invariants
console.log('\n=== VERIFYING USAGE LEDGER INVARIANTS ===\n');
const verifyResult = spawnSync('npx tsx scripts/verify-usage-ledger-invariants.ts', {
  shell: true,
  stdio: 'inherit',
});

if (verifyResult.status !== 0 && verifyResult.status !== null) {
  process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);
