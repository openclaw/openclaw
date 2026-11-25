// Synthetic owner proof: --expose-gc --import ./scripts/tsx.mjs; no provider/network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { Agent } from "../../packages/agent-core/src/agent.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createAssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.js";
import type { Model } from "../../packages/llm-core/src/types.js";
import { buildAttemptSystemPrompt } from "../../src/agents/embedded-agent-runner/run/attempt-system-prompt.js";
import * as currentSessionOwner from "../../src/agents/embedded-agent-runner/session-prompt-state.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "session-owner": { type: "string" },
    mode: { type: "string", default: "retention" },
    runs: { type: "string", default: "65" },
    batches: { type: "string", default: "10" },
    snapshot: { type: "string" },
    "assert-shared": { type: "boolean" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["retention", "timing", "allocation"].includes(values.mode));
const runs = Number(values.runs);
const batches = Number(values.batches);
assert(Number.isSafeInteger(runs) && runs >= 50);
assert(Number.isSafeInteger(batches) && batches > 0);
const build: typeof buildAttemptSystemPrompt = values.owner
  ? (await import(pathToFileURL(values.owner).href)).buildAttemptSystemPrompt
  : buildAttemptSystemPrompt;
const sessionOwner: typeof currentSessionOwner = values["session-owner"]
  ? await import(pathToFileURL(values["session-owner"]).href)
  : currentSessionOwner;
const inputs = [134, 158, 186].map((kib, generation) => ({
  isRawModelRun: false,
  embeddedSystemPrompt: {
    workspaceDir: "/synthetic",
    promptMode: "minimal" as const,
    contextFiles: [
      {
        path: "/synthetic/AGENTS.md",
        content: `Synthetic generation ${generation}.\n`.padEnd(kib * 1024, "x"),
      },
    ],
  },
  transformSystemPrompt: (text: string) => text,
}));
const model: Model = {
  id: "synthetic-model",
  name: "Synthetic model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  compat: { supportsInstructions: true },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 256,
};
const digest = createHash("sha256");
let serial = 0;
let requests = 0;
async function batch() {
  const preparations = await Promise.all(
    Array.from({ length: runs }, (_, i) => {
      const input = inputs[i % inputs.length];
      assert(input);
      return build(input);
    }),
  );
  const leases = preparations.map(() =>
    sessionOwner.retainEmbeddedSessionPromptState(`synthetic-${serial++}`),
  );
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let seen = 0;
  const agents = preparations.map((prepared, index) => {
    const lease = leases[index];
    const expected = inputs[index % inputs.length]?.embeddedSystemPrompt.contextFiles[0]?.content;
    assert(lease && expected);
    const pin = sessionOwner.prepareSessionSystemPrompt({
      state: lease.state,
      routeKey: "synthetic/model",
      systemPrompt: prepared.systemPrompt,
      entries: [],
    });
    pin.commit();
    return new Agent({
      initialState: { model, systemPrompt: pin.systemPrompt, tools: [] },
      streamFn: (_model, context) => {
        const params = buildOpenAIResponsesParams(model, context, undefined);
        const instructions = params.instructions;
        assert(typeof instructions === "string");
        assert(instructions.includes(expected));
        assert(!instructions.includes("OPENCLAW_CACHE_BOUNDARY"));
        digest.update(instructions);
        requests++;
        if (++seen === runs) {
          ready();
        }
        const stream = createAssistantMessageEventStream();
        void barrier.then(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
              timestamp: 1,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
          stream.end();
        });
        return stream;
      },
    });
  });
  const pending = agents.map((agent) => agent.prompt("Synthetic request."));
  await entered;
  const weak =
    values.mode === "retention" ? preparations.map((prepared) => new WeakRef(prepared)) : [];
  return {
    preparations,
    agents,
    leases,
    weak,
    async settle() {
      finish();
      await Promise.all(pending);
      for (const lease of leases) {
        lease[Symbol.dispose]();
      }
      preparations.length = 0;
      agents.length = 0;
      leases.length = 0;
    },
  };
}
async function collect() {
  /./.test(" ");
  for (let i = 0; i < 3; i++) {
    await setImmediate();
    global.gc!();
  }
}
function memory() {
  return {
    heap: process.memoryUsage().heapUsed,
    oldGen: getHeapSpaceStatistics()
      .filter(
        (space) => space.space_name === "old_space" || space.space_name === "large_object_space",
      )
      .reduce((sum, space) => sum + space.space_used_size, 0),
  };
}
await (await batch()).settle();
await collect();
const startLoad = loadavg();
if (values.mode === "retention") {
  const before = memory();
  const active = await batch();
  await collect();
  const live = memory();
  const chars = active.preparations.slice(0, 3).map((prepared) => prepared.systemPrompt.length);
  if (values.snapshot) {
    writeHeapSnapshot(values.snapshot);
  }
  await active.settle();
  await collect();
  const idle = memory();
  const survivors = active.weak.filter((ref) => ref.deref()).length;
  assert.equal(survivors, 0, "Completed attempts retained their prepared prompts");
  console.log(
    JSON.stringify({
      mode: values.mode,
      runs,
      chars,
      before,
      live,
      idle,
      survivors,
      retainedHeap: live.heap - before.heap,
      retainedOldGen: live.oldGen - before.oldGen,
      requests,
      digest: digest.digest("hex"),
      node: process.version,
      startLoad,
    }),
  );
  if (values["assert-shared"]) {
    assert(
      live.heap - before.heap < 4 * 1024 ** 2,
      "Attempts retain separate copies of the same prompt",
    );
  }
} else {
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const times = [];
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < batches; i++) {
    const start = performance.now();
    await (await batch()).settle();
    times.push(performance.now() - start);
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      runs,
      batches,
      wallMs,
      times,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes,
      requests,
      digest: digest.digest("hex"),
      node: process.version,
      startLoad,
      endLoad: loadavg(),
    }),
  );
}
