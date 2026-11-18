// Run: node --import ./scripts/tsx.mjs scripts/perf/worktree-prompt-overlap-measure.ts
// --base-file <saved-checkout.ts> selects the previous owner; --allocation runs
// a separate sampled-heap pass. Default: 2,000 operations after 20 warmups.
// Calls the actual addManagedWorktree orchestration with synthetic Git, template,
// filesystem and index-copy adapters. A 3,000-entry index matches the dev fixture.
// The same 8 KiB prompt consumer runs once per operation, at the early callback
// or after complete checkout. Reports JS orchestration CPU/allocation and counts;
// excludes native Git, clone/index I/O, waits, worker queues and Gateway latency.
// Adapters resolve immediately: elapsed time is NOT an estimate of the overlap
// benefit. Use turn-start-phases.ts for latency. Acceptance: same Git/clone/index
// work and consumer count; earlier readiness with no material orchestration cost.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    allocation: { type: "boolean" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const commit = "a".repeat(40);
const counts = () => ({ git: 0, clone: 0, index: 0, consumer: 0, early: 0, admission: 0 });
const state = { commit, indexed: false, consumed: false, counts: counts() };
const key = Symbol.for("openclaw.perf.worktree-prompt-overlap");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const prelude = 'const s=globalThis[Symbol.for("openclaw.perf.worktree-prompt-overlap")];\n';
const ownerUrl = new URL("../../src/agents/worktrees/checkout.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
const modules = new Map<string, string>();
const adapter = (relative: string, source: string) =>
  modules.set(new URL(relative, ownerUrl).href, prelude + source);
const fsUrl = new URL("./synthetic-checkout-fs.mjs", ownerUrl).href;
modules.set(
  fsUrl,
  `
const noop=async()=>{};
export default {
  readdir:async()=>[".git"], readFile:async()=>Buffer.from("gitdir: /fixture/meta"),
  unlink:noop,rmdir:noop,writeFile:noop,
  open:async()=>({close:noop,stat:async()=>({size:240032}),read:async(buffer)=>{
    buffer.write("DIRC");buffer.writeUInt32BE(2,4);buffer.writeUInt32BE(3000,8);
    return {bytesRead:12};
  }}),
};`,
);
adapter(
  "../../infra/fs-safe.ts",
  'export const root=()=>{throw new Error("Unexpected index fallback")};',
);
adapter(
  "../../infra/git-exec.ts",
  `
export const gitNullConfigPath=()=>"/dev/null";
export const normalizeGitPathForFilesystem=value=>value;
export const requireGitCommandOutput=(_label,result)=>{if(result.code!==0)throw new Error("Git failed");return result.stdout};`,
);
adapter(
  "../../logging/subsystem.ts",
  "export const createSubsystemLogger=()=>({warn(message){throw new Error(message)}});",
);
adapter(
  "./git.ts",
  `
export const WORKTREE_CHECKOUT_TIMEOUT_MS=300000;
export const worktreePathExists=async()=>false;
export const resolveGitMetadataPath=async(_root,name)=>name==="index"?"/fixture/template-index":"/fixture/meta";
export const commandError=label=>new Error(label);
export async function runGit(_root,args,options={}){
  options.beforeRun?.();s.counts.git++;
  const run=()=>{
    let stdout="",code=0;
    if(args.includes("--symbolic-full-name"))stdout=s.commit+"\\nrefs/heads/fixture";
    else if(args.includes("--git-path"))stdout="/fixture/destination-index";
    else if(args[0]==="config")stdout="core.bare\\nfalse\\0";
    else if(args[0]==="var")code=1;
    else if(!["worktree","update-index"].includes(args[0]))throw new Error("Unexpected Git: "+args.join(" "));
    return {termination:"exit",code,stdout,stderr:""};
  };
  return options.startRun?await options.startRun(run):run();
}
export const requireGit=async(...args)=>(await runGit(...args)).stdout.trim();
export const runGitBytes=runGit;
export const runGitBuffered=runGit;
export const gitEnvironment=()=>({});`,
);
adapter(
  "./filesystem-backend.ts",
  `
export const detectWorktreeFilesystemBackend=async()=>({id:"apfs",estimateCloneBytes:()=>16777216,
 cloneTemplate:async(_source,_destination,options)=>{options.commitGuard();s.counts.clone++}});`,
);
adapter(
  "./template-cache.ts",
  `
export const prepareWorktreeTemplate=async options=>({path:"/fixture/template",sourceCommit:s.commit,
 contentKey:options.contentKey,release:async()=>{}});`,
);
adapter(
  "./checkout-apfs.ts",
  "export const copyApfsCloneIndex=async()=>{s.counts.index++;s.indexed=true;return true};",
);
adapter(
  "./preparation-timing.ts",
  `
export const setWorktreePreparationTemplate=()=>{};
export const timeWorktreePreparationPhase=async(_phase,run)=>await run();`,
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "node:fs/promises" && context.parentURL === ownerUrl
      ? { url: fsUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = modules.get(url);
    return source === undefined
      ? nextLoad(url === ownerUrl && baseUrl ? baseUrl : url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const inspector = new Session();
try {
  const { addManagedWorktree } = await import("../../src/agents/worktrees/checkout.js");
  const prompt = Buffer.alloc(8192, 0x61);
  const expected = createHash("sha256").update(prompt).digest("hex");
  const consume = async (preparedCommit: string) => {
    assert.equal(preparedCommit, commit);
    assert.equal(state.consumed, false);
    state.consumed = true;
    state.counts.consumer++;
    state.counts.early += Number(!state.indexed);
    assert.equal(createHash("sha256").update(prompt).digest("hex"), expected);
  };
  const operation = async () => {
    state.indexed = state.consumed = false;
    const result = await addManagedWorktree({
      env: {},
      now: Date.now,
      enabled: true,
      repoRoot: "/fixture/repo",
      commonDir: "/fixture/common",
      worktreeRoot: "/fixture",
      destination: "/fixture/destination",
      base: commit,
      branch: "fixture",
      commitGuard: () => {},
      requireSpace: async () => {
        state.counts.admission++;
      },
      prepareCommit: async () => 3000 * 4096,
      onPromptReady: consume,
    });
    assert.equal(result.code, 0);
    assert.equal(result.templateCloned, true);
    assert.equal(state.indexed, true);
    if (!state.consumed) {
      await consume(commit);
    }
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
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i++) {
    await operation();
  }
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  let sampledHeapBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    sampledHeapBytes = bytes(profile.head);
  }
  assert.equal(state.counts.consumer, iterations);
  assert.equal(state.counts.clone, iterations);
  assert.equal(state.counts.index, iterations);
  console.log(
    JSON.stringify({
      arm: baseUrl ? "base" : "candidate",
      ownerSha256: createHash("sha256")
        .update(readFileSync(new URL(baseUrl ?? ownerUrl)))
        .digest("hex"),
      mode: values.allocation ? "allocation" : "timing",
      iterations,
      scope:
        "actual checkout orchestration with immediate synthetic I/O; excludes native work and wait time",
      fileCount: 3000,
      promptBytes: prompt.length,
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
