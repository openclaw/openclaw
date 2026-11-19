import { isDeepStrictEqual } from "node:util";
import { compareAscii } from "./canonical-json.mjs";
import { parseNodeFailureReport } from "./ci-node-test-evidence.mjs";

// The beta.3 owner accepted these observed failures on 2026-11-14 at 13:30 UTC.
// CI aggregate causes use workflow job keys, not displayed shard names.
const BETA3_CI_FAILURES = new Map([
  ["checks-ui (3/3)", "checks-ui"],
  ["android-screenshots", "android-screenshots"],
  ["checks-node-agentic-agents-core-runtime", "checks-node-core-test-nondist-shard"],
  ["checks-node-agentic-control-plane-runtime-state", "checks-node-core-test-nondist-shard"],
]);
const BETA3_DOCKER_JOB = "Run Docker release-path validation / Docker E2E (package/update OpenAI)";
const STABLE_114_TARGET_SHA = "5eb2d8052ddc363245bea3ca4ec0833815ab6e93";
const STABLE_114_CI_FAILURES = new Map([
  ["checks-node-agentic-control-plane-runtime-state", "checks-node-core-test-nondist-shard"],
  ["checks-ui-e2e-real-gateway (1/2)", "checks-ui-e2e-real-gateway"],
  ["macos-swift (tests)", "macos-swift"],
]);

const STABLE_114_D843_TARGET_SHA = "d843d6af39a42cd3c30084edbeabeece732fd93a";
const STABLE_114_D843_CI_FAILURES = new Map([
  ["checks-node-agentic-gateway-server-isolated-4", "checks-node-core-test-nondist-shard"],
]);

// Observed failed leaves from FRV 44290981153 and 44310687628; cancelled
// workloads are deliberately absent. These are job-level, not test-level grants.
const STABLE_116_CI_FAILURES = new Map([
  ...[
    "checks-node-compact-large-16 (node)",
    "checks-node-compact-large-28 (bun)",
    "checks-node-compact-large-28 (node)",
    "checks-node-compact-large-31 (node)",
    "checks-node-compact-large-32 (bun)",
    "checks-node-compact-large-37 (bun)",
    "checks-node-compact-large-42 (bun)",
    "checks-node-compact-large-8 (node)",
    "checks-node-compact-small-12 (node)",
  ].map((name) => [name, "checks-node-core-test-nondist-shard"]),
  ["checks-node-compat-node24", "checks-node-compat"],
  ["checks-ui (3/3)", "checks-ui"],
  ["checks-ui-e2e (10/13)", "checks-ui-e2e"],
  ["checks-ui-e2e-real-gateway (2/2)", "checks-ui-e2e-real-gateway"],
]);

// Exact mobile job names and their CI gate keys; no Gateway or desktop jobs.
const EXTENDED_1033_MOBILE_JOBS = new Map([
  ["ios-screenshots-iphone", "ios-screenshot-shard"],
  ["ios-screenshots-ipad-13", "ios-screenshot-shard"],
  ["ios-screenshots", "ios-screenshot-capture"],
  ["ios-screenshot-evidence", "ios-screenshot-evidence"],
  ["ios-build (release)", "ios-build"],
  ["ios-build (tests)", "ios-build"],
  ["ios-build (smoke)", "ios-build"],
  ["ios-release-e2e / qualify", "ios-release-e2e"],
  ["android-release-e2e / qualify", "android-release-e2e"],
  ["android-test-play", "android"],
  ["android-test-third-party", "android"],
  ["android-test-wear", "android"],
  ["android-build-play", "android"],
  ["android-build-wear", "android"],
  ["android-ktlint", "android"],
  ["android-screenshots", "android-screenshots"],
  ["android-access-native (4096, google_apis)", "android-access-native"],
  ["android-access-native (16384, google_apis_ps16k)", "android-access-native"],
]);

// Reviewed release-tooling policy, loaded from P, never the candidate checkout.
// Add an exact version, child role, job name, and reason here to grant a waiver.
/** @type {import("./release-validation-waivers.mjs").ReleaseValidationWaiver[]} */
const RELEASE_VALIDATION_WAIVERS = [
  ...[...STABLE_116_CI_FAILURES.keys()].map((jobName) => ({
    targetVersion: "2026.11.6",
    childRole: "normalCi",
    jobName,
    reason:
      "Accept the observed 2026.11.6 CI leaf failure while retaining raw results, required execution, aggregate cause validation, and integrity gates.",
  })),
  ...[
    "Run repo/live E2E validation / Gateway E2E / Repo E2E (Gateway 3/4)",
    "Run repo/live E2E validation / Native live suites (Native live agents)",
    "Run repo/live E2E validation / Native live suites (Native live gateway core)",
    "Run repo/live E2E validation / Native live suites (Native live gateway OpenAI GPT-5.6 Ultra)",
    "Run repo/live E2E validation / Native live suites (Native live test harnesses)",
    "Run repo/live E2E validation / UI and plugin E2E / Repo E2E (UI 2/4)",
  ].map((jobName) => ({
    targetVersion: "2026.11.6",
    childRole: "releaseChecksIndependent",
    jobName,
    reason:
      "Accept the observed 2026.11.6 repo/live leaf failure while retaining raw results, required execution, aggregate cause validation, and integrity gates.",
  })),
  {
    targetVersion: "2026.11.10-beta.1",
    childRole: "normalCi",
    jobName: "checks-node-compact-large-39 (bun)",
    testFailures: {
      stepName: "Run Node test shard",
      signatures: [
        {
          kind: "vitest",
          file: "src/agents/agent-bundle-mcp-instructions-prompt.test.ts",
          test: "embedded system prompt MCP server instructions > neutralizes application prompt delimiters in server instructions :: Error: listen EADDRINUSE: address already in use 127.0.0.1:20056\n❯ <anonymous> internal:net/server:24:5",
        },
      ],
    },
    reason:
      "Dallin Romney authorized known low-risk FRV10/11 test-tooling failures on 2026-11-18 at 16:23 UTC. This grants only the exact MCP fixture listener collision recorded in FRV11 (44290065577/1), including the complete failure signature and completed invocation evidence. It is accepted failure, not a passing test or proof that a replay fixed the original incident. Extra or changed failures, setup errors, incomplete/missing/cancelled coverage, and serious product defects remain blocking. Preserve raw failures and reasons.",
  },
  {
    targetVersion: "2026.11.10-beta.1",
    childRole: "normalCi",
    jobName: "checks-node-compact-large-41 (node)",
    testFailures: {
      stepName: "Run Node test shard",
      signatures: [
        {
          kind: "vitest",
          file: "src/cron/service/command-timeout.test.ts",
          test: 'scheduled command timeouts > settles a real command after deadline without late delivery :: AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string\n❯ src/cron/service/command-timeout.test.ts:101:32\n99|           expect.objectContaining({ source: "exec", severity: "error" …\n100|         );\n101|         expect(result.summary).toContain("synthetic progress");\n|                                ^\n102|         expect(result.summary).toContain("synthetic stderr");\n103|         const pid = Number(result.summary?.match(/pid=(\\d+)/)?.[1]);',
        },
      ],
    },
    reason:
      "Dallin Romney authorized known low-risk FRV10/11 test-tooling failures on 2026-11-18 at 16:23 UTC. This grants only the exact cron fixture pre-output summary assertion recorded in FRV11 (44290065577/1), including the complete failure signature and completed invocation evidence. It is accepted failure, not a passing test or proof that a replay fixed the original incident. Extra or changed failures, setup errors, incomplete/missing/cancelled coverage, and serious product defects remain blocking. Preserve raw failures and reasons.",
  },

  {
    targetVersion: "2026.11.6",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized the 2026.11.6 Kova waiver on " +
      "2026-11-18 at 06:30 UTC while requiring continued cold-turn investigation. " +
      "The prior cold-turn comparison showed a 13341 ms median versus 6515 ms " +
      "on 2026.11.5; transient noise or a causal regression is not established. " +
      "This release-wide grant accepts only the named Kova threshold failures, " +
      "not evidence of a fix or non-regression. Preserve raw measurements and " +
      "required execution; no threshold changes or not-run exemption. Other " +
      "jobs, missing or cancelled evidence, build/setup, crashes, correctness, " +
      "isolation, data integrity, install/update and publication gates remain blocking.",
  },
  {
    targetVersion: "2026.10.33",
    childRole: "releaseChecksCandidate",
    jobName: "Run package acceptance / Telegram package acceptance / Run package Telegram E2E",
    reason:
      "Dallin Romney explicitly waived Telegram package recovery for 2026.10.33 " +
      "on 2026-11-17 at 15:06 UTC after FRV 44090632483/1, job 134090325822. " +
      "This accepts only the named terminal failed job across candidates and attempts; " +
      "its underlying onboarding error remains undiagnosed, not fixed or proven flaky. " +
      "Preserve execution and raw evidence. Other jobs, missing or cancelled evidence, " +
      "artifact integrity, install/update gates and publication remain blocking.",
  },
  {
    targetVersion: "2026.10.33",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized all performance/Kova failures for " +
      "2026.10.33 on 2026-11-17 at 02:49 UTC after reviewing FRV 43995308737/1, " +
      "child 43995795283/1 and the retained 2026.11.4 comparison. This accepts " +
      "the observed RSS, CPU, event-loop and pre-provider latency failures, " +
      "including higher many-plugin CPU; lower Gateway RSS is not a claim of " +
      "overall non-regression. This release-wide grant covers the named terminal " +
      "failed Kova job across candidates and attempts. Preserve raw results and " +
      "required execution; no threshold changes or not-run exemption. Other " +
      "jobs, missing or cancelled evidence, native tests, integrity, install/update " +
      "and publication gates remain blocking.",
  },
  ...[...EXTENDED_1033_MOBILE_JOBS.keys()].map((jobName) => ({
    targetVersion: "2026.10.33",
    childRole: "normalCi",
    jobName,
    reason:
      "Dallin Romney explicitly authorized all iOS and Android validation failures " +
      "for 2026.10.33 on 2026-11-17 at 03:14 UTC, reaffirming the 03:12 grant, because " +
      "extended-stable publishes " +
      "Gateway npm/plugins/Docker, not mobile apps. This supersedes the screenshot-only " +
      "grant of 2026-11-16 at 22:14 UTC. It includes the observed Android build timeout, " +
      "iOS Access-restart configuration selection failure, and iOS pairing/chat timeouts " +
      "from FRV 43995308737/1 and replay 44001867099/1; these are accepted failures, " +
      "not passing tests. Preserve raw results and required execution across candidates " +
      "and attempts. No missing/cancelled evidence exemption. Gateway, desktop, package, " +
      "integrity, install/update and publication gates remain blocking.",
  })),
  {
    targetVersion: "2026.11.5",
    childRole: "releaseChecksCandidate",
    jobName: "Run package acceptance / Telegram package acceptance / Run package Telegram E2E",
    reason:
      "Dallin Romney explicitly authorized this Telegram package-job waiver on " +
      "2026-11-16 at 18:20 UTC. FRV 43898101600/1, child 43902860005/1, job " +
      "133430641645 passed the first 15 scenarios, then failed the quiet-progress " +
      "assertion in scenario 16. Provider success and exactly-once final delivery " +
      "passed before that assertion; all 18 Telegram plugin shards and the separate " +
      "live Telegram lane passed. The candidate permits bounded Exec status text " +
      "that differs from the frozen qualification assertion, supporting a test-contract " +
      "mismatch rather than demonstrated P0/P1 delivery loss. Actual offending message " +
      "text was not retained, so a display or detail-exposure defect is not ruled out. " +
      "Later package scenarios were not proved by that failed run. Retain raw failures " +
      "and required execution; no not-run exemption. This accepts only the named " +
      "terminal failed job for this release, not other Gateway/native failures, " +
      "cancelled or missing evidence, credentials, integrity, install/update, " +
      "or publication gates.",
  },
  {
    targetVersion: "2026.11.5",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized the 2026.11.5 performance waiver on " +
      "2026-11-16 at 18:13 UTC after reviewing FRV 43898101600/1, child " +
      "43899049574/1: all 15 runs exceeded RSS budgets, including gateway " +
      "1418.1-1521 MB versus 1177/1193 MB and agent 1385-1456.7 MB versus " +
      "1150 MB. One CPU interval was inconclusive. Baseline parity with " +
      "2026.11.4 is unverified; this is explicit acceptance, not non-regression proof. " +
      "This release-wide grant covers only the named Kova threshold failures. " +
      "Retain raw failures and reports; no global budget changes or not-run exemption. " +
      "Other jobs, missing or cancelled evidence, build/setup, crashes, correctness, " +
      "isolation, data integrity, install/update and publication gates remain blocking.",
  },
  ...[
    {
      childRole: "normalCi",
      jobName: "checks-node-agentic-gateway-server-isolated-4",
    },
    {
      childRole: "releaseChecksIndependent",
      jobName: "Run repo/live E2E validation / Native live suites (Native live gateway core)",
    },
  ].map(({ childRole, jobName }) => ({
    childRole,
    jobName,
    targetVersion: "2026.11.4",
    targetSha: STABLE_114_D843_TARGET_SHA,
    reason:
      "Dallin Romney explicitly authorized these two failures on 2026-11-15 at 21:50 UTC " +
      "for unchanged C/Q d843d6af39a42cd3c30084edbeabeece732fd93a. " +
      "FRV 43759426550/1: child 43759963756/1 job 132952700537 recorded a catalog " +
      "warm ownership-file read; child 43759969390/1 job 132953160694 recorded a " +
      "missing required native read. Both original failures remain unresolved; " +
      "catalog diagnostic replays are not a fix and the native replay was quota-blocked. " +
      "Retain raw errors and artifacts. This grant accepts only the named terminal " +
      "failed jobs on this exact candidate, not a test pass, not-run exemption or " +
      "historical evidence relabeling. All other jobs, candidates, versions, required " +
      "coverage, identity, integrity and publication approval remain blocking.",
  })),
  ...["Native live gateway core", "Native live test harnesses"].map((suite) => ({
    targetVersion: "2026.11.4",
    targetSha: "e283dccf68ba35ef1af5b3fa31571db7f4b6bc74",
    childRole: "releaseChecksIndependent",
    jobName: `Run repo/live E2E validation / Native live suites (${suite})`,
    reason:
      "Dallin Romney explicitly authorized these two native-live failures on " +
      "2026-11-15 at 15:03 UTC for unchanged C/Q e283dccf68ba35ef1af5b3fa31571db7f4b6bc74. " +
      "Observed child 43719709063/1 failed gateway core and test harnesses; " +
      "the original failures remain unresolved. Retain raw failures and artifacts. " +
      "This grant accepts only the named terminal failed jobs on this exact candidate. " +
      "Ordinary green-only child reuse is unchanged; fresh executions of these jobs " +
      "on this candidate may use the grant. There is no not-run exemption. Other " +
      "jobs, versions, candidates, incomplete evidence, identity, integrity and " +
      "publication approval remain blocking.",
  })),
  ...[...STABLE_114_CI_FAILURES.keys()].map((jobName) => ({
    targetVersion: "2026.11.4",
    targetSha: STABLE_114_TARGET_SHA,
    childRole: "normalCi",
    jobName,
    reason:
      "Dallin Romney explicitly waived the three remaining failures on " +
      "2026-11-15 at 04:13 UTC, retaining candidate " +
      STABLE_114_TARGET_SHA +
      " for fresh qualification, reseal and publication of 2026.11.4. " +
      "Diagnostic origin FRV 43641896010/1 tested old candidate " +
      "005030c3a09843601af3de546dbff77240175a66, not this candidate. " +
      "This grant accepts only the named terminal failed job on the fixed candidate; " +
      "retain raw failures. There is no not-run exemption or historical evidence reuse. " +
      "Other jobs, versions, candidates, skipped, cancelled, timed-out or incomplete " +
      "evidence, identity, integrity and publication approval remain blocking.",
  })),
  ...[...BETA3_CI_FAILURES.keys(), BETA3_DOCKER_JOB].map((jobName) => ({
    targetVersion: "2026.11.5-beta.3",
    childRole: jobName === BETA3_DOCKER_JOB ? "releaseChecksCandidate" : "normalCi",
    jobName,
    reason:
      "Dallin Romney explicitly accepted the remaining beta.3 failures on " +
      "2026-11-14 at 13:30 UTC and requested beta-profile qualification at 13:31 UTC. " +
      "Observed in FRV 43594812558/1: UI reply navigation, Android Overview startup, " +
      "Google Decision deadline, Gateway RPC timeouts, and Docker Codex followthrough " +
      "without a configured message channel. This grant matches only this version, " +
      "child role and named failed job; it accepts that job's failures, not a test pass. " +
      "Retain raw evidence. Missing, cancelled, other jobs, package identity, " +
      "artifact integrity and publication authorization remain blocking.",
  })),
  {
    targetVersion: "2026.11.5-beta.3",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized a release-wide 2026.11.5-beta.3 " +
      "performance waiver on 2026-11-13 at 20:19 UTC, including CPU, latency " +
      "and RSS, superseding the prior RSS-only scope. This matches only the " +
      "exact release version, productPerformance role and failed Kova job. " +
      "Retain raw failures and reports; there is no not-run exemption. " +
      "Other jobs, missing or cancelled evidence, build/setup, crash, " +
      "correctness, isolation, data-integrity and install/update gates remain blocking.",
  },
  {
    targetVersion: "2026.9.37",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    evidence: { runId: "42361846301", runAttempt: 1 },
    qualificationExemption: {
      targetSha: "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8",
      runId: 42361846301,
      runAttempt: 1,
      workflowRef: "release-ci/5ca478fb3d02-110230586240863827911794045203864",
      sourceParentRunId: "42361691019",
      sourceParentAttempt: 1,
      artifactId: 13570296857,
      artifactDigest: "sha256:3d4c6c1be8b31c2fac6dc636d4b72e5e920d5feaca80711d1f81fca6f737bfe6",
      artifactSizeBytes: 1104,
      receiptSha256: "5f52379d07a1cef385b598142889ec56514c99afc4575f1643442227bd5a53be",
    },
    reason:
      "Dallin Romney authorized the 2026.9.37 performance exception on " +
      "2026-11-07 at 17:08 UTC (FRV 42361691019/1; C/Q " +
      "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8). The retained report " +
      "kova-261107-095817-423747 has only the bundled-plugin-startup " +
      "gateway maxCpuPercent breach (483 > 360). Only this reviewed child " +
      "attempt is waived; retain its raw failure and report. Other failures, " +
      "missing evidence, and later attempts remain blocking. At 17:49 UTC " +
      "the operator additionally authorized a new candidate qualification " +
      "with performance explicitly waived-not-run. The old receipt supports " +
      "that exception only; it does not measure or qualify the new candidate.",
  },
  {
    targetVersion: "2026.11.4",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized a release-wide 2026.11.4 performance " +
      "waiver on 2026-11-13 at 13:06 UTC, superseding the prior run-specific grant. " +
      "Like 2026.11.2 and 2026.11.3, this matches the exact version, child role, " +
      "and failed Kova job across all runs, attempts, and candidates for this release; " +
      "it does not classify individual performance metrics within that job. " +
      "Retain raw failures and reports. There is no not-run exemption. Other failed " +
      "jobs, missing or cancelled evidence, and crash, correctness, isolation, " +
      "data-integrity, and install/update gates remain blocking.",
  },
  {
    targetVersion: "2026.11.3",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized the 2026.11.3 Kova waiver on " +
      "2026-11-10 at 03:34 UTC after reviewing FRV 42733555990/1, child " +
      "42734139245/1 on prior C fb9ce54d: RSS 1809.8-1819.6 MB > 1800 MB, " +
      "peak gateway CPU 433.7% > 340%, and process-tree CPU 467.4% > 360%. " +
      "Like 2026.11.2, this matches the exact version, child role, and failed " +
      "Kova job; it does not classify individual metrics within that job. " +
      "Retain raw failures. The prior run does not qualify new C 40223c5cc262; " +
      "there is no not-run exemption. Other failed jobs, missing or cancelled " +
      "evidence, and all other normal release gates remain blocking.",
  },
  {
    targetVersion: "2026.11.2",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney authorized 2026.11.2-only Kova CPU/RSS threshold leniency on " +
      "2026-11-07 at 00:28 UTC (FRV 42308858515, kova-261106-230743-bd1e4d). " +
      "Retain raw failed performance evidence; crash, correctness, isolation, " +
      "data-integrity, and install/update failures remain blocking.",
  },
  {
    targetVersion: "2026.11.1",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Operator-authorized 2026.11.1-only leniency: Kova CPU and RSS thresholds exceeded " +
      "(FRV 41800680256 run kova-261104-084310-8bd049); crash, correctness, isolation, " +
      "data-integrity, and install/update failures stay blocking and are checked in the report.",
  },
  {
    targetVersion: "2026.11.1",
    childRole: "releaseChecksIndependent",
    jobName: "Run repo/live E2E validation / validate_release_live_cache",
    reason:
      "OpenRouter returned HTTP 402 for the release key (FRV 41881174354 job on C 3a4983e15f96); " +
      "billing failure at the last provider, tracked in the 2026.11.1 release handoff.",
  },
];

// This is an explicit not-run disposition for a new C/Q, not reuse of the old
// measurement. Only P may seal it into independently authenticated coverage.
export function releaseQualificationExemptions(targetVersion, profile) {
  if (!["stable", "full"].includes(profile)) {
    return [];
  }
  return RELEASE_VALIDATION_WAIVERS.filter(
    (waiver) => waiver.targetVersion === targetVersion && waiver.qualificationExemption,
  ).map((waiver) => ({
    childRole: waiver.childRole,
    targetVersion: waiver.targetVersion,
    disposition: "waived-not-run",
    reason: waiver.reason,
    supportingEvidence: waiver.qualificationExemption,
  }));
}

export function validateQualificationExemptions(exemptions, targetVersion, profile) {
  if (!isDeepStrictEqual(exemptions, releaseQualificationExemptions(targetVersion, profile))) {
    throw new Error("Qualification exemptions differ from current release-tooling policy");
  }
}

const SUCCESSFUL_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const RELEASE_CHECK_ROLES = new Set([
  "releaseChecks",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
]);

export function isFailedReleaseJob(job) {
  return job.status === "completed" && !SUCCESSFUL_CONCLUSIONS.has(job.conclusion);
}

const WINDOWS_NODE_STABLE_JOB =
  "Run Windows-node stable E2E / Setup, connect, and invoke candidate gateway";
const WINDOWS_NODE_ADVISORY_JOBS = new Set([
  "Resolve Windows-node main source",
  "Run Windows-node prerelease E2E / Setup, connect, and invoke candidate gateway",
  "Run Windows-node main E2E / Setup, connect, and invoke candidate gateway",
]);

function isReleaseAdvisoryJob(childKey, job) {
  return (
    childKey === "releaseChecksCandidate" &&
    (WINDOWS_NODE_ADVISORY_JOBS.has(job.name) ||
      (job.status === "completed" &&
        job.conclusion === "skipped" &&
        ["Run Windows-node prerelease E2E", "Run Windows-node main E2E"].includes(job.name)))
  );
}

export function releaseChildAdvisories(child) {
  if (child.key !== "releaseChecksCandidate") {
    return [];
  }
  const stableRan = child.jobs.some(
    (job) => job.name === WINDOWS_NODE_STABLE_JOB && job.conclusion !== "skipped",
  );
  return child.jobs
    .filter(
      (job) =>
        isReleaseAdvisoryJob(child.key, job) &&
        (isFailedReleaseJob(job) || (stableRan && job.conclusion === "skipped")),
    )
    .map((job) => ({
      class: "windows-node-preview",
      child: child.key,
      job: job.name,
      conclusion: job.conclusion,
      runId: String(child.runId),
      url: job.html_url ?? job.url ?? "",
    }))
    .toSorted((left, right) => compareAscii(left.job, right.job));
}

const KOVA_PERFORMANCE_JOB = "Kova mock provider performance";

function aggregateCauses(waiver) {
  if (waiver.testFailures) {
    return [
      {
        jobName: "openclaw/ci-gate",
        stepName: "Verify selected CI lanes",
        causes: ["checks-node-core-test-nondist-shard finished with failure (selected=true)"],
        exactCauses: true,
      },
    ];
  }
  if (
    waiver.targetVersion === "2026.11.6" &&
    waiver.childRole === "normalCi" &&
    STABLE_116_CI_FAILURES.has(waiver.jobName)
  ) {
    return [
      {
        jobName: "openclaw/ci-gate",
        stepName: "Verify selected CI lanes",
        causes: [
          STABLE_116_CI_FAILURES.get(waiver.jobName) + " finished with failure (selected=true)",
        ],
        exactCauses: true,
      },
    ];
  }
  if (
    waiver.targetVersion === "2026.10.33" &&
    waiver.childRole === "normalCi" &&
    EXTENDED_1033_MOBILE_JOBS.has(waiver.jobName)
  ) {
    return [
      {
        jobName: "openclaw/ci-gate",
        stepName: "Verify selected CI lanes",
        causes: [
          EXTENDED_1033_MOBILE_JOBS.get(waiver.jobName) + " finished with failure (selected=true)",
        ],
        exactCauses: true,
      },
    ];
  }
  const stableCiFailures =
    waiver.targetSha === STABLE_114_TARGET_SHA
      ? STABLE_114_CI_FAILURES
      : waiver.targetSha === STABLE_114_D843_TARGET_SHA
        ? STABLE_114_D843_CI_FAILURES
        : undefined;
  if (
    waiver.targetVersion === "2026.11.4" &&
    waiver.childRole === "normalCi" &&
    stableCiFailures?.has(waiver.jobName)
  ) {
    return [
      {
        jobName: "openclaw/ci-gate",
        stepName: "Verify selected CI lanes",
        causes: [stableCiFailures.get(waiver.jobName) + " finished with failure (selected=true)"],
        exactCauses: true,
      },
    ];
  }
  if (waiver.targetVersion === "2026.11.5-beta.3") {
    if (waiver.childRole === "normalCi" && BETA3_CI_FAILURES.has(waiver.jobName)) {
      return [
        {
          jobName: "openclaw/ci-gate",
          stepName: "Verify selected CI lanes",
          causes: [
            `${BETA3_CI_FAILURES.get(waiver.jobName)} finished with failure (selected=true)`,
          ],
        },
      ];
    }
    if (waiver.childRole === "releaseChecksCandidate" && waiver.jobName === BETA3_DOCKER_JOB) {
      return [
        {
          jobName: "Verify release checks",
          stepName: "Verify release check results",
          causes: ["docker_e2e_release_checks ended with failure"],
        },
      ];
    }
  }
  if (waiver.childRole === "npmTelegram" && waiver.jobName === "Run package Telegram E2E") {
    return [];
  }
  if (waiver.childRole === "productPerformance" && waiver.jobName === KOVA_PERFORMANCE_JOB) {
    return [];
  }
  if (RELEASE_CHECK_ROLES.has(waiver.childRole)) {
    let cause;
    const aggregates = [];
    if (waiver.jobName.startsWith("Run repo/live E2E validation / ")) {
      cause = "live_repo_e2e_release_checks ended with failure";
    } else if (waiver.jobName === "Run QA Lab live Telegram lane") {
      cause = "qa_live_telegram_release_checks ended with failure";
    } else if (
      waiver.jobName ===
      "Run package acceptance / Telegram package acceptance / Run package Telegram E2E"
    ) {
      cause = "package_acceptance_release_checks ended with failure";
      aggregates.push({
        jobName: "Run package acceptance / Verify package acceptance",
        stepName: "Verify package acceptance results",
        causes: ["package_telegram ended with failure"],
      });
    }
    if (cause) {
      return [
        ...aggregates,
        {
          jobName: "Verify release checks",
          stepName: "Verify release check results",
          causes: [cause],
          ...(waiver.targetVersion === "2026.11.6" ||
          (waiver.targetVersion === "2026.11.4" && waiver.targetSha === STABLE_114_D843_TARGET_SHA)
            ? { exactCauses: true }
            : {}),
        },
      ];
    }
  }
  throw new Error(`Release waiver is not a live-provider/Telegram job: ${waiver.jobName}`);
}

// Raw leaf and workflow conclusions are never rewritten. The caller owns the
// aggregate validation verdict and must also authenticate failed aggregate logs.
export function evaluateReleaseChildPolicy({ child, targetVersion, targetSha }) {
  const waivers = RELEASE_VALIDATION_WAIVERS.filter(
    (waiver) =>
      waiver.targetVersion === targetVersion &&
      (waiver.targetSha === undefined || waiver.targetSha === targetSha) &&
      waiver.childRole === child.key &&
      // A reviewed historical failure never grants leniency to a new execution.
      (!waiver.evidence ||
        (waiver.evidence.runId === child.runId &&
          waiver.evidence.runAttempt === child.runAttempt)) &&
      child.jobs.some(
        (job) =>
          job.name === waiver.jobName && job.status === "completed" && job.conclusion === "failure",
      ),
  );
  const aggregates = new Map();
  for (const waiver of waivers) {
    for (const aggregate of aggregateCauses(waiver)) {
      const existing = aggregates.get(aggregate.jobName);
      if (existing) {
        existing.causes = [...new Set([...existing.causes, ...aggregate.causes])];
      } else {
        aggregates.set(aggregate.jobName, aggregate);
      }
    }
  }
  const waivedJobNames = new Set([
    ...waivers.map((row) => row.jobName),
    ...child.jobs
      .filter(
        (job) =>
          aggregates.has(job.name) && job.status === "completed" && job.conclusion === "failure",
      )
      .map((job) => job.name),
  ]);
  const advisoryJobs = child.jobs.filter((job) => isReleaseAdvisoryJob(child.key, job));
  // Preview failures retain their raw conclusions. Stable compatibility and the
  // verifier must still pass; an existing tooling waiver keeps its own log checks.
  const advisoryFailureAllowed =
    !advisoryJobs.some(isFailedReleaseJob) ||
    [WINDOWS_NODE_STABLE_JOB, "Verify release checks"].every((name) =>
      child.jobs.some(
        (job) =>
          job.name === name &&
          job.status === "completed" &&
          (job.conclusion === "success" || waivedJobNames.has(name)),
      ),
    );
  return {
    waivers,
    aggregates: [...aggregates.values()],
    waivedJobNames,
    advisoryJobs,
    advisoryFailureAllowed,
    blockingJobs: child.jobs.filter(
      (job) =>
        isFailedReleaseJob(job) &&
        !waivedJobNames.has(job.name) &&
        !isReleaseAdvisoryJob(child.key, job),
    ),
  };
}

// Aggregates also enforce integrity and dispatch identity. A waived test must
// not excuse a second failure in that same aggregate job.
export class ReleaseAggregateValidationError extends Error {}

// Ignore echoed shell source, not error records: only line-leading runner
// annotations (after a timestamp and optional color) are observed causes.
function exactAggregateCauses(log) {
  return log.split(/\r?\n/u).flatMap((line) => {
    const record = line
      // eslint-disable-next-line no-control-regex -- Only SGR color is removed; other controls fail closed.
      .replace(/\u001b\[[0-9;]*m/gu, "")
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u, "");
    const match = /^(?:##\[error\]|::error(?: title=CI job did not succeed)?::)(.*)$/u.exec(record);
    if (match) {
      return match[1] === "Process completed with exit code 1." ? [] : [match[1]];
    }
    // Malformed error records and remaining control characters fail closed.
    return /^(?:##\[error|::error)/u.test(record) ||
      // eslint-disable-next-line no-control-regex -- Reject controls that could conceal an error record.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(record)
      ? [record]
      : [];
  });
}

export async function validateReleaseWaiverAggregates({ policy, jobs, getJobLog }) {
  for (const waiver of policy.waivers) {
    if (!waiver.testFailures) {
      continue;
    }
    const matches = jobs.filter((job) => job.name === waiver.jobName);
    const job = matches[0];
    const failedSteps = job?.steps?.filter(
      (step) => !["success", "skipped"].includes(step.conclusion),
    );
    if (
      matches.length !== 1 ||
      job.status !== "completed" ||
      job.conclusion !== "failure" ||
      failedSteps?.length !== 1 ||
      failedSteps[0].conclusion !== "failure" ||
      failedSteps[0].name !== waiver.testFailures.stepName
    ) {
      throw new ReleaseAggregateValidationError(
        `Release test job has a non-policy failure: ${waiver.jobName}`,
      );
    }
    const signatures = parseNodeFailureReport(String(await getJobLog(job.id)), true);
    if (!isDeepStrictEqual(signatures, waiver.testFailures.signatures)) {
      throw new ReleaseAggregateValidationError(
        `Release test job has an unwaived or incomplete failure: ${waiver.jobName}`,
      );
    }
  }
  for (const aggregate of policy.aggregates) {
    const matches = jobs.filter((job) => job.name === aggregate.jobName);
    if (matches.length !== 1 || matches[0].status !== "completed") {
      throw new ReleaseAggregateValidationError(
        `Required release aggregate is missing or incomplete: ${aggregate.jobName}`,
      );
    }
    const job = matches[0];
    if (job.conclusion === "success") {
      continue;
    }
    const failedSteps = job.steps?.filter(
      (step) => !["success", "skipped"].includes(step.conclusion),
    );
    if (
      job.conclusion !== "failure" ||
      failedSteps?.length !== 1 ||
      failedSteps[0].name !== aggregate.stepName
    ) {
      throw new ReleaseAggregateValidationError(
        `Release aggregate has a non-policy failure: ${aggregate.jobName}`,
      );
    }
    const log = String(await getJobLog(job.id));
    const causes = aggregate.exactCauses
      ? exactAggregateCauses(log)
      : log
          .split(/\r?\n/u)
          .filter((line) => !line.includes("\u001b"))
          .flatMap((line) => {
            const match = /(?:##\[error\]|::error::)(.*)$/u.exec(line);
            return match && match[1] !== "Process completed with exit code 1." ? [match[1]] : [];
          });
    if (
      causes.length === 0 ||
      causes.some((cause) => !aggregate.causes.includes(cause)) ||
      (aggregate.exactCauses &&
        (causes.length !== aggregate.causes.length || new Set(causes).size !== causes.length))
    ) {
      throw new ReleaseAggregateValidationError(
        `Release aggregate has an unwaived failure: ${aggregate.jobName}`,
      );
    }
  }
}
