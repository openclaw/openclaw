// Owner-level allocation probe. Real transcript preparation, detached storage:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/operator-authority-measure.ts \
//   --scenario attempt-transcript-guard --plugins 40 --samples 5 --iterations 5000 --warmup 1000 \
//   --timing-only --revision <sha> --output <timing.json>
// Repeat without --timing-only and with --sampling-interval 1024 for sampled bytes.
// Compare identical arguments across revisions; allocation/CPU passes are separate.
// Calls the prepared lifecycle's actual assertCommitAllowed; setup and cleanup are
// excluded. Detached persistence avoids unrelated storage IO, not authority checks.
// Acceptance: fewer applicable policy assertions and allocated bytes per check,
// with no repeatable thread CPU regression. This is not whole-Gateway evidence.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { constants, performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  bindOperatorModelExecution,
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../src/agents/admitted-run-context.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "../../src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js";
import { composeSessionSourceAssertion } from "../../src/config/sessions/session-source-authority.js";
import { captureSessionTranscriptTargetBinding } from "../../src/config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWrites,
} from "../../src/config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  captureGatewayAuthPolicy,
  isGatewayAuthGrantCurrent,
} from "../../src/gateway/auth-policy.js";
import {
  resolvePreparedGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "../../src/gateway/operator-access-policy.js";
import { sourceRolePolicy } from "../../src/gateway/operator-role-source-policy.js";
import { decodeQueuedOperatorRecoverySource } from "../../src/gateway/operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "../../src/gateway/operator-run-recovery.js";
import type { GatewayRequestContext } from "../../src/gateway/server-methods/shared-types.js";
import { createUnavailableRuntime } from "../../src/plugins/api-builder.js";
import type {
  PluginGatewayAccessAuthority,
  PluginGatewayAccessPolicy,
} from "../../src/plugins/gateway-access-policy.types.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { getPluginInstance } from "../../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db.js";
import { profileCatalogPath } from "../../src/state/user-profile-identity.read.js";
import { prepareUserProfileIdentity } from "../../src/state/user-profile-list.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import type { UserProfileAccessFacts } from "../../src/state/user-profiles.types.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "20000" },
    warmup: { type: "string", default: "5000" },
    plugins: { type: "string", default: "1" },
    samples: { type: "string", default: "1" },
    scenario: { type: "string", default: "all" },
    "counts-only": { type: "boolean", default: false },
    "timing-only": { type: "boolean", default: false },
    "sampling-interval": { type: "string", default: "32768" },
    "start-at": { type: "string" },
    output: { type: "string" },
    revision: { type: "string", default: "unspecified" },
  },
});
function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0, `${label} must be a positive integer`);
  return number;
}
assert(!(values["counts-only"] && values["timing-only"]), "Select one measurement mode");
const iterations = positiveInteger(values.iterations, "iterations");
const warmup = positiveInteger(values.warmup, "warmup");
const pluginCount = positiveInteger(values.plugins, "plugins");
const sampleCount = positiveInteger(values.samples, "samples");
const samplingInterval = positiveInteger(values["sampling-interval"], "sampling-interval");
assert(values["counts-only"] || globalThis.gc, "Run Node with --expose-gc");
const authorityCounts = (
  globalThis as typeof globalThis & {
    [key: symbol]:
      | {
          active: boolean;
          counts: Record<string, number>;
          callers: Record<string, number>;
          installed: Record<string, Record<string, number>>;
        }
      | undefined;
  }
)[Symbol.for("openclaw.benchmark.authorityCounts")];
assert(
  !values["counts-only"] || authorityCounts,
  "--counts-only requires --import <authority-counts-preload.mjs> from the Gateway count pass",
);

const pluginId = "synthetic-authority-policy";
const email = "operator@authority.example.test";
const config: OpenClawConfig = {
  plugins: { enabled: true, allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
  gateway: {
    auth: { mode: "none", identityScopes: { [email]: ["operator.write"] } },
    controlUi: { allowedOrigins: ["https://authority.example.test"] },
    roles: {
      default: "synthetic-operator",
      definitions: {
        "synthetic-operator": {
          scopes: ["operator.write"],
          agents: "*",
          sessions: { others: "none" },
          accessPolicyPlugin: pluginId,
        },
      },
    },
  },
};
const profile: UserProfileAccessFacts = Object.freeze({
  profileId: "synthetic-non-owner",
  emails: Object.freeze([email]),
  githubAccountIds: Object.freeze([12345]),
  assignedRole: "synthetic-operator",
});
const allowedProfiles = new Set([profile.profileId]);
const counts = {
  recoverySource: 0,
  authPolicy: 0,
  resumeOwner: 0,
  authorize: 0,
  resume: 0,
  pluginAssert: 0,
};
function resetCounts() {
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    counts[key] = 0;
  }
}
const controller = new AbortController();
let grantLive = true;
const pluginAuthority: PluginGatewayAccessAuthority = {
  grantId: "00000000-0000-4000-8000-000000000001",
  signal: controller.signal,
  assertCurrent() {
    counts.pluginAssert++;
    assert(grantLive, "Synthetic grant revoked");
  },
};
// Policy callbacks use no other runtime capability. Unexpected runtime access fails closed.
const builder = createPluginRegistry({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  runtime: createUnavailableRuntime("setup-only", pluginId),
  activateGlobalSideEffects: false,
});
for (let index = 0; index < pluginCount; index++) {
  const id = index === 0 ? pluginId : `${pluginId}-${index}`;
  const record = createPluginRecord({
    id,
    source: new URL(import.meta.url).pathname,
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  if (index > 0) {
    config.plugins!.allow!.push(id);
  }
  config.plugins!.entries![id] = { enabled: true };
  builder.registry.plugins.push(record);
  const policy: PluginGatewayAccessPolicy = {
    authorize(context) {
      counts.authorize++;
      assert(allowedProfiles.has(context.profile.profileId));
      assert.equal(context.requiredByRole, index === 0);
      return index === 0 && grantLive ? pluginAuthority : undefined;
    },
  };
  if (index === 0) {
    policy.resume = (context) => {
      counts.resume++;
      assert(allowedProfiles.has(context.profile.profileId));
      assert.equal(context.grantId, pluginAuthority.grantId);
      return grantLive ? pluginAuthority : undefined;
    };
  }
  builder.createApi(record, { config }).registerGatewayAccessPolicy(policy);
  assert(getPluginInstance(record), "Registration must install the real plugin invocation owner");
}
assert.equal(builder.registry.gatewayAccessPolicies.length, pluginCount);
setActivePluginRegistry(builder.registry);

const access = resolvePreparedGatewayOperatorAccessAuthority(
  { ...profile, role: profile.assignedRole, isCurrent: () => true },
  config,
  { requireLivePolicySet: true },
);
assert(access?.gatewayAccessGrant);
const grant = access.gatewayAccessGrant;
const retained = resumeGatewayOperatorAccessGrant(profile, config, grant);
assert(retained);
const authPolicy = captureGatewayAuthPolicy(config, {
  role: "operator",
  authMethod: "none",
  verifiedIdentity: email,
  browserOrigin: {
    origin: "https://authority.example.test",
    requestHost: "authority.example.test",
    isLocalClient: false,
  },
});
function checkAuth() {
  counts.authPolicy++;
  assert(isGatewayAuthGrantCurrent(authPolicy, config), "Synthetic auth policy changed");
}
function checkGrant() {
  counts.resumeOwner++;
  resumeGatewayOperatorAccessGrant(profile, config, grant, retained);
}
function checkSource() {
  checkAuth();
  checkGrant();
}
const model = { provider: "synthetic", model: "synthetic-model" };
const operator = createAdmittedRunOperatorAuthority({
  profileId: profile.profileId,
  scopes: ["operator.write"],
  gatewayAccessGrant: grant,
  signal: retained.signal,
  assertCurrent:
    values.scenario === "attempt-transcript-guard"
      ? composeSessionSourceAssertion([access.assertCurrent])
      : checkSource,
  modelPolicy: {
    models: [model],
    allows: (selected) => selected.provider === model.provider && selected.model === model.model,
  },
});
const execution = bindOperatorModelExecution(operator, model);
assert(execution);
const admission = prepareSystemAgentRunAdmission(
  config,
  "synthetic-authority-run",
  "synthetic-agent",
  "operator-authority-measure",
  undefined,
  operator,
);
const admittedRunContext = await admission.admit("embedded");
const admitted = resolveAdmittedRunActiveAssertion(admittedRunContext);
assert(admitted);
const transcriptTarget = {
  agentId: "synthetic-agent",
  sessionId: "synthetic-authority-session",
  sessionKey: "agent:synthetic-agent:authority",
  storePath: `${process.cwd()}/synthetic-authority-store/sessions.json`,
  env: {},
};
const transcript = await withOwnedSessionTranscriptWrites(
  {
    sessionTarget: transcriptTarget,
    assertCommitAllowed: admitted,
    withTranscriptWrite: async (run) => run(),
  },
  async () => captureOwnedTranscriptWriteAssertion(transcriptTarget),
);
let attemptTranscript:
  | Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>
  | undefined;
if (values.scenario === "attempt-transcript-guard") {
  const { prepareEmbeddedAttemptTranscriptLifecycle } =
    await import("../../src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js");
  const target = captureSessionTranscriptTargetBinding({
    ...transcriptTarget,
    storePath: path.join(
      process.cwd(),
      ".local",
      "transcript-authority-measure",
      "openclaw-agent.sqlite",
    ),
    env: { OPENCLAW_STATE_DIR: path.join(process.cwd(), ".local", "transcript-authority-measure") },
  });
  attemptTranscript = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt: {
      config,
      runId: "synthetic-authority-run",
      admittedRunContext,
      abortSignal: controller.signal,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionFile: target.sessionKey,
      sessionTarget: target,
      sessionPersistence: "detached",
      preparedSessionTarget: {
        target,
        assertCurrent: composeSessionSourceAssertion([admitted], (assertSource) => {
          controller.signal.throwIfAborted();
          assertSource();
          controller.signal.throwIfAborted();
        }),
      },
    },
    externalAbortController: {
      arm() {},
      async throwIfFiredAfterPrepCleanup() {
        controller.signal.throwIfAborted();
      },
    },
  });
}
let recovery: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
let recoveryStateDir: string | undefined;
let recoveryConfig = config;
if (values.scenario === "all" || values.scenario === "recovery-source") {
  recoveryStateDir = await mkdtemp(path.join(os.tmpdir(), "operator-authority-measure-"));
  process.env.OPENCLAW_STATE_DIR = recoveryStateDir;
  const person = ensureProfileForEmail("recovery@authority.example.test");
  allowedProfiles.add(person.id);
  const identity = await prepareUserProfileIdentity(person.id);
  try {
    const { profile: facts } = identity.readCurrentFacts();
    const recoveredAccess = resolvePreparedGatewayOperatorAccessAuthority(
      { ...facts, role: facts.assignedRole, isCurrent: () => true },
      config,
      { requireLivePolicySet: true },
    );
    assert(recoveredAccess?.gatewayAccessGrant);
    // Decode the persisted shape so this is never an already-issued policy identity.
    const source = decodeQueuedOperatorRecoverySource({
      kind: "gateway",
      snapshot: {
        profileId: person.id,
        scopes: ["operator.write"],
        assignedRole: facts.assignedRole,
        githubLogin: facts.githubLogin ?? null,
        rolePolicy: sourceRolePolicy(config.gateway?.roles?.definitions["synthetic-operator"]),
        grant: recoveredAccess.gatewayAccessGrant,
        aliasBindingIds: identity.emailBindingIds,
        authPolicy: {
          ...captureGatewayAuthPolicy(config, {
            role: "operator",
            authMethod: "token",
            verifiedIdentity: "recovery@authority.example.test",
            browserOrigin: authPolicy.browserOrigin,
          }),
          generation: "",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    });
    assert(source.kind === "gateway");
    // Recovery only consumes the config reader and optional owner identities.
    const context = { getRuntimeConfig: () => recoveryConfig } as GatewayRequestContext;
    recovery = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: {
        agentId: "synthetic-agent",
        sessionKey: "agent:synthetic-agent:recovery",
        sessionId: "synthetic-recovery",
      },
      context,
      assertCurrent() {},
    });
  } finally {
    identity.release();
  }
}
const scenarios = [
  { name: "auth-policy", check: checkAuth },
  { name: "retained-grant", check: checkGrant },
  { name: "model-execution", check: execution.assertCurrent },
  { name: "admitted-run", check: admitted },
  { name: "transcript-guard", check: transcript },
];
if (attemptTranscript) {
  const check = attemptTranscript.ownedTranscriptWriteContext.assertCommitAllowed;
  assert(check);
  scenarios.push({ name: "attempt-transcript-guard", check });
}
if (recovery) {
  const authority = recovery.authority;
  scenarios.push({
    name: "recovery-source",
    check() {
      counts.recoverySource++;
      authority.assertCurrent();
    },
  });
}
assert(
  values.scenario === "all" || scenarios.some(({ name }) => name === values.scenario),
  `Unknown scenario: ${values.scenario}`,
);
assert(!values["start-at"] || values.scenario !== "all", "--start-at requires one --scenario");

type SampleNode = {
  selfSize: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children: SampleNode[];
};
function summarizeProfile(root: SampleNode) {
  let bytes = 0;
  let authPolicyStringifyBytes = 0;
  const sites: { bytes: number; stack: string[] }[] = [];
  function visit(
    node: SampleNode,
    parents: string[],
    inAuthPolicy = false,
    inAuthStringify = false,
  ) {
    const hasAuthPolicy =
      inAuthPolicy || node.callFrame.functionName === "captureGatewayAuthPolicy";
    // V8 can inline the public wrapper while retaining its recursive serializer frames.
    const hasAuthStringify =
      inAuthStringify ||
      (hasAuthPolicy &&
        (node.callFrame.functionName === "stableStringify" ||
          node.callFrame.functionName === "stringifyStableValue" ||
          node.callFrame.functionName === "stringifyObjectValue"));
    if (hasAuthStringify) {
      authPolicyStringifyBytes += node.selfSize;
    }
    bytes += node.selfSize;
    const frame = `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
    const stack = [...parents, frame].slice(-8);
    if (node.selfSize > 0) {
      sites.push({ bytes: node.selfSize, stack });
    }
    for (const child of node.children) {
      visit(child, stack, hasAuthPolicy, hasAuthStringify);
    }
  }
  visit(root, []);
  return {
    bytes,
    authPolicyStringifyBytes,
    topSites: sites.toSorted((a, b) => b.bytes - a.bytes).slice(0, 15),
  };
}
function observeGc() {
  const entries: { startTime: number; duration: number; detail?: unknown }[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  return async (startedAt: number, endedAt: number) => {
    // GC notifications arrive after the synchronous owner-check loop yields.
    await nextTurn();
    entries.push(...observer.takeRecords());
    observer.disconnect();
    const measured = entries.filter(
      (entry) => entry.startTime >= startedAt && entry.startTime < endedAt,
    );
    const summarize = (kind?: number) => {
      const pauses = measured
        .filter(
          (entry) => kind === undefined || (isRecord(entry.detail) && entry.detail.kind === kind),
        )
        .map((entry) => entry.duration)
        .toSorted((a, b) => a - b);
      return {
        count: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        maxMs: pauses.at(-1) ?? 0,
        p95Ms: pauses.length ? pauses[Math.ceil(pauses.length * 0.95) - 1] : null,
        p99Ms: pauses.length ? pauses[Math.ceil(pauses.length * 0.99) - 1] : null,
      };
    };
    return {
      all: summarize(),
      minor: summarize(constants.NODE_PERFORMANCE_GC_MINOR),
      major: summarize(constants.NODE_PERFORMANCE_GC_MAJOR),
      incremental: summarize(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
      weakCallback: summarize(constants.NODE_PERFORMANCE_GC_WEAKCB),
    };
  };
}
const results = [];
const inspector = new Session();
inspector.connect();
try {
  const samples = Array.from({ length: sampleCount }, (_, sample) =>
    scenarios.map((scenario) => ({
      name: scenario.name,
      check: scenario.check,
      sample: sample + 1,
    })),
  ).flat();
  for (const scenario of samples) {
    if (values.scenario !== "all" && values.scenario !== scenario.name) {
      continue;
    }
    for (let index = 0; index < warmup; index++) {
      scenario.check();
    }
    globalThis.gc?.();
    if (values["start-at"] && scenario.sample === 1) {
      const startAt = positiveInteger(values["start-at"], "start-at");
      const remaining = startAt - Date.now();
      assert(remaining > 0, "Shared start deadline missed during setup/warmup");
      await new Promise((resolve) => {
        setTimeout(resolve, remaining);
      });
    }
    resetCounts();
    if (values["counts-only"]) {
      assert(authorityCounts);
      authorityCounts.counts = {};
      authorityCounts.callers = {};
      authorityCounts.active = true;
      try {
        for (let index = 0; index < iterations; index++) {
          scenario.check();
        }
      } finally {
        authorityCounts.active = false;
      }
      results.push({
        scenario: scenario.name,
        sample: scenario.sample,
        iterations,
        counts: { ...counts },
        host: {
          counts: { ...authorityCounts.counts },
          installed: authorityCounts.installed,
        },
      });
      continue;
    }
    if (!values["timing-only"]) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const finishGc = values["timing-only"] ? observeGc() : undefined;
    const hostLoad = os.loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      scenario.check();
    }
    const endedAt = performance.now();
    const elapsedMs = endedAt - start;
    const cpuUsed = process.threadCpuUsage(cpu);
    const measuredCounts = { ...counts };
    const gc = await finishGc?.(start, endedAt);
    let allocation: ReturnType<typeof summarizeProfile> | undefined;
    if (!values["timing-only"]) {
      const { profile: heapProfile } = await inspector.post("HeapProfiler.stopSampling");
      allocation = summarizeProfile(heapProfile.head);
      if (values.output) {
        await writeFile(
          `${values.output}.${scenario.name}${sampleCount > 1 ? `.sample-${scenario.sample}` : ""}.heapprofile`,
          JSON.stringify(heapProfile),
        );
      }
    }
    results.push({
      scenario: scenario.name,
      sample: scenario.sample,
      iterations,
      elapsedMs,
      hostLoad,
      gc,
      gcMsPerCheck: gc && gc.all.totalMs / iterations,
      nsPerCheck: (elapsedMs * 1e6) / iterations,
      threadCpuNsPerCheck: ((cpuUsed.user + cpuUsed.system) * 1000) / iterations,
      estimatedAllocatedBytes: allocation?.bytes,
      estimatedBytesPerCheck: allocation && allocation.bytes / iterations,
      estimatedAuthPolicyStringifyBytesPerCheck:
        allocation && allocation.authPolicyStringifyBytes / iterations,
      counts: measuredCounts,
      countsPerCheck: Object.fromEntries(
        Object.entries(measuredCounts).map(([name, count]) => [name, count / iterations]),
      ),
      topSites: allocation?.topSites,
    });
  }
  let nextCheckConfigRevocationDenied: boolean | undefined;
  if (recovery) {
    recoveryConfig = {
      ...config,
      gateway: { ...config.gateway, controlUi: { allowedOrigins: [] } },
    };
    assert.throws(recovery.authority.assertCurrent);
    nextCheckConfigRevocationDenied = true;
  }
  // Positive control outside capture: retained plugin answers remain live on the next check.
  grantLive = false;
  assert.throws(checkGrant);
  if (attemptTranscript) {
    assert.throws(attemptTranscript.ownedTranscriptWriteContext.assertCommitAllowed!);
  }
  const report = {
    revision: values.revision,
    node: process.version,
    workload: "real authority owners; synthetic non-owner profile and registered access policy",
    scope:
      "owner microbenchmark; no model turns, tool execution, transcript writes, or Gateway transport",
    samplingInterval: values["counts-only"] || values["timing-only"] ? undefined : samplingInterval,
    includeCollected: !values["counts-only"] && !values["timing-only"],
    timingOnly: values["timing-only"],
    countsOnly: values["counts-only"],
    warmup,
    pluginCount,
    sampleCount,
    setupCountsExcluded: true,
    nextCheckRevocationDenied: true,
    nextCheckConfigRevocationDenied,
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (values.output) {
    await writeFile(values.output, `${json}\n`);
  }
  console.log(json);
} finally {
  inspector.disconnect();
  await attemptTranscript?.transcriptLifecycle.dispose();
  execution.release();
  admission.close();
  controller.abort();
  await clearActivePluginRegistry();
  recovery?.release();
  if (recoveryStateDir) {
    await closeOpenClawStateDatabaseByPathAsync(profileCatalogPath({}));
    await rm(recoveryStateDir, { recursive: true, force: true });
  }
}
