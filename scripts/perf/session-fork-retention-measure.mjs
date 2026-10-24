// Owner-only retention proof. Run on the benchmark host, never against a live Gateway.
// node --expose-gc scripts/perf/session-fork-retention-measure.mjs BASE_ROOT CANDIDATE_ROOT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [baselineRoot, candidateRoot] = process.argv.slice(2);
assert(baselineRoot && candidateRoot, "supply baseline and candidate source roots");
assert(globalThis.gc, "--expose-gc is required");
const samples = 6;
const rounds = 3;
const MiB = 1024 * 1024;
const workloads = [
  { name: "near-cap", sessions: 64, payloadBytes: MiB - 1024, optionNodes: 0, blobBytes: 0 },
  { name: "graph-options", sessions: 1000, payloadBytes: 1024, optionNodes: 128, blobBytes: 0 },
  {
    name: "opaque-publication",
    sessions: 3,
    payloadBytes: 1024,
    optionNodes: 0,
    blobBytes: 22 * MiB,
    sourceBlobBytes: 64 * MiB,
  },
];
const sourcePaths = [
  "src/agents/embedded-agent-runner/session-fork.ts",
  "src/shared/immutable-data.ts",
  "packages/ai/src/transports/model-request-body.ts",
  "packages/normalization-core/src/record-coerce.ts",
];
const sourceNames = new Set(sourcePaths.map((file) => path.basename(file, ".ts")));
const adapters = `
// Host, network and accounting adapters only; storage/capture/encoding owners are unchanged.
export const getAiTransportHost = () => ({
  runInDetachedAsyncContext: fn => fn(),
  inheritManagedTransport: (_model, replacement) => replacement,
});
export const registerSessionResourceCleanup = () => {};
export const isCredentialFieldName = () => { throw new Error("Headers are outside this probe"); };
export const independentResponsesRequest = { set() {} };
export const responsesRequestLifecycle = { set() {} };
export const preparedRequestSuffix = { mark() {} };
export const withGuardedFetchRequestAuthority = async (check, fn) => { check(); return fn(); };
export const collectTextContentBlocks = blocks => blocks.filter(x => x.type === "text").map(x => x.text);
export const normalizeUsage = () => undefined;
export const createUsageAccumulator = () => ({});
export const mergeUsageIntoAccumulator = () => {};
export const toNormalizedUsage = () => undefined;
`;
const adapterNames = new Set([
  "@openclaw/ai",
  "@openclaw/ai/internal/runtime",
  "@openclaw/ai/internal/shared",
  "fetch-request-authority",
  "content-blocks",
  "usage",
  "usage-accumulator",
]);
const localRoot = path.resolve(".local");
mkdirSync(localRoot, { recursive: true });
const generatedRoot = mkdtempSync(path.join(localRoot, "session-fork-retention-"));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const capsules = new Map();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const capsule = [...capsules.values()].find((entry) =>
      context.parentURL?.startsWith(entry.url),
    );
    if (!capsule || specifier.startsWith("node:")) {
      return nextResolve(specifier, context);
    }
    if (specifier === "@openclaw/ai/internal/openai") {
      return { url: `${capsule.url}openai.mjs`, shortCircuit: true };
    }
    const name = path.basename(specifier).replace(/\.js$/, "");
    if (sourceNames.has(name)) {
      return { url: `${capsule.url}${name}.ts`, shortCircuit: true };
    }
    if (adapterNames.has(specifier) || adapterNames.has(name)) {
      return { url: `${capsule.url}adapters.mjs`, shortCircuit: true };
    }
    if (specifier.startsWith("./")) {
      return nextResolve(specifier, context);
    }
    throw new Error(`Unreviewed owner dependency: ${specifier}`);
  },
});

async function load(side, root) {
  const directory = path.join(generatedRoot, side);
  mkdirSync(directory);
  const url = `${pathToFileURL(directory).href}/`;
  const owner = { url, hashes: {} };
  for (const file of sourcePaths) {
    const source = readFileSync(path.join(root, file), "utf8");
    owner.hashes[file] = createHash("sha256").update(source).digest("hex");
    writeFileSync(path.join(directory, path.basename(file)), source);
  }
  writeFileSync(path.join(directory, "adapters.mjs"), adapters);
  writeFileSync(
    path.join(directory, "openai.mjs"),
    'export { modelRequestBodyState } from "./model-request-body.ts";\n' +
      'export { independentResponsesRequest, responsesRequestLifecycle } from "./adapters.mjs";\n',
  );
  capsules.set(side, owner);
  Object.assign(
    owner,
    await import(`${url}session-fork.ts`),
    await import(`${url}model-request-body.ts`),
  );
  owner.transport = createTransport(owner);
  return owner;
}

const model = {
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "https://synthetic.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const identity = (workload, index) => ({
  sessionId: `${workload.name}-${index}`,
  agentId: "synthetic-agent",
  runId: "synthetic-run",
});
const label = (workload, index, round) => `${workload.name}:${index}:${round}`;
const payload = (messages) => ({ model: model.id, input: messages, stream: true });

function parentMessage(workload, index, round) {
  const message = { role: "user", content: `${label(workload, index, round)}|`, timestamp: round };
  const padding = workload.payloadBytes - Buffer.byteLength(JSON.stringify(payload([message])));
  assert(padding >= 0);
  message.content += "x".repeat(padding);
  return message;
}

// One transport per source capsule, shared by all sessions; no request state in its closure.
function createTransport(owner) {
  return async (requestModel, context, options) => {
    const isFork = options.asyncToolExecution === false;
    const encode = isFork ? undefined : owner.prepareModelRequestBody(options);
    const prepared = await options.onPayload(payload(context.messages), requestModel);
    if (!isFork) {
      await encode(
        context.messages[0].timestamp === 0
          ? prepared
          : { ...prepared, input: [], previous_response_id: "synthetic-previous-response" },
      );
    } else {
      const question = context.messages.at(-1).content;
      const { name, index, round } = JSON.parse(question);
      const workload = workloads.find((item) => item.name === name);
      assert(workload, "unknown replay workload");
      assert.equal(prepared.input.length, 3, "one prefix, one publication, one question");
      assert.deepEqual(prepared.input[0], parentMessage(workload, index, round));
      assert.equal(prepared.input[1].content[0].text, `published:${label(workload, index, round)}`);
      assert.equal(prepared.input[2].content, question);
      assert.equal(prepared.previous_response_id, undefined);
      if (workload.optionNodes) {
        assert.equal(options.metadata.nodes.length, workload.optionNodes);
        assert.equal(options.metadata.nodes[0].label, `${label(workload, index, round)}:0`);
      }
      if (workload.blobBytes) {
        const details = context.messages[0].details;
        assert(details.blob instanceof Blob);
        assert.equal(details.blob.size, workload.blobBytes);
        assert.equal(details.bytes[0], 7, "forks must not mutate retained opaque data");
        details.bytes[0] = 99;
      }
    }
    return {
      result: async () => ({ content: [{ type: "text", text: "verified" }], stopReason: "stop" }),
    };
  };
}

async function captureRound(owner, workload, round) {
  for (let index = 0; index < workload.sessions; index++) {
    const current = identity(workload, index);
    const parent = owner.wrapStreamFnWithSessionFork(owner.transport, current);
    const options = workload.optionNodes
      ? {
          metadata: {
            nodes: Array.from({ length: workload.optionNodes }, (_, node) => ({
              label: `${label(workload, index, round)}:${node}`,
              enabled: true,
              values: [node, node + 1, node + 2],
            })),
          },
        }
      : {};
    await (
      await parent(model, { messages: [parentMessage(workload, index, round)] }, options)
    ).result();
    owner.recordEmbeddedSessionForkMessage(current.sessionId, current.runId, {
      role: "toolResult",
      toolCallId: "synthetic-call",
      toolName: "synthetic-tool",
      content: [{ type: "text", text: `published:${label(workload, index, round)}` }],
      isError: false,
      timestamp: round,
      ...(workload.blobBytes
        ? {
            details: {
              // Each publication owns a fresh source; its visible slice pins that source on base.
              blob: new Blob([new Uint8Array(workload.sourceBlobBytes)]).slice(
                0,
                workload.blobBytes,
              ),
              bytes: new Uint8Array([7]),
            },
          }
        : {}),
    });
  }
}

async function memoryAfterGc() {
  // Leave fixture-creation jobs before collection; timers/maintenance remain enabled.
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    globalThis.gc();
  }
  const { heapUsed, external, arrayBuffers } = process.memoryUsage();
  // External and ArrayBuffer reporting can overlap; expose each component and
  // use their conservative sum so neither serialized nor Blob storage is omitted.
  return {
    heapUsed,
    external,
    arrayBuffers,
    conservativeAggregateBytes: heapUsed + external + arrayBuffers,
  };
}

async function countAndVerify(owner, workload, round) {
  let liveSnapshots = 0;
  let newestSurvives = false;
  for (let index = 0; index < workload.sessions; index++) {
    const fork = () =>
      owner.runEmbeddedSessionFork({
        ...identity(workload, index),
        model,
        question: JSON.stringify({ name: workload.name, index, round }),
        assertCurrent() {},
      });
    try {
      assert.equal(await fork(), "verified");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Cache-parity session fork requires a parent turn")
      ) {
        continue;
      }
      throw error;
    }
    liveSnapshots++;
    newestSurvives ||= index === workload.sessions - 1;
    assert.equal(await fork(), "verified", "second fork preserves opaque publication isolation");
  }
  assert(newestSurvives, "workload must leave a forkable newest prefix");
  return liveSnapshots;
}

async function measure(owner, workload, side, sample) {
  owner.clearEmbeddedSessionForkSnapshot();
  const before = await memoryAfterGc();
  const rows = [];
  try {
    for (let round = 0; round < rounds; round++) {
      await captureRound(owner, workload, round);
      // Await retained-data normalization through public replay, then collect
      // replay's temporary decoded graphs before measuring the settled store.
      const liveSnapshots = await countAndVerify(owner, workload, round);
      const after = await memoryAfterGc();
      const retainedDeltaBytes =
        after.conservativeAggregateBytes - before.conservativeAggregateBytes;
      rows.push({
        workload: workload.name,
        side,
        sample,
        rounds: round + 1,
        refreshWaves: round,
        sessionResets: 1,
        captureCalls: workload.sessions * (round + 1),
        publicationCalls: workload.sessions * (round + 1),
        liveSnapshots,
        replayChecks: liveSnapshots * 2,
        retainedRequestPayloadBytes: liveSnapshots * workload.payloadBytes,
        retainedOpaqueBlobBytes: liveSnapshots * workload.blobBytes,
        sourceBlobBytesPerSnapshot: workload.sourceBlobBytes ?? 0,
        visibleBlobBytesPerSnapshot: workload.blobBytes,
        before,
        after,
        heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
        externalDeltaBytes: after.external - before.external,
        arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
        retainedDeltaBytes,
        retainedBytesPerCapture: retainedDeltaBytes / (workload.sessions * (round + 1)),
        retainedBytesPerLiveSnapshot: retainedDeltaBytes / liveSnapshots,
      });
    }
    return rows;
  } finally {
    owner.clearEmbeddedSessionForkSnapshot();
  }
}

const owners = {
  baseline: await load("baseline", baselineRoot),
  candidate: await load("candidate", candidateRoot),
};
const results = [];
const mean = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
try {
  console.log(
    JSON.stringify({
      protocol: "session-fork-retention-owner-v1",
      runtime: process.version,
      samplesPerSide: samples,
      rounds,
      workloads,
      hashes: { baseline: owners.baseline.hashes, candidate: owners.candidate.hashes },
      scope:
        "Actual capture/retention/replay owners; adapted host/network/accounting; stateless synthetic transport",
      measurement:
        "Post-replay/post-GC whole-process heapUsed + external + arrayBuffers delta: conservative aggregate, not an exact retained graph or RSS. External and ArrayBuffer reporting can overlap; all components are reported separately",
      limits:
        "No live Gateway, real-provider, arbitrary transport-closure, CPU, GC-time or promotion claim",
    }),
  );
  for (const workload of workloads) {
    // Warm both capsules with the same complete workload before paired measurements.
    for (const side of ["baseline", "candidate"]) {
      await measure(owners[side], workload, side, -1);
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const side of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const rows = await measure(owners[side], workload, side, sample);
        results.push(...rows);
        for (const row of rows) {
          console.log(JSON.stringify(row));
        }
      }
    }
    for (let round = 1; round <= rounds; round++) {
      const selected = results.filter(
        (row) => row.workload === workload.name && row.rounds === round,
      );
      const sides = Object.fromEntries(
        ["baseline", "candidate"].map((side) => {
          const rows = selected.filter((row) => row.side === side);
          return [
            side,
            {
              samples: rows.length,
              meanHeapUsedDeltaBytes: mean(rows, "heapUsedDeltaBytes"),
              meanExternalDeltaBytes: mean(rows, "externalDeltaBytes"),
              meanArrayBuffersDeltaBytes: mean(rows, "arrayBuffersDeltaBytes"),
              meanRetainedDeltaBytes: mean(rows, "retainedDeltaBytes"),
              minRetainedDeltaBytes: Math.min(...rows.map((row) => row.retainedDeltaBytes)),
              maxRetainedDeltaBytes: Math.max(...rows.map((row) => row.retainedDeltaBytes)),
              meanLiveSnapshots: mean(rows, "liveSnapshots"),
              meanRetainedBytesPerCapture: mean(rows, "retainedBytesPerCapture"),
              meanRetainedBytesPerLiveSnapshot: mean(rows, "retainedBytesPerLiveSnapshot"),
            },
          ];
        }),
      );
      const pairedDeltas = Array.from({ length: samples }, (_, sample) => {
        const pair = selected.filter((row) => row.sample === sample);
        return (
          pair.find((row) => row.side === "candidate").retainedDeltaBytes -
          pair.find((row) => row.side === "baseline").retainedDeltaBytes
        );
      });
      const meanPairedDeltaBytes = pairedDeltas.reduce((sum, value) => sum + value, 0) / samples;
      console.log(
        JSON.stringify({
          summary: workload.name,
          rounds: round,
          ...sides,
          pairedDeltas,
          meanPairedDeltaBytes,
          meanPairedDeltaPercent:
            (100 * meanPairedDeltaBytes) / sides.baseline.meanRetainedDeltaBytes,
        }),
      );
    }
  }
} finally {
  for (const owner of Object.values(owners)) {
    owner.clearEmbeddedSessionForkSnapshot();
  }
  hooks.deregister();
}
