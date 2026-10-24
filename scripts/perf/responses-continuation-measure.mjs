// Owner proof only: no Gateway, provider, response-commit accounting, or GC claims.
// node --expose-gc scripts/perf/responses-continuation-measure.mjs BASELINE_ROOT CANDIDATE_ROOT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [baselineRoot, candidateRoot] = process.argv.slice(2);
assert(baselineRoot && candidateRoot, "supply baseline and candidate source roots");
assert(globalThis.gc, "--expose-gc is required outside measured windows");
const samples = 6;
const cpuCalls = 20;
const allocationCalls = 10;
const samplingInterval = 32768;
const localRoot = path.resolve(".local");
mkdirSync(localRoot, { recursive: true });
const generatedRoot = mkdtempSync(path.join(localRoot, "responses-continuation-measure-"));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const sourcePaths = [
  "src/agents/embedded-agent-runner/session-fork.ts",
  "packages/ai/src/transports/model-request-body.ts",
  "packages/ai/src/transports/openai-responses-continuation.ts",
  "packages/ai/src/transports/openai-responses-reasoning-update.ts",
  "packages/ai/src/transports/openai-responses-tool-call-id-shape.ts",
  "packages/ai/src/transports/json-unsafe-integers.ts",
  "packages/normalization-core/src/record-coerce.ts",
];
const sourceNames = new Set(sourcePaths.map((file) => path.basename(file, ".ts")));
const adapterNames = new Set([
  "@openclaw/ai",
  "@openclaw/ai/internal/runtime",
  "@openclaw/ai/internal/shared",
  "@openclaw/normalization-core/node-crypto",
  "fetch-request-authority",
  "immutable-data",
  "content-blocks",
  "usage",
  "usage-accumulator",
  "host",
  "session-resources",
  "transport-utils",
]);
const adapters = `
import { createHash } from "node:crypto";
// Only external host/network/lifecycle services are adapted; measured owners remain intact.
export const getAiTransportHost = () => ({
  runInDetachedAsyncContext: fn => fn(),
  inheritManagedTransport: (_model, replacement) => replacement,
});
export const registerSessionResourceCleanup = () => {};
export const getSessionResourceOwnerId = () => "synthetic-owner";
export const resolveAiTransportHeaderSentinels = value => value;
export const isCredentialFieldName = () => { throw new Error("Headers are outside this probe"); };
export const independentResponsesRequest = { set() {} };
export const responsesRequestLifecycle = { set() {} };
export const preparedRequestSuffix = { mark() {} };
export const withGuardedFetchRequestAuthority = async (check, fn) => { check(); return fn(); };
export const isPlainData = () => { throw new Error("Publication capture is outside this probe"); };
export const collectTextContentBlocks = blocks => blocks.filter(x => x.type === "text").map(x => x.text);
export const normalizeUsage = () => undefined;
export const createUsageAccumulator = () => ({});
export const mergeUsageIntoAccumulator = () => {};
export const toNormalizedUsage = () => undefined;
export const sha256Hex = value => createHash("sha256").update(value).digest("hex");
export const sha256StableValue = () => { throw new Error("Persisted fingerprints are outside this probe"); };
`;
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
  const hashes = {};
  for (const file of sourcePaths) {
    const source = readFileSync(path.join(root, file), "utf8");
    hashes[file] = createHash("sha256").update(source).digest("hex");
    writeFileSync(path.join(directory, path.basename(file)), source);
  }
  writeFileSync(path.join(directory, "adapters.mjs"), adapters);
  writeFileSync(
    path.join(directory, "openai.mjs"),
    `
export { modelRequestBodyState } from "./model-request-body.ts";
export { independentResponsesRequest, responsesRequestLifecycle } from "./adapters.mjs";
`,
  );
  const owner = { url, hashes };
  capsules.set(side, owner);
  Object.assign(
    owner,
    await import(`${url}openai-responses-continuation.ts`),
    await import(`${url}model-request-body.ts`),
    await import(`${url}session-fork.ts`),
  );
  return owner;
}
const owners = {
  baseline: await load("baseline", baselineRoot),
  candidate: await load("candidate", candidateRoot),
};
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
const marker = "continuation-owner-history:";
function fixture(size) {
  const text = (index) => `${marker}${index}:`.padEnd(4096, "x");
  const input = Array.from({ length: size }, (_, index) => {
    switch (index % 4) {
      case 0:
        return { role: "user", content: text(index) };
      case 1:
        return {
          type: "message",
          role: "assistant",
          id: `msg_${index}`,
          status: "completed",
          content: [{ type: "output_text", text: text(index), annotations: [] }],
        };
      case 2:
        return {
          type: "function_call",
          call_id: `call_${index}`,
          name: "lookup",
          arguments: JSON.stringify({ text: text(index) }),
        };
      default:
        return { type: "function_call_output", call_id: `call_${index - 1}`, output: text(index) };
    }
  });
  const lastRequest = {
    model: model.id,
    input,
    stream: true,
    store: true,
    tools: [],
    instructions: "Stable instructions",
  };
  const output = [
    {
      type: "message",
      role: "assistant",
      id: "msg_latest",
      status: "completed",
      content: [{ type: "output_text", text: "Latest answer", annotations: [] }],
    },
  ];
  return {
    state: { lastRequest, lastResponseId: "resp_previous", lastResponseItems: output },
    full: {
      ...lastRequest,
      input: [
        ...structuredClone(input),
        ...structuredClone(output),
        { role: "user", content: "Continue" },
      ],
    },
  };
}
async function capture(owner, label) {
  const identity = { sessionId: label, runId: "run", agentId: "agent" };
  const context = { messages: [] };
  const done = {
    result: async () => ({ content: [{ type: "text", text: "Answer" }], stopReason: "stop" }),
  };
  let options;
  let replayed;
  const parent = owner.wrapStreamFnWithSessionFork(async (_model, current, requestOptions) => {
    if (current === context) {
      options = requestOptions;
      owner.prepareModelRequestBody(options);
    } else {
      replayed = await requestOptions.onPayload({ input: [] }, model);
    }
    return done;
  }, identity);
  await parent(model, context, {});
  const encode = owner.prepareModelRequestBody(options);
  return {
    async run(value) {
      await options.onPayload(value.full, model);
      const resolved = owner.resolveResponsesContinuationRequest(value.state, value.full);
      assert.equal(resolved.continuationStatus, "continued");
      return (await encode(resolved.request)).body;
    },
    async snapshot() {
      await owner.runEmbeddedSessionFork({
        ...identity,
        model,
        question: "Review",
        assertCurrent() {},
      });
      const json = JSON.stringify(replayed);
      replayed = undefined;
      return json;
    },
    clear() {
      owner.clearEmbeddedSessionForkSnapshot(identity.sessionId);
    },
  };
}
async function counts(run, value) {
  const stringify = JSON.stringify;
  const result = {
    calls: 1,
    fullHistorySerializations: 0,
    fullHistorySerializedBytes: 0,
    totalSerializations: 0,
    totalSerializedBytes: 0,
  };
  JSON.stringify = function (input, ...args) {
    const json = stringify.call(JSON, input, ...args);
    if (json !== undefined) {
      result.totalSerializations++;
      result.totalSerializedBytes += Buffer.byteLength(json);
      if (json.includes(marker)) {
        result.fullHistorySerializations++;
        result.fullHistorySerializedBytes += Buffer.byteLength(json);
      }
    }
    return json;
  };
  try {
    await run(value);
    return result;
  } finally {
    JSON.stringify = stringify;
  }
}
async function retained(owner, size, side) {
  const session = await capture(owner, `${side}-retention-${size}`);
  let references;
  await (async () => {
    const value = fixture(size);
    references = [
      new WeakRef(value.full),
      new WeakRef(value.full.input),
      new WeakRef(value.full.input[0]),
    ];
    await session.run(value);
  })();
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    globalThis.gc();
  }
  assert(
    references.every((reference) => reference.deref() === undefined),
    `${side}: retained prepared payload`,
  );
  const snapshot = await session.snapshot();
  assert.equal(JSON.parse(snapshot).input.length, size + 2);
  session.clear();
  return {
    weakReferences: references.length,
    collected: references.length,
    snapshotBytes: Buffer.byteLength(snapshot),
  };
}
const inspector = new Session();
inspector.connect();
const results = [];
let checksum = 0;
try {
  console.log(
    JSON.stringify({
      protocol: "responses-continuation-owner-v1",
      runtime: process.version,
      scope:
        "Validation + wire encoding + fork capture; explicit external adapters; excludes provider/Gateway and response-commit accounting",
      samplesPerSide: samples,
      cpuCallsPerSample: cpuCalls,
      allocationCallsPerSample: allocationCalls,
      samplingInterval,
      includeCollectedObjects: true,
      bytesPerMessageField: 4096,
      hashes: { baseline: owners.baseline.hashes, candidate: owners.candidate.hashes },
    }),
  );
  for (const size of [200, 1000]) {
    const value = fixture(size);
    const sessions = {
      baseline: await capture(owners.baseline, `baseline-${size}`),
      candidate: await capture(owners.candidate, `candidate-${size}`),
    };
    const expected = JSON.stringify(value.full);
    const before = await counts((input) => sessions.baseline.run(input), value);
    const after = await counts((input) => sessions.candidate.run(input), value);
    const wire = await Promise.all(
      Object.values(sessions).map(async (session) => (await session.run(value)).text()),
    );
    const snapshots = await Promise.all(
      Object.values(sessions).map((session) => session.snapshot()),
    );
    assert.equal(wire[0], wire[1], "wire byte parity");
    assert.equal(snapshots[0], expected, "baseline capture byte parity");
    assert.equal(snapshots[1], expected, "candidate capture byte parity");
    console.log(
      JSON.stringify({
        size,
        proof: {
          baseline: before,
          candidate: after,
          wireBytes: Buffer.byteLength(wire[0]),
          snapshotBytes: Buffer.byteLength(expected),
          byteParity: true,
        },
      }),
    );
    for (const session of Object.values(sessions)) {
      for (let warmup = 0; warmup < 5; warmup++) {
        checksum += (await session.run(value)).size;
      }
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const side of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const session = sessions[side];
        globalThis.gc();
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        for (let call = 0; call < cpuCalls; call++) {
          checksum += (await session.run(value)).size;
        }
        const elapsedMs = performance.now() - start;
        const cpu = process.cpuUsage(cpuStart);
        globalThis.gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        for (let call = 0; call < allocationCalls; call++) {
          checksum += (await session.run(value)).size;
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const ownedIds = new Set();
        function visit(node, owned = false) {
          const inOwner = owned || node.callFrame.url.startsWith(owners[side].url);
          if (inOwner) {
            ownedIds.add(node.id);
          }
          return (
            (inOwner ? node.selfSize : 0) +
            node.children.reduce((sum, child) => sum + visit(child, inOwner), 0)
          );
        }
        const allocatedBytes = visit(profile.head);
        const allocationSamples = profile.samples.filter((allocation) =>
          ownedIds.has(allocation.nodeId),
        ).length;
        assert(allocatedBytes > 0, "missing owner allocation samples");
        const result = {
          size,
          side,
          sample,
          cpuCalls,
          cpuMsPerCall: (cpu.user + cpu.system) / 1000 / cpuCalls,
          elapsedMsPerCall: elapsedMs / cpuCalls,
          allocationCalls,
          allocationSamples,
          bytesPerCall: allocatedBytes / allocationCalls,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    for (const session of Object.values(sessions)) {
      session.clear();
    }
    console.log(
      JSON.stringify({
        size,
        retention: {
          baseline: await retained(owners.baseline, size, "baseline"),
          candidate: await retained(owners.candidate, size, "candidate"),
        },
      }),
    );
    const means = Object.fromEntries(
      ["baseline", "candidate"].map((side) => {
        const rows = results.filter((row) => row.side === side && row.size === size);
        return [
          side,
          {
            samples: rows.length,
            cpuCalls: rows.reduce((sum, row) => sum + row.cpuCalls, 0),
            allocationCalls: rows.reduce((sum, row) => sum + row.allocationCalls, 0),
            allocationSamples: rows.reduce((sum, row) => sum + row.allocationSamples, 0),
            meanCpuMsPerCall: rows.reduce((sum, row) => sum + row.cpuMsPerCall, 0) / rows.length,
            meanBytesPerCall: rows.reduce((sum, row) => sum + row.bytesPerCall, 0) / rows.length,
            minBytesPerCall: Math.min(...rows.map((row) => row.bytesPerCall)),
            maxBytesPerCall: Math.max(...rows.map((row) => row.bytesPerCall)),
          },
        ];
      }),
    );
    const deltaBytes = means.candidate.meanBytesPerCall - means.baseline.meanBytesPerCall;
    const deltaCpuMs = means.candidate.meanCpuMsPerCall - means.baseline.meanCpuMsPerCall;
    console.log(
      JSON.stringify({
        summary: size,
        ...means,
        deltaBytesPerCall: deltaBytes,
        deltaBytesPercent: (deltaBytes / means.baseline.meanBytesPerCall) * 100,
        deltaCpuMsPerCall: deltaCpuMs,
        deltaCpuPercent: (deltaCpuMs / means.baseline.meanCpuMsPerCall) * 100,
      }),
    );
  }
  assert(checksum > 0);
} finally {
  inspector.disconnect();
  for (const owner of Object.values(owners)) {
    owner.clearEmbeddedSessionForkSnapshot();
  }
  hooks.deregister();
}
