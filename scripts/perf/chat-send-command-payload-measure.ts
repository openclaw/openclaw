/**
 * Measure real reply command owners on an ordinary text turn (no model/network I/O).
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-send-command-payload-measure.ts \
 *   --output .local/command-payload-candidate.json --iterations 10000
 * Repeat with --allocations for a separate V8 sampled-allocation pass; interleave
 * base/candidate arms. --owner-dir captures the two owners under their original
 * src/auto-reply/reply paths; all other imports use this checkout. Each receipt
 * pins the source hash and verifies the captured owner was loaded exactly once.
 * For comparisons, capture BOTH revisions and use --owner-dir for both arms so
 * their compiler/loader paths match; the default loader is for standalone probes.
 *
 * Fixtures contain 10,000 synthetic sessions and 40 agent entries. Both owners
 * receive the same already-prepared plain-turn facts as the real reply flow.
 * Fixture construction, imports, warmup and output are outside measured work.
 * Report per-owner process/main-thread CPU, wall time and sampled bytes per turn.
 * This isolates command payload preparation; it does not prove Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "10000" },
    allocations: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
  },
});
assert(values.output, "--output is required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(global.gc, "run with --expose-gc");
const output = path.resolve(values.output);
await fs.mkdir(path.dirname(output), { recursive: true });
const stateDir = await fs.mkdtemp(path.join(path.dirname(output), "command-payload-state-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_HOME = stateDir;

const ownerFiles = [
  "src/auto-reply/reply/get-reply-directives-apply.ts",
  "src/auto-reply/reply/get-reply-inline-actions.ts",
];
const ownerReceipts: Array<{ path: string; sha256: string; capturedLoads?: number }> = [];
if (values["owner-dir"]) {
  const { transformSync } = await import("esbuild");
  const overrides = new Map(
    ownerFiles.map((file) => {
      const source = readFileSync(path.join(path.resolve(values["owner-dir"]!), file), "utf8");
      const receipt = {
        path: file,
        sha256: createHash("sha256").update(source).digest("hex"),
        capturedLoads: 0,
      };
      ownerReceipts.push(receipt);
      return [
        new URL(`../../${file}`, import.meta.url).href,
        {
          receipt,
          code: transformSync(source, {
            loader: "ts",
            format: "esm",
            target: "esnext",
            sourcefile: file,
          }).code,
        },
      ] as const;
    }),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const owner = overrides.get(url);
      if (owner) {
        result.source = owner.code;
        owner.receipt.capturedLoads++;
      }
      return result;
    },
  });
} else {
  for (const file of ownerFiles) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url));
    ownerReceipts.push({
      path: file,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
  }
}

try {
  const { applyInlineDirectiveOverrides } =
    await import("../../src/auto-reply/reply/get-reply-directives-apply.js");
  const { handleInlineActions } =
    await import("../../src/auto-reply/reply/get-reply-inline-actions.js");
  const { parseInlineSessionDirectives } =
    await import("../../src/auto-reply/reply/directive-handling.parse.js");
  const { finalizeInboundContext } = await import("../../src/auto-reply/reply/inbound-context.js");
  const { createTypingController } = await import("../../src/auto-reply/reply/typing.js");
  const { createModelVisibilityPolicy } =
    await import("../../src/agents/model-visibility-policy.js");
  for (const receipt of ownerReceipts) {
    if (values["owner-dir"]) {
      assert.equal(receipt.capturedLoads, 1, `captured owner must load once: ${receipt.path}`);
    }
  }
  const body = "Explain the synthetic project summary and suggest the next useful step.";
  const ctx = finalizeInboundContext({
    Body: body,
    Provider: "webchat",
    Surface: "webchat",
    CommandAuthorized: true,
  });
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`agent-${i}`, {}])),
    },
    commands: { text: true },
  };
  const agentId = "agent-0";
  const sessionKey = `agent:${agentId}:synthetic-0`;
  const sessionStore = Object.fromEntries(
    Array.from({ length: 10000 }, (_, i) => [
      `agent:${agentId}:synthetic-${i}`,
      { sessionId: `synthetic-${i}`, updatedAt: 1 },
    ]),
  );
  const sessionEntry = sessionStore[sessionKey];
  assert(sessionEntry, "synthetic active session must exist");
  const provider = "mock";
  const model = "synthetic";
  const directives = parseInlineSessionDirectives(body);
  const typing = createTypingController({});
  const command = {
    surface: "webchat",
    channel: "webchat",
    ownerList: [],
    senderIsOwner: true,
    isAuthorizedSender: true,
    rawBodyNormalized: body,
    commandBodyNormalized: body,
  };
  type DirectiveInput = Parameters<typeof applyInlineDirectiveOverrides>[0];
  const directiveInput: DirectiveInput = {
    ctx,
    cfg,
    agentId,
    agentDir: stateDir,
    workspaceDir: stateDir,
    agentCfg: {},
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: undefined,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command,
    directives,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultProvider: provider,
    defaultModel: model,
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider,
    model,
    modelState: {
      provider,
      model,
      requestedRouteResolution: "resolved",
      modelPolicy: createModelVisibilityPolicy({
        cfg,
        catalog: [],
        defaultProvider: provider,
        defaultModel: model,
        agentId,
      }),
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveThinkingCatalog: async () => [],
      resolveDefaultThinkingLevel: async () => "off",
      resolveDefaultReasoningLevel: async () => "off",
    },
    initialModelLabel: `${provider}/${model}`,
    formatModelSwitchEvent: (label) => label,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 32000,
    typing,
  };
  const inlineInput: Parameters<typeof handleInlineActions>[0] = {
    ctx,
    sessionCtx: ctx,
    cfg,
    agentId,
    agentDir: stateDir,
    workspaceDir: stateDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: undefined,
    sessionScope: undefined,
    isGroup: false,
    typing,
    allowTextCommands: true,
    inlineStatusRequested: false,
    command,
    directives,
    cleanedBody: body,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolveModelLevels: async () => ({
      resolvedThinkLevel: undefined,
      resolvedReasoningLevel: "off",
    }),
    resolvedVerboseLevel: undefined,
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    provider,
    model,
    contextTokens: 32000,
    thinkingCatalog: undefined,
    abortedLastRun: false,
  };
  const workloads = [
    {
      owner: "applyInlineDirectiveOverrides",
      fields: Object.keys(directiveInput).length,
      run: () => applyInlineDirectiveOverrides(directiveInput),
    },
    {
      owner: "handleInlineActions",
      fields: Object.keys(inlineInput).length,
      run: () => handleInlineActions(inlineInput),
    },
  ];
  const results = [];
  for (const workload of workloads) {
    for (let i = 0; i < 1000; i++) {
      assert.equal((await workload.run()).kind, "continue");
    }
    global.gc();
    await immediate();
    const inspector = values.allocations ? new Session() : undefined;
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const gc: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gc.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const threadCpu = process.threadCpuUsage();
    const processCpu = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      assert.equal((await workload.run()).kind, "continue");
    }
    const wallMs = performance.now() - started;
    const threadDelta = process.threadCpuUsage(threadCpu);
    const processDelta = process.cpuUsage(processCpu);
    await immediate();
    await immediate();
    observer.disconnect();
    let sampledAllocationBytes: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const pending = [profile.head];
      sampledAllocationBytes = 0;
      for (const node of pending) {
        sampledAllocationBytes += node.selfSize;
        pending.push(...node.children);
      }
      inspector.disconnect();
    }
    results.push({
      owner: workload.owner,
      inputFields: workload.fields,
      iterations,
      wallMs,
      wallUsPerTurn: (wallMs * 1000) / iterations,
      mainThreadCpuUsPerTurn: (threadDelta.user + threadDelta.system) / iterations,
      processCpuUsPerTurn: (processDelta.user + processDelta.system) / iterations,
      sampledAllocationBytes,
      sampledAllocationBytesPerTurn:
        sampledAllocationBytes === undefined ? undefined : sampledAllocationBytes / iterations,
      gc: {
        count: gc.length,
        totalMs: gc.reduce((sum, ms) => sum + ms, 0),
        maxMs: gc.length ? Math.max(...gc) : 0,
      },
      memory: { before: memoryBefore, after: process.memoryUsage() },
      hostLoad: { before: hostLoadBefore, after: loadavg() },
    });
  }
  typing.cleanup();
  const report = {
    kind: "chat-send-command-payload-owner",
    allocations: values.allocations,
    ownerReceipts,
    sessionCount: 10000,
    agentCount: 40,
    results,
  };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await fs.rm(stateDir, { recursive: true, force: true });
}
