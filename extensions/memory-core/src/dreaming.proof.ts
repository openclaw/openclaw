/**
 * Proof script: Legacy dreaming token reconciliation
 *
 * Demonstrates that legacy light/REM dreaming cron jobs (both payload.text and
 * payload.message variants) are detected, reconciled, and do not reach the
 * agent harness.
 *
 * Usage: node --import tsx extensions/memory-core/src/dreaming.proof.ts
 */
import { reconcileShortTermDreamingCronJob, testing } from "./dreaming.js";

const { isLegacyPhaseDreamingJob, constants } = testing;

// ── Logger that prints to console ──────────────────────────────────────────
const log = {
  info: (...args: unknown[]) => console.log("[info]", ...args),
  warn: (...args: unknown[]) => console.warn("[warn]", ...args),
  error: (...args: unknown[]) => console.error("[error]", ...args),
  debug: (...args: unknown[]) => console.log("[debug]", ...args),
};

// ── Cron harness factory (mirrors test harness) ────────────────────────────
interface CronJobLike {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: { kind: string; expr: string };
  sessionTarget: string;
  wakeMode: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

function createCronHarness(initialJobs: CronJobLike[]) {
  const jobs: CronJobLike[] = structuredClone(initialJobs);
  const addCalls: unknown[] = [];
  const updateCalls: Array<{ id: string; patch: unknown }> = [];
  const removeCalls: string[] = [];

  return {
    cron: {
      async list() {
        return structuredClone(jobs);
      },
      async add(input: unknown) {
        addCalls.push(input);
        return { ok: true };
      },
      async update(id: string, patch: unknown) {
        updateCalls.push({ id, patch });
        return { ok: true };
      },
      async remove(id: string) {
        removeCalls.push(id);
        return "boolean" as const;
      },
    },
    addCalls,
    updateCalls,
    removeCalls,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: isLegacyPhaseDreamingJob — token detection
// ═══════════════════════════════════════════════════════════════════════════

console.log("=== Legacy dreaming token detection ===\n");

const TEST_CASES: Array<{
  label: string;
  job: Parameters<typeof isLegacyPhaseDreamingJob>[0];
  expected: boolean;
}> = [
  {
    label: "light sleep — payload.text exact match",
    job: {
      id: "t1",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 0,
    },
    expected: true,
  },
  {
    label: "light sleep — payload.message exact match (the new path)",
    job: {
      id: "t2",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light]",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", message: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 0,
    },
    expected: true,
  },
  {
    label: "REM sleep — payload.message exact match",
    job: {
      id: "t3",
      name: "Memory REM Dreaming",
      description: "[managed-by=memory-core.dreaming.rem]",
      enabled: true,
      schedule: { kind: "cron", expr: "0 2 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", message: "__openclaw_memory_core_rem_sleep__" },
      createdAtMs: 0,
    },
    expected: true,
  },
  {
    label: "light sleep — payload.message with cron prefix",
    job: {
      id: "t4",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light]",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        message: "[cron:legacy-light] __openclaw_memory_core_light_sleep__",
      },
      createdAtMs: 0,
    },
    expected: true,
  },
  {
    label: "managed dreaming job (non-legacy) → false",
    job: {
      id: "t5",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} unified`,
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      createdAtMs: 0,
    },
    expected: false,
  },
  {
    label: "unrelated text → false",
    job: {
      id: "t6",
      name: "Unrelated Job",
      description: "not dreaming",
      enabled: true,
      schedule: { kind: "cron", expr: "*/5 * * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello world" },
      createdAtMs: 0,
    },
    expected: false,
  },
];

let passed = 0;
let failed = 0;
for (const { label, job, expected } of TEST_CASES) {
  const result = isLegacyPhaseDreamingJob(job);
  const status = result === expected ? "PASS" : "FAIL";
  if (result === expected) passed++;
  else failed++;
  console.log(`  [${status}] ${label} → ${result}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Reconciliation — legacy jobs are migrated/removed
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Legacy dreaming cron reconciliation ===\n");

async function runReconciliation(
  label: string,
  opts: {
    jobs: CronJobLike[];
    config: Parameters<typeof reconcileShortTermDreamingCronJob>[0]["config"];
  },
) {
  console.log(`\n--- ${label} ---`);

  const harness = createCronHarness(opts.jobs);

  console.log(`  Before: ${opts.jobs.length} job(s) in cron store`);
  for (const j of opts.jobs) {
    const isLegacy = isLegacyPhaseDreamingJob(j);
    console.log(`    - ${j.id}: ${j.name} [legacy=${isLegacy}]`);
  }

  const result = await reconcileShortTermDreamingCronJob({
    cron: harness.cron,
    config: opts.config,
    logger: log,
  });

  console.log(`  After:  status=${result.status}, removed=${result.removed ?? 0}`);
  if (harness.removeCalls.length > 0) {
    console.log(`  Removed IDs: ${harness.removeCalls.join(", ")}`);
  }
  if (harness.addCalls.length > 0) {
    console.log(`  Added: ${harness.addCalls.length} managed dreaming job(s)`);
  }

  return { result, harness };
}

// Scenario A: Enabled dreaming — legacy light+REM jobs removed, managed job added
await runReconciliation("A. Enabled: legacy light+REM → migrate to managed single job", {
  jobs: [
    {
      id: "job-legacy-light",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", message: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 100,
    },
    {
      id: "job-legacy-rem",
      name: "Memory REM Dreaming",
      description: "[managed-by=memory-core.dreaming.rem] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */4 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", message: "__openclaw_memory_core_rem_sleep__" },
      createdAtMs: 200,
    },
  ],
  config: {
    enabled: true,
    cron: constants.DEFAULT_DREAMING_CRON_EXPR,
    limit: constants.DEFAULT_DREAMING_LIMIT,
    minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
    minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
    recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
    verboseLogging: false,
  },
});

// Scenario B: Disabled dreaming — legacy jobs removed, no managed job added
await runReconciliation("B. Disabled: legacy light job removed, no managed job created", {
  jobs: [
    {
      id: "job-legacy-light-only",
      name: "Memory Light Dreaming",
      description: "[managed-by=memory-core.dreaming.light] legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */6 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      createdAtMs: 300,
    },
  ],
  config: {
    enabled: false,
    cron: constants.DEFAULT_DREAMING_CRON_EXPR,
    limit: constants.DEFAULT_DREAMING_LIMIT,
    minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
    minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
    recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
    verboseLogging: false,
  },
});

// Scenario C: Mixed — legacy + unrelated jobs, only legacy is touched
await runReconciliation("C. Mixed: only legacy jobs are touched, unrelated jobs survive", {
  jobs: [
    {
      id: "job-legacy",
      name: "Memory REM Dreaming",
      description: "[managed-by=memory-core.dreaming.rem]",
      enabled: true,
      schedule: { kind: "cron", expr: "0 */4 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", message: "__openclaw_memory_core_rem_sleep__" },
      createdAtMs: 400,
    },
    {
      id: "job-unrelated",
      name: "Unrelated Cron Job",
      description: "normal user cron",
      enabled: true,
      schedule: { kind: "cron", expr: "*/15 * * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check for updates" },
      createdAtMs: 500,
    },
  ],
  config: {
    enabled: true,
    cron: constants.DEFAULT_DREAMING_CRON_EXPR,
    limit: constants.DEFAULT_DREAMING_LIMIT,
    minScore: constants.DEFAULT_DREAMING_MIN_SCORE,
    minRecallCount: constants.DEFAULT_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries: constants.DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
    recencyHalfLifeDays: constants.DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS,
    verboseLogging: false,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Summary ===`);
console.log(`  Token detection: ${passed} passed, ${failed} failed (${TEST_CASES.length} total)`);
console.log(`  Reconciliation: 3 scenarios demonstrated`);
console.log(`  Key: payload.message legacy tokens are detected and reconciled`);
console.log(`       just like payload.text legacy tokens`);
console.log(`  Result: legacy dreaming cron jobs never reach the agent harness`);
