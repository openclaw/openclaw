// Owner-level allocation probe; see scripts/perf/README.md before interpreting counts.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  bindOperatorModelExecution,
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../src/agents/admitted-run-context.js";
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
import { createUnavailableRuntime } from "../../src/plugins/api-builder.js";
import type { PluginGatewayAccessAuthority } from "../../src/plugins/gateway-access-policy.types.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { getPluginInstance } from "../../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../src/plugins/runtime.js";
import type { UserProfileAccessFacts } from "../../src/state/user-profiles.types.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "20000" },
    warmup: { type: "string", default: "5000" },
    scenario: { type: "string", default: "all" },
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
const iterations = positiveInteger(values.iterations, "iterations");
const warmup = positiveInteger(values.warmup, "warmup");
const samplingInterval = positiveInteger(values["sampling-interval"], "sampling-interval");
assert(globalThis.gc, "Run Node with --expose-gc");

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
const counts = { authPolicy: 0, resumeOwner: 0, authorize: 0, resume: 0, pluginAssert: 0 };
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
const record = createPluginRecord({
  id: pluginId,
  source: new URL(import.meta.url).pathname,
  origin: "workspace",
  enabled: true,
  configSchema: false,
});
builder.registry.plugins.push(record);
builder.createApi(record, { config }).registerGatewayAccessPolicy({
  authorize(context) {
    counts.authorize++;
    assert.equal(context.profile.profileId, profile.profileId);
    assert.equal(context.requiredByRole, true);
    return grantLive ? pluginAuthority : undefined;
  },
  resume(context) {
    counts.resume++;
    assert.equal(context.profile.profileId, profile.profileId);
    assert.equal(context.grantId, pluginAuthority.grantId);
    return grantLive ? pluginAuthority : undefined;
  },
});
assert.equal(builder.registry.gatewayAccessPolicies.length, 1);
assert(getPluginInstance(record), "Registration must install the real plugin invocation owner");
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
  assertCurrent: checkSource,
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
const admitted = resolveAdmittedRunActiveAssertion(await admission.admit("embedded"));
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
const scenarios = [
  { name: "auth-policy", check: checkAuth },
  { name: "retained-grant", check: checkGrant },
  { name: "model-execution", check: execution.assertCurrent },
  { name: "admitted-run", check: admitted },
  { name: "transcript-guard", check: transcript },
];
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
  const sites: { bytes: number; stack: string[] }[] = [];
  function visit(node: SampleNode, parents: string[]) {
    bytes += node.selfSize;
    const frame = `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
    const stack = [...parents, frame].slice(-8);
    if (node.selfSize > 0) {
      sites.push({ bytes: node.selfSize, stack });
    }
    for (const child of node.children) {
      visit(child, stack);
    }
  }
  visit(root, []);
  return { bytes, topSites: sites.toSorted((a, b) => b.bytes - a.bytes).slice(0, 15) };
}
const results = [];
const inspector = new Session();
inspector.connect();
try {
  for (const scenario of scenarios) {
    if (values.scenario !== "all" && values.scenario !== scenario.name) {
      continue;
    }
    for (let index = 0; index < warmup; index++) {
      scenario.check();
    }
    globalThis.gc();
    if (values["start-at"]) {
      const startAt = positiveInteger(values["start-at"], "start-at");
      const remaining = startAt - Date.now();
      assert(remaining > 0, "Shared start deadline missed during setup/warmup");
      await new Promise((resolve) => {
        setTimeout(resolve, remaining);
      });
    }
    resetCounts();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      scenario.check();
    }
    const elapsedMs = performance.now() - start;
    const cpuUsed = process.threadCpuUsage(cpu);
    const measuredCounts = { ...counts };
    const { profile: heapProfile } = await inspector.post("HeapProfiler.stopSampling");
    const allocation = summarizeProfile(heapProfile.head);
    if (values.output) {
      await writeFile(`${values.output}.${scenario.name}.heapprofile`, JSON.stringify(heapProfile));
    }
    results.push({
      scenario: scenario.name,
      iterations,
      elapsedMs,
      nsPerCheck: (elapsedMs * 1e6) / iterations,
      threadCpuNsPerCheck: ((cpuUsed.user + cpuUsed.system) * 1000) / iterations,
      estimatedAllocatedBytes: allocation.bytes,
      estimatedBytesPerCheck: allocation.bytes / iterations,
      counts: measuredCounts,
      countsPerCheck: Object.fromEntries(
        Object.entries(measuredCounts).map(([name, count]) => [name, count / iterations]),
      ),
      topSites: allocation.topSites,
    });
  }
  // Positive control outside capture: retained plugin answers remain live on the next check.
  grantLive = false;
  assert.throws(checkGrant);
  const report = {
    revision: values.revision,
    node: process.version,
    workload: "real authority owners; synthetic non-owner profile and registered access policy",
    scope:
      "owner microbenchmark; no model turns, tool execution, transcript writes, or Gateway transport",
    samplingInterval,
    includeCollected: true,
    warmup,
    setupCountsExcluded: true,
    nextCheckRevocationDenied: true,
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (values.output) {
    await writeFile(values.output, `${json}\n`);
  }
  console.log(json);
} finally {
  inspector.disconnect();
  execution.release();
  admission.close();
  controller.abort();
  await clearActivePluginRegistry();
}
