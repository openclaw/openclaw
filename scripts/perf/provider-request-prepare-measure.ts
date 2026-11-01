import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { serializeModelRequestBody } from "../../packages/ai/src/transports/model-request-body.ts";
import { prepareProviderPrompt } from "../../src/agents/embedded-agent-runner/provider-prompt-serialization.ts";

const { values } = parseArgs({
  options: {
    messages: { type: "string", default: "500" },
    iterations: { type: "string", default: "300" },
    mode: { type: "string", default: "prepare" },
    output: { type: "string" },
    "start-at": { type: "string" },
  },
});
const messages = Number(values.messages);
const iterations = Number(values.iterations);
if (![messages, iterations].every((value) => Number.isSafeInteger(value) && value > 0)) {
  throw new Error("--messages and --iterations must be positive integers");
}
if (values.mode !== "prepare" && values.mode !== "transport") {
  throw new Error("--mode must be prepare or transport");
}
if (!values.output || !globalThis.gc) {
  throw new Error("--output and node --expose-gc are required");
}
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const payload = {
  model: "synthetic-provider-model",
  stream: true,
  instructions: "Synthetic request allocation measurement.",
  tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  input: Array.from({ length: messages }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: [
      {
        type: index % 2 ? "output_text" : "input_text",
        text: `${index}:${"text 😀 ".repeat(128)}`,
      },
    ],
  })),
};
const expected = Buffer.from(JSON.stringify(payload));
const run = (value: unknown) =>
  values.mode === "prepare"
    ? prepareProviderPrompt({ payload: value, encode: true }).encoded!
    : serializeModelRequestBody(value);

// Independent JSON goldens protect custom normalization and observable access order.
function customPayload(events: string[]) {
  return {
    toJSON() {
      events.push("toJSON");
      return {
        get stream() {
          events.push("stream");
          return true;
        },
        get input() {
          events.push("input");
          return [{ text: "Unicode 😀", absent: undefined, finite: Number.NaN }];
        },
      };
    },
  };
}
const expectedEvents: string[] = [];
const actualEvents: string[] = [];
const customExpected = Buffer.from(JSON.stringify(customPayload(expectedEvents)));
const custom = run(customPayload(actualEvents));
assert.deepEqual(Buffer.from(custom.body), customExpected);
assert.deepEqual(actualEvents, expectedEvents);
assert.equal(custom.stream, true);
assert.deepEqual(Buffer.from(run(payload).body), expected);

const counts = {
  stringify: { calls: 0, bytes: 0, wholeRequestCalls: 0 },
  parse: { calls: 0, bytes: 0, wholeRequestCalls: 0 },
  encode: { calls: 0, bytes: 0, wholeRequestCalls: 0 },
  hash: { calls: 0, bytes: 0, wholeRequestCalls: 0 },
};
function record(kind: keyof typeof counts, value: unknown) {
  const bytes =
    typeof value === "string"
      ? Buffer.byteLength(value)
      : ArrayBuffer.isView(value)
        ? value.byteLength
        : 0;
  counts[kind].calls++;
  counts[kind].bytes += bytes;
  counts[kind].wholeRequestCalls += Number(bytes === expected.byteLength);
}
const stringify = JSON.stringify;
const parse = JSON.parse;
// oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver.
const encode = TextEncoder.prototype.encode;
const hash = crypto.hash;
// oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver.
const update = crypto.Hash.prototype.update;
// oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver.
const digest = crypto.Hash.prototype.digest;
const hashBytes = new WeakMap<crypto.Hash, number>();
try {
  JSON.stringify = new Proxy(stringify, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      record("stringify", result);
      return result;
    },
  });
  JSON.parse = new Proxy(parse, {
    apply(target, receiver, args) {
      record("parse", args[0]);
      return Reflect.apply(target, receiver, args);
    },
  });
  TextEncoder.prototype.encode = new Proxy(encode, {
    apply(target, receiver, args) {
      record("encode", args[0]);
      return Reflect.apply(target, receiver, args);
    },
  });
  crypto.hash = new Proxy(hash, {
    apply(target, receiver, args) {
      record("hash", args[1]);
      return Reflect.apply(target, receiver, args);
    },
  });
  crypto.Hash.prototype.update = new Proxy(update, {
    apply(target, receiver: crypto.Hash, args) {
      const value = args[0];
      const bytes =
        typeof value === "string" ? Buffer.byteLength(value, args[1]) : value.byteLength;
      hashBytes.set(receiver, (hashBytes.get(receiver) ?? 0) + bytes);
      return Reflect.apply(target, receiver, args);
    },
  });
  crypto.Hash.prototype.digest = new Proxy(digest, {
    apply(target, receiver: crypto.Hash, args) {
      const bytes = hashBytes.get(receiver) ?? 0;
      counts.hash.calls++;
      counts.hash.bytes += bytes;
      counts.hash.wholeRequestCalls += Number(bytes === expected.byteLength);
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  assert.deepEqual(Buffer.from(run(payload).body), expected);
} finally {
  JSON.stringify = stringify;
  JSON.parse = parse;
  TextEncoder.prototype.encode = encode;
  crypto.hash = hash;
  crypto.Hash.prototype.update = update;
  crypto.Hash.prototype.digest = digest;
  syncBuiltinESMExports();
}
for (let index = 0; index < 30; index++) {
  run(payload);
}
if (values["start-at"]) {
  const wait = Number(values["start-at"]) - Date.now();
  if (!Number.isFinite(wait) || wait <= 0) {
    throw new Error("--start-at must remain in the future after warmup");
  }
  await delay(wait);
}
globalThis.gc();
const session = new Session();
session.connect();
try {
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    run(payload);
  }
  const elapsedMs = performance.now() - started;
  const { profile } = await session.post("HeapProfiler.stopSampling");
  let sampledAllocatedBytes = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop()!;
    sampledAllocatedBytes += node.selfSize;
    pending.push(...node.children);
  }
  writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
  const result = {
    mode: values.mode,
    messages,
    iterations,
    requestBytes: expected.byteLength,
    goldenSha256: crypto.hash("sha256", expected),
    customGoldenSha256: crypto.hash("sha256", customExpected),
    customAccessOrder: actualEvents,
    countsPerOperation: counts,
    scope:
      "owner executing directly in this isolate; excludes worker message transport and Gateway",
    includesCollectedObjects: true,
    elapsedMs,
    msPerOperation: elapsedMs / iterations,
    sampledAllocatedBytes,
    sampledAllocatedBytesPerOperation: sampledAllocatedBytes / iterations,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  session.disconnect();
}
