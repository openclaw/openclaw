// Run: node --import ./scripts/tsx.mjs scripts/perf/worktree-index-metadata-measure.ts
// --base-file <saved-checkout-apfs.ts> selects the previous owner; --allocation
// runs a separate sampled-heap pass. Default: 2,000 copies after 20 warmups.
// Exercises the real APFS index parser/translator on a 3,000-entry Git v2 index.
// Synthetic filesystem/metadata adapters exclude native syscalls, worker queues,
// clone timestamp waits, and Gateway latency. Metadata replies are cloned to
// represent the fresh objects delivered by a worker. Counts prove boundary work;
// CPU/allocation describe this owner, not the complete preparation pipeline.
// Every result must equal an independently constructed destination index.
// Acceptance: identical index bytes and file coverage, fewer metadata requests,
// lower CPU or allocation without a material regression in the other metric.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CloneFileMetadata } from "../../src/infra/fs-safe-copy-worker-contract.js";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    allocation: { type: "boolean" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const fileCount = 3000;
const timestamp = 1_600_000_000;
const metadata = new Map<string, CloneFileMetadata>();
function index(cloned: boolean): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(fileCount, 8);
  const entries = Array.from({ length: fileCount }, (_, i) => {
    const name = `file-${String(i).padStart(4, "0")}`;
    const ino = 1000 + i + (cloned ? fileCount : 0);
    const ctimeSec = timestamp + Number(cloned);
    const record = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    [ctimeSec, 0, timestamp, 0, 1, ino, 0o100644, 501, 20, 256].forEach((value, offset) =>
      record.writeUInt32BE(value, offset * 4),
    );
    record.fill(0x61, 40, 60);
    record.writeUInt16BE(name.length, 60);
    record.write(name, 62);
    metadata.set(`/fixture/${cloned ? "destination" : "source"}/${name}`, {
      exactIdentity: { dev: 1n, ino: BigInt(ino) },
      dev: 1,
      type: 1,
      mtimeSec: timestamp,
      mtimeNs: 0,
      ctimeSec,
      ctimeNs: 0,
      uid: 501,
      gid: 20,
      mode: 0o100644,
      ino: BigInt(ino),
      size: 256n,
      cloneId: BigInt(i + 1),
    });
    return record;
  });
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
const source = index(false);
const expected = index(true);
const counts = () => ({ metadataRequests: 0, metadataPaths: 0, writes: 0 });
const state = { source, metadata, counts: counts(), written: undefined as Buffer | undefined };
const key = Symbol.for("openclaw.perf.worktree-index-metadata");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const prelude = 'const s=globalThis[Symbol.for("openclaw.perf.worktree-index-metadata")];\n';
const ownerUrl = new URL("../../src/agents/worktrees/checkout-apfs.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
const fsUrl = new URL("./synthetic-index-fs.mjs", ownerUrl).href;
const modules = new Map<string, string>([
  [
    fsUrl,
    prelude +
      `export default {
        open:async()=>({
          stat:async()=>({mtimeNs:1700000000000000000n,ctimeNs:1700000000000000000n,size:BigInt(s.source.length)}),
          readFile:async()=>Buffer.from(s.source),close:async()=>{},
        }),
        writeFile:async(_path,data)=>{s.counts.writes++;s.written=data;},
      };`,
  ],
  [
    new URL("./filesystem-native.ts", ownerUrl).href,
    prelude +
      `export const nativeWorktreeFilesystem={readMetadata:async paths=>{
        s.counts.metadataRequests++;s.counts.metadataPaths+=paths.length;
        return structuredClone(paths.map(path=>{
          const value=s.metadata.get(path);if(!value)throw new Error("Unknown fixture path: "+path);return value;
        }));
      }};`,
  ],
  [
    new URL("./preparation-timing.ts", ownerUrl).href,
    "export const timeWorktreePreparationPhase=async(_phase,run)=>await run();",
  ],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "node:fs/promises" && context.parentURL === ownerUrl
      ? { url: fsUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const replacement = modules.get(url);
    return replacement === undefined
      ? nextLoad(url === ownerUrl && baseUrl ? baseUrl : url, context)
      : { format: "module", source: replacement, shortCircuit: true };
  },
});
const inspector = new Session();
try {
  const { copyApfsCloneIndex } = await import("../../src/agents/worktrees/checkout-apfs.js");
  const operation = async () => {
    assert.equal(
      await copyApfsCloneIndex(
        "/fixture/source",
        "/fixture/destination",
        "/fixture/source-index",
        "/fixture/destination-index",
        { cloneCompletedAtMs: timestamp * 1000, commitGuard: () => {} },
      ),
      true,
    );
    assert(state.written?.equals(expected), "destination index differs from fixture contract");
    state.written = undefined;
  };
  for (let i = 0; i < 20; i++) {
    await operation();
  }
  state.counts = counts();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = loadavg();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await operation();
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  let sampledHeapBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    sampledHeapBytes = bytes(profile.head);
  }
  assert.equal(state.counts.writes, iterations);
  assert.equal(state.counts.metadataPaths, iterations * fileCount * 2);
  console.log(
    JSON.stringify({
      arm: baseUrl ? "base" : "candidate",
      ownerSha256: createHash("sha256")
        .update(readFileSync(new URL(baseUrl ?? ownerUrl)))
        .digest("hex"),
      mode: values.allocation ? "allocation" : "timing",
      scope: "APFS index translation with synthetic I/O and cloned metadata replies",
      iterations,
      fileCount,
      counts: state.counts,
      wallMs,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      sampledHeapBytesPerOperation:
        sampledHeapBytes === undefined ? undefined : sampledHeapBytes / iterations,
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
}
