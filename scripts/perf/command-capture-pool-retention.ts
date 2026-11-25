// Synthetic retained-storage proof, not a throughput benchmark. Run with --expose-gc.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../../src/process/exec-output.js";
import { runCommandBuffered } from "../../src/process/exec.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: { chunks: { type: "string" }, "snapshot-dir": { type: "string" } },
});
const chunks = parseStrictIntegerOption({
  raw: values.chunks,
  label: "--chunks",
  min: 1,
  fallback: 32,
});
assert(chunks <= 128, "Use at most 128 chunks for this bounded retention probe");
const gc = globalThis.gc;
assert(gc, "Run with --expose-gc");
const snapshotDir = values["snapshot-dir"] && path.resolve(values["snapshot-dir"]);
if (snapshotDir) {
  mkdirSync(snapshotDir, { recursive: true });
}
// oxlint-disable-next-line typescript/unbound-method -- Static factories ignore this; preserve their identity for restoration.
const from = Buffer.from;
// oxlint-disable-next-line typescript/unbound-method -- Static factories ignore this; preserve their identity for restoration.
const slow = Buffer.allocUnsafeSlow;
const churn = "x".repeat(Buffer.poolSize / 2 - 8);
const slabBytes = from("pool-marker").buffer.byteLength;
function advancePool() {
  for (let index = 0; index < 3; index++) {
    from(churn);
  }
}
function report(
  site: string,
  stores: Iterable<ArrayBufferLike>,
  payloadBytes: number,
  callbacks?: number,
) {
  const unique = [...new Set(stores)];
  console.log(
    JSON.stringify({
      site,
      node: process.version,
      poolSize: Buffer.poolSize,
      slabBytes,
      callbacks,
      payloadBytes,
      backingStores: unique.length,
      backingBytes: unique.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      pooledStores: unique.filter((buffer) => buffer.byteLength === slabBytes).length,
    }),
  );
}
function snapshot(name: string) {
  if (snapshotDir) {
    writeHeapSnapshot(path.join(snapshotDir, `${name}.heapsnapshot`));
  }
}

const line = "output-雪-0123456789\n";
const payloadBytes = Buffer.byteLength(line) * chunks;
const references: WeakRef<ArrayBufferLike>[] = [];
let copiedBytes = 0;
let ready: () => void = () => {};
const readyPromise = new Promise<void>((resolve) => {
  ready = resolve;
});
function observe(bytes: Buffer) {
  references.push(new WeakRef(bytes.buffer));
  copiedBytes += bytes.byteLength;
  if (copiedBytes === payloadBytes) {
    ready();
  }
}
// Attribute only allocations made by the actual buffered-command owner. Weak
// references cannot keep its output alive; sparse pool churn models other work.
Buffer.from = function (...args: Parameters<typeof Buffer.from>) {
  const owned = new Error().stack?.includes("/src/process/exec.ts:");
  if (owned) {
    advancePool();
  }
  const bytes = Reflect.apply(from, Buffer, args);
  if (owned && bytes.byteLength) {
    observe(bytes);
  }
  return bytes;
} as typeof Buffer.from;
Buffer.allocUnsafeSlow = function (size: number) {
  const owned = new Error().stack?.includes("/src/process/exec.ts:");
  if (owned) {
    advancePool();
  }
  const bytes = slow(size);
  if (owned && bytes.byteLength) {
    observe(bytes);
  }
  return bytes;
};
const controller = new AbortController();
const command = runCommandBuffered(
  [
    process.execPath,
    "-e",
    `let i=0;const timer=setInterval(()=>{process.stdout.write(${JSON.stringify(line)});if(++i===${chunks})clearInterval(timer)},5);setInterval(()=>{},1000)`,
  ],
  { baseEnv: {}, timeoutMs: 10_000, signal: controller.signal },
);
try {
  await Promise.race([
    readyPromise,
    command.then(() => {
      throw new Error("Command ended before capture");
    }),
  ]);
  Buffer.from = from;
  Buffer.allocUnsafeSlow = slow;
  advancePool();
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    gc();
  }
  report(
    "buffered-command",
    references.flatMap((ref) => {
      const value = ref.deref();
      return value ? [value] : [];
    }),
    payloadBytes,
    references.length,
  );
  snapshot("buffered-command");
} finally {
  Buffer.from = from;
  Buffer.allocUnsafeSlow = slow;
  controller.abort();
  const result = await command;
  assert.equal(result.stdout.toString(), line.repeat(chunks));
  assert.equal(result.stderr.byteLength, 0);
}

const retained = [];
for (const mode of ["string", "head", "tail", "partial-tail"] as const) {
  const captures = Array.from({ length: chunks }, () => {
    advancePool();
    const capture = createCapturedOutputBuffers();
    if (mode === "string") {
      appendCapturedOutput(capture, line, 4096, "head");
    } else if (mode === "partial-tail") {
      appendCapturedOutput(capture, Buffer.alloc(24, 88), 32, "tail");
      appendCapturedOutput(capture, Buffer.alloc(24, 88), 32, "tail");
    } else {
      appendCapturedOutput(capture, Buffer.alloc(128, 88), 16, mode);
    }
    assert.equal(
      finalizeCapturedOutput(capture, mode === "head" ? "head" : "tail").toString(),
      mode === "string" ? line : "X".repeat(mode === "partial-tail" ? 32 : 16),
    );
    return capture;
  });
  report(
    mode,
    captures.flatMap((capture) => capture.chunks.map((chunk) => chunk.buffer)),
    captures.reduce((sum, capture) => sum + capture.bytes, 0),
  );
  retained.push(captures);
}
snapshot("captures");
assert.equal(retained.length, 4);
