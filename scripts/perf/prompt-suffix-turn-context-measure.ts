/**
 * Prompt rendering/pinning owner comparison, without Gateway or provider calls.
 * node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/prompt-suffix-turn-context-measure.ts base|candidate|paired timing|allocation [2000]
 * Paired mode runs five counterbalanced pairs in one process; keep allocation separate.
 * Each arm gets fresh session pins, warmup, and an explicit GC outside its window.
 * Both arms call the current render/pin owners. Base supplies the old whole extra
 * prompt; candidate applies the repaired turn placement and encodes that carrier.
 * Forty tools, 32 KiB stable workspace instructions, alternating conversation
 * metadata and stable child policy model warm runs of two sessions.
 * The child case compares launch-only versus every-run delivery of the same policy.
 * Counts cover rendered-prefix changes and prompt updates, not cache hits or billing.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { GCProfiler } from "node:v8";
import { buildSystemUpdateMessage } from "../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import {
  prepareSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
} from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import {
  projectRuntimeContextFragments,
  splitExtraSystemPrompt,
} from "../../src/agents/internal-runtime-context.js";
import { buildSubagentSpawnEnvelope } from "../../src/agents/subagents/spawn/subagent-system-prompt.js";
import { buildAgentSystemPrompt } from "../../src/agents/system-prompt.js";

const [selection, mode, count = "2000"] = process.argv.slice(2);
const iterations = Number(count);
assert(selection === "base" || selection === "candidate" || selection === "paired");
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations % 4 === 0);
assert(globalThis.gc, "Pass --expose-gc");
const policies = ["Use the configured workspace policy.", "Keep configured group instructions."];
const conversation = ["operator", "completion"].map((source) => {
  const text = `Current conversation: ${source}. Channel: webchat. Account: synthetic. Surface: direct.\nUse the current source delivery target. The final reply is visible in this conversation.\nFor a completion, synthesize the result and continue the assigned task. Do not repeat the internal envelope or send a duplicate acknowledgement.`;
  return {
    extraSystemPrompt: `${policies[0]}\n\n${text}\n\n${policies[1]}`,
    extraSystemPromptTurnContext: { start: policies[0]!.length + 2, text },
  };
});
const child = buildSubagentSpawnEnvelope({
  completionMode: "collector",
  spawnMode: "session",
  task: "Inspect synthetic inputs.",
  childSessionKey: "agent:main:subagent:measure",
  childDepth: 1,
  maxSpawnDepth: 5,
}).systemPrompt;
const tools = Array.from({ length: 40 }, (_, index) => `fixture_tool_${index}`);
const stable = {
  workspaceDir: "/synthetic/workspace",
  contextFiles: [{ path: "AGENTS.md", content: "Synthetic workspace instruction.\n".repeat(1024) }],
  toolNames: tools,
  toolSchemaDirectoryPrompt: tools
    .map((name) => `${name}: read synthetic records with { query: string, limit?: number }`)
    .join("\n"),
};
async function measure(arm: "base" | "candidate", pair: number) {
  const leases = [
    retainEmbeddedSessionPromptState("suffix-conversation"),
    retainEmbeddedSessionPromptState("suffix-child"),
  ];
  const priorPrompts: Array<string | undefined> = [];
  let changed = 0;
  let updates = 0;
  let restarts = 0;
  let encodedChars = 0;
  function runOne(index: number) {
    const childRun = index % 2 === 1;
    const variant = Math.floor(index / 2) % 2;
    const extra = childRun
      ? { extraSystemPrompt: variant === 0 ? child : undefined }
      : conversation[variant]!;
    const split =
      arm === "base"
        ? { persistent: extra.extraSystemPrompt, turn: undefined }
        : childRun
          ? { persistent: child, turn: undefined }
          : splitExtraSystemPrompt(extra);
    const rendered = buildAgentSystemPrompt({
      ...stable,
      promptMode: childRun ? "minimal" : "full",
      extraSystemPrompt: split.persistent,
    });
    const slot = Number(childRun);
    changed += Number(priorPrompts[slot] !== undefined && priorPrompts[slot] !== rendered);
    priorPrompts[slot] = rendered;
    const projection = prepareSessionSystemPrompt({
      state: leases[slot]!.state,
      routeKey: "synthetic-route",
      entries: [],
      historyBoundaryCount: 0,
      systemPrompt: rendered,
    });
    projection.commit();
    updates += Number(Boolean(projection.update));
    restarts += Number(projection.restart);
    encodedChars += JSON.stringify({
      systemPrompt: projection.systemPrompt,
      update: projection.update,
      turn: split.turn
        ? buildSystemUpdateMessage(
            projectRuntimeContextFragments([
              {
                kind: "runtime-instruction",
                text: `Current turn instructions (apply only to this turn):\n\n${split.turn}`,
              },
            ]),
            "runtime-context",
            true,
          )
        : undefined,
    }).length;
  }
  const inspector = new Session();
  try {
    for (let index = 0; index < 100; index++) {
      runOne(index);
    }
    changed = updates = restarts = encodedChars = 0;
    globalThis.gc?.();
    if (mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const gc = new GCProfiler();
    gc.start();
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      runOne(index);
    }
    const elapsedMs = performance.now() - start;
    const usedCpu = process.threadCpuUsage(cpu);
    const collections = gc.stop()?.statistics ?? [];
    const profile =
      mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    assert.equal(restarts, 0);
    assert.equal(changed, arm === "base" ? iterations : 0);
    assert.equal(updates, arm === "base" ? iterations : 0);
    console.log(
      JSON.stringify({
        arm,
        pair,
        mode,
        iterations,
        childInstructionChars: child.length,
        toolCount: tools.length,
        renderedPrefixChanges: changed,
        promptUpdates: updates,
        restarts,
        encodedChars,
        elapsedMs,
        mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
        sampledBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
        allocationSamples: profile?.samples.length,
        gcMs: collections.reduce((sum, entry) => sum + entry.cost / 1000, 0),
        gcCollections: collections.length,
        maxPauseMs: Math.max(0, ...collections.map((entry) => entry.cost / 1000)),
        hostLoad,
        hostLoadAfter: loadavg(),
        memory: process.memoryUsage(),
        node: process.version,
      }),
    );
  } finally {
    inspector.disconnect();
    for (const lease of leases) {
      lease[Symbol.dispose]();
    }
  }
}

if (selection === "paired") {
  for (let pair = 1; pair <= 5; pair++) {
    const order = pair % 2 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
    for (const arm of order) {
      await measure(arm, pair);
    }
  }
} else {
  await measure(selection, 1);
}
