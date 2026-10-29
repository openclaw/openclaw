/**
 * Owner microbench for model speed presentation and the tools.effective cache key.
 * node --import ./scripts/tsx.mjs scripts/perf/model-tool-projection-measure.ts \
 *   --owner models --source .local/base-model-presentation.ts --iterations 5000
 * Repeat --owner tools with a captured tools-effective.ts; omit --source for candidate.
 * Alternate base/candidate order. Node 26.12+ exact main-isolate allocation counters;
 * no inspector instrumentation. 500 models / 40 providers; 12 live tool policy layers.
 * Imports use production policy/capability helpers. The tools workload extracts its
 * private key function verbatim (no production test export); model caller identity is
 * fixed to a real external client. This is not a Gateway or end-to-end RPC benchmark.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    source: { type: "string" },
    iterations: { type: "string", default: "5000" },
    shape: { type: "string", default: "mixed" },
  },
});
assert(values.owner === "models" || values.owner === "tools", "--owner models|tools required");
assert(["mixed", "all", "none"].includes(values.shape), "--shape mixed|all|none required");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 5000,
});
const ownerUrl = new URL(
  values.owner === "models"
    ? "../../src/gateway/session-fast-mode-presentation.ts"
    : "../../src/gateway/server-methods/tools-effective.ts",
  import.meta.url,
);
const source = readFileSync(values.source ?? ownerUrl, "utf8");
const callerFixture = `data:text/javascript,export const isSyntheticGatewayCaller = () => false;`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === ownerUrl.href && specifier.endsWith("gateway-personal-caller.js")) {
      return { url: callerFixture, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ownerUrl.href) {
      return next(url, context);
    }
    let selected = source;
    if (values.owner === "tools") {
      const start = source.indexOf("function optionalCacheString(");
      const end = source.indexOf("function resolveCachedSessionMcpConfigSummary(");
      assert(start >= 0 && end > start, "cache-key owner boundaries changed");
      selected = `import { buildConversationToolPolicyPipelineSteps, resolveConversationToolPolicies } from '../../agents/conversation-tool-policy-pipeline.js';
import { readToolAllowlistIntersection } from '../../agents/tool-policy-shared.js';
${source.slice(start, end)}\nexport { buildToolsEffectiveCacheKey };`;
    }
    return { format: "module", source: stripTypeScriptTypes(selected), shortCircuit: true };
  },
});
const owner: {
  projectModelFastModeCatalog: (
    payload: { models: ModelChoice[]; decisionModels: ModelChoice[] },
    client: { connect: { caps: string[] } },
  ) => { models: ModelChoice[]; decisionModels: ModelChoice[] };
  buildToolsEffectiveCacheKey: (context: unknown) => string;
} = await import(ownerUrl.href);
hooks.deregister();
let run: () => unknown;
let expected: string;
if (values.owner === "models") {
  const models: ModelChoice[] = Array.from({ length: 500 }, (_, index) => ({
    id: `model-${index}`,
    name: `Synthetic model ${index}`,
    provider: `fixture-${index % 40}`,
    contextWindow: 131072,
    available: true,
    effectiveFastMode:
      values.shape === "all" || (values.shape === "mixed" && index % 20 === 0)
        ? "ultrafast"
        : "auto",
    runtimeChoices: [
      {
        agentRuntime: { id: "fixture-runtime", source: "model" },
        effectiveFastMode:
          values.shape === "all" || (values.shape === "mixed" && index % 25 === 0)
            ? "ultrafast"
            : false,
      },
    ],
  }));
  const payload = { models, decisionModels: models.slice(0, 40) };
  const client = { connect: { caps: [] } };
  run = () => owner.projectModelFastModeCatalog(payload, client);
  // Independent byte oracle: only speed values change, object/property order stays intact.
  expected = JSON.stringify(payload).replaceAll(
    '"effectiveFastMode":"ultrafast"',
    '"effectiveFastMode":true',
  );
} else {
  const layerNames = [
    "profilePolicy",
    "providerProfilePolicy",
    "globalPolicy",
    "globalProviderPolicy",
    "agentPolicy",
    "agentProviderPolicy",
    "groupPolicy",
    "senderPolicy",
    "sandboxPolicy",
    "subagentPolicy",
    "runtimeToolPolicyForInheritance",
    "inheritedToolPolicy",
  ];
  const policies = Object.fromEntries(
    layerNames.map((name, index) => [
      name,
      { allow: [`plugin-${index}/*`, "read"], deny: [`fixture-deny-${index}`] },
    ]),
  );
  const context = {
    runtimeConfigCacheKey: "fixture-config-1",
    pluginRegistryVersion: 40,
    channelRegistryVersion: 1,
    nodePluginToolsVersion: 1,
    sessionKey: "agent:main:fixture",
    sessionId: "fixture",
    workspaceDir: "/synthetic/workspace",
    agentId: "main",
    modelProvider: "fixture",
    modelId: "model-1",
    capabilityProfile: {
      policy: { ...policies, profile: "coding", providerProfile: "coding", agentId: "main" },
    },
  };
  run = () => owner.buildToolsEffectiveCacheKey(context);
  expected = JSON.stringify({
    v: 1,
    config: "fixture-config-1",
    pluginRegistry: 40,
    channelRegistry: 1,
    nodePluginTools: 1,
    sessionKey: context.sessionKey,
    sessionId: "fixture",
    workspaceDir: context.workspaceDir,
    agentId: "main",
    modelProvider: "fixture",
    modelId: "model-1",
    messageProvider: "",
    accountId: "",
    currentChannelId: "",
    currentThreadTs: "",
    groupId: "",
    groupChannel: "",
    groupSpace: "",
    replyToMode: "",
    webSearchEnabled: true,
    policy: layerNames.map((name) => policies[name]),
  });
}
const serialize = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
assert.equal(serialize(run()), expected);
for (let i = 0; i < 500; i++) {
  run();
}
const loadStart = loadavg();
const memoryStart = process.memoryUsage();
const before = getHeapStatistics().total_allocated_bytes;
assert(Number.isFinite(before), "requires Node 26.12+ total_allocated_bytes");
const cpu = process.threadCpuUsage();
const started = performance.now();
let last: unknown;
for (let i = 0; i < iterations; i++) {
  last = run();
}
const wallMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
const allocatedBytes = getHeapStatistics().total_allocated_bytes - before;
assert.equal(serialize(last), expected);
console.log(
  JSON.stringify({
    owner: values.owner,
    shape: values.shape,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    payloadSha256: createHash("sha256").update(expected).digest("hex"),
    iterations,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    cpuUsPerCall: (used.user + used.system) / iterations,
    allocatedBytes,
    bytesPerCall: allocatedBytes / iterations,
    rssBefore: memoryStart.rss,
    rssAfter: process.memoryUsage().rss,
    heapBefore: memoryStart.heapUsed,
    heapAfter: process.memoryUsage().heapUsed,
    loadStart,
    loadEnd: loadavg(),
  }),
);
