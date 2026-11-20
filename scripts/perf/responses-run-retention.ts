/**
 * Repeated real Responses conversion, sanitation, fingerprinting and HTTP continuation ownership.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-run-retention.ts
 * Run fresh A/A processes; --retained samples live allocation sites, --allocation includes garbage.
 * Fixed session/history size distinguishes per-run retention from current-session baselines.
 * Default: 20 independent 2,000-entry user/tool/assistant histories, 512-character payloads,
 * ten rounds of 200 requests. Only each history's tail changes; this tests baseline replacement.
 * Require zero retired request/input/tail witnesses, exactly 20 current baselines, and full
 * collection after HTTP plus transcript cleanup. Report post-GC old_space + large_object_space
 * and process CPU; sampled runs are separate from untraced A/A timing controls.
 * No Gateway, provider network, database or workspace scan is represented by this owner fixture.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  responsesContinuationPrefixFingerprint,
} from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { transformTransportMessages } from "../../src/agents/transport-message-transform.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "20" },
    entries: { type: "string", default: "2000" },
    rounds: { type: "string", default: "10" },
    turns: { type: "string", default: "200" },
    retained: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
  },
});
assert(!(values.retained && values.allocation), "Use separate retained and allocation processes");
const integer = (name: "sessions" | "entries" | "rounds" | "turns") =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback: 1 });
const sessions = integer("sessions"),
  entries = integer("entries"),
  rounds = integer("rounds"),
  turns = integer("turns");
assert(entries >= 4 && entries % 4 === 0, "--entries must be a positive multiple of four");
assert(
  turns >= sessions && turns % sessions === 0,
  "--turns must cover complete session rotations",
);
assert(globalThis.gc, "Use --expose-gc");
const detached = AsyncLocalStorage.snapshot();
const host = createAiTransportHost({
  runInDetachedAsyncContext: (run) => detached(run),
  transformTransportMessages,
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
});
const model: Model = {
  id: "fixture-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://provider.invalid/v1",
  reasoning: false,
  input: ["text"],
  compat: { supportsInstructions: true, supportsResponsesContinuation: true },
  contextWindow: 1_000_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const histories: Context[] = Array.from({ length: sessions }, (_, session) => {
  const messages: Context["messages"] = [];
  for (let index = 0; index < entries / 4; index++) {
    const id = `call_${session}_${index}`;
    const text = (kind: string) => `${kind} ${session}/${index} `.padEnd(512, "x");
    messages.push(
      { role: "user", content: text("question"), timestamp: index },
      {
        role: "assistant",
        provider: model.provider,
        api: model.api,
        model: model.id,
        responseId: `resp_${session}_${index}_tool`,
        timestamp: index,
        stopReason: "toolUse",
        usage,
        content: [{ type: "toolCall", id, name: "lookup", arguments: { query: text("lookup") } }],
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "lookup",
        timestamp: index,
        isError: false,
        content: [{ type: "text", text: text("result") }],
      },
      {
        role: "assistant",
        provider: model.provider,
        api: model.api,
        model: model.id,
        responseId: `resp_${session}_${index}_answer`,
        timestamp: index,
        stopReason: "stop",
        usage,
        content: [{ type: "text", text: text("answer"), textSignature: `msg_${session}_${index}` }],
      },
    );
  }
  messages.forEach(freezeJsonSnapshot);
  return { systemPrompt: "Synthetic fixed-session retention measurement.", messages };
});
type Witness = {
  params: WeakRef<object>;
  request: WeakRef<object>;
  full: WeakRef<object>;
  claim: WeakRef<object>;
  input: WeakRef<object>;
  tail: WeakRef<object>;
};
const latest = new Map<number, Witness>();
const retired: Witness[] = [];
let serial = 0;
let lastFingerprint = "";
function runTurn(session: number) {
  const history = histories[session]!;
  // Replace one tail message instead of growing the transcript: old runs must not accumulate.
  history.messages[entries - 1] = freezeJsonSnapshot({
    role: "user",
    timestamp: serial,
    content: `Synthetic tail session ${session}, turn ${serial++}`,
  });
  const params = buildOpenAIResponsesParams(model, history, { sessionId: `retention-${session}` });
  const request = sanitizeResponsesImagePayload(params);
  lastFingerprint = responsesContinuationPrefixFingerprint(request.input ?? []);
  const claim = claimOpenAIResponsesHttpContinuation({
    sessionId: `retention-${session}`,
    apiKey: "synthetic-not-a-credential",
    baseUrl: model.baseUrl,
    headers: {},
    request,
  });
  assert(claim);
  try {
    const input = claim.fullRequest.input;
    assert(input);
    const tail = input.at(-1);
    assert(tail && typeof tail === "object");
    claim.commit(
      claim.fullRequest,
      { id: `resp_completed_${serial}`, output: [] },
      claim.request.previous_response_id,
    );
    const prior = latest.get(session);
    if (prior) {
      retired.push(prior);
    }
    latest.set(session, {
      params: new WeakRef(params),
      request: new WeakRef(request),
      full: new WeakRef(claim.fullRequest),
      claim: new WeakRef(claim),
      input: new WeakRef(input),
      tail: new WeakRef(tail),
    });
  } finally {
    claim.release();
  }
}
async function collect() {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    globalThis.gc!();
  }
  const spaces = getHeapSpaceStatistics();
  return {
    heapUsed: process.memoryUsage().heapUsed,
    oldGeneration: spaces
      .filter((space) => ["old_space", "large_object_space"].includes(space.space_name))
      .reduce((sum, space) => sum + space.space_used_size, 0),
  };
}
function living(witnesses: Iterable<Witness>) {
  const counts = { params: 0, request: 0, full: 0, claim: 0, input: 0, tail: 0 };
  for (const witness of witnesses) {
    for (const key of ["params", "request", "full", "claim", "input", "tail"] as const) {
      if (witness[key].deref()) {
        counts[key]++;
      }
    }
  }
  return counts;
}
const inspector = new Session();
async function sites() {
  const { profile } = await inspector.post("HeapProfiler.getSamplingProfile");
  const totals = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const owners = new Set([
    "buildOpenAIResponsesParams",
    "convertResponsesMessages",
    "convertMessage",
    "sanitizeResponsesImagePayload",
    "claimOpenAIResponsesHttpContinuation",
    "resolveResponsesContinuationRequest",
    "responsesContinuationPrefixFingerprint",
    "retainedJsonBytes",
  ]);
  const visit = (node: typeof profile.head): number => {
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
    if (node.selfSize) {
      totals.set(key, (totals.get(key) ?? 0) + node.selfSize);
    }
    const bytes = node.selfSize + node.children.reduce((sum, child) => sum + visit(child), 0);
    if (owners.has(frame.functionName)) {
      inclusive.set(frame.functionName, (inclusive.get(frame.functionName) ?? 0) + bytes);
    }
    return bytes;
  };
  visit(profile.head);
  return {
    sampledBytes: [...totals.values()].reduce((sum, bytes) => sum + bytes, 0),
    inclusiveSites: Object.fromEntries(inclusive),
    sites: [...totals]
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, 30)
      .map(([site, bytes]) => ({ site, bytes })),
  };
}
console.log(
  JSON.stringify({
    kind: "fixture",
    node: process.version,
    sessions,
    entries,
    rounds,
    turns,
    mode: values.retained ? "retained" : values.allocation ? "allocation" : "untraced",
    sources: Object.fromEntries(
      [
        "packages/ai/src/transports/openai-responses-continuation.ts",
        "packages/ai/src/transports/openai-responses-params-internal.ts",
        "packages/ai/src/transports/openai-responses-replay-internal.ts",
      ].map((path) => [path, hash("sha256", readFileSync(path))]),
    ),
    load: loadavg(),
  }),
);
await runWithAiTransportHost(host, async () => {
  try {
    for (let session = 0; session < sessions; session++) {
      runTurn(session);
    }
    const warm = await collect();
    assert.equal(
      living(latest.values()).full,
      sessions,
      "Fixture must fit the continuation budget",
    );
    console.log(JSON.stringify({ kind: "warm", ...warm, latest: living(latest.values()) }));
    if (values.retained || values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: values.allocation,
        includeObjectsCollectedByMinorGC: values.allocation,
      });
    }
    for (let round = 0; round < rounds; round++) {
      await nextTurn();
      const cpu = process.cpuUsage(),
        start = performance.now();
      for (let turn = 0; turn < turns; turn++) {
        runTurn(turn % sessions);
      }
      const wallMs = performance.now() - start,
        elapsed = process.cpuUsage(cpu);
      const memory = await collect();
      const old = living(retired),
        current = living(latest.values());
      assert.deepEqual(old, { params: 0, request: 0, full: 0, claim: 0, input: 0, tail: 0 });
      assert.equal(current.full, sessions);
      assert.equal(current.input, sessions);
      assert.equal(current.tail, sessions);
      assert.equal(current.params, 0);
      assert.equal(current.claim, 0);
      retired.length = 0;
      console.log(
        JSON.stringify({
          kind: "round",
          round,
          completedTurns: (round + 1) * turns,
          ...memory,
          oldGenerationDelta: memory.oldGeneration - warm.oldGeneration,
          wallMs,
          cpuMs: (elapsed.user + elapsed.system) / 1000,
          retired: old,
          latest: current,
          fingerprint: lastFingerprint,
          load: loadavg(),
          ...(values.retained || (values.allocation && round === rounds - 1) ? await sites() : {}),
        }),
      );
    }
  } finally {
    cleanupSessionResources(undefined, host);
  }
  const released = await collect();
  const afterRelease = living(latest.values());
  assert.equal(afterRelease.full, 0);
  assert.equal(afterRelease.input, 0);
  console.log(JSON.stringify({ kind: "released", ...released, latest: afterRelease }));
  // The conversion cache follows immutable transcript messages, independently of HTTP cleanup.
  histories.length = 0;
  const sourcesReleased = await collect();
  assert.deepEqual(living(latest.values()), {
    params: 0,
    request: 0,
    full: 0,
    claim: 0,
    input: 0,
    tail: 0,
  });
  console.log(
    JSON.stringify({
      kind: "sources-released",
      ...sourcesReleased,
      latest: living(latest.values()),
    }),
  );
});
if (values.retained || values.allocation) {
  await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
}
