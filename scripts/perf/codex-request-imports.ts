/**
 * Warm Codex request-owner benchmark with synthetic policy/client boundaries.
 * The real request scope, timeout and cancellation code runs; no Codex process,
 * network, credentials or live state. Reuses a 100-row page over 10,000 thread IDs.
 *
 * node --expose-gc scripts/perf/codex-request-imports.ts
 * Builds only the request owner; the measured child uses native ESM without tsx.
 * Use --owner <saved request.ts> for a baseline, --mode allocation in a separate
 * pass, or --mode counts --assert-single-load for the import-work regression.
 * Alternate base/candidate launch order. Warmup and fixtures are excluded.
 * Acceptance: zero repeated module resolutions, unchanged request/policy counts,
 * lower warm allocation or CPU per request; no whole-Gateway claim.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "native-owner": { type: "string" },
    fixture: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5000" },
    "assert-single-load": { type: "boolean", default: false },
  },
});
assert(["timing", "allocation", "counts"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../extensions/codex/src/app-server/request.ts", import.meta.url);
const source = readFileSync(values.owner ?? ownerUrl, "utf8");
const fixtureSource = `
export const counts = { prepared: 0, policyChecks: 0, policyReleased: 0, acquired: 0, released: 0, writes: 0 };
export const page = { data: Array.from({ length: 100 }, (_, i) => ({ id: 'thread-' + i, preview: 'Synthetic catalog thread ' + i })), nextCursor: 'page-2' };
const client = {
  async request(method, params, options) {
    options.assertCurrent?.();
    await options.withCurrent(() => { counts.writes++; });
    return page;
  }
};
export async function prepareCodexAppServerDirectSandboxBypassBlock() {
  counts.prepared++;
  return { block: undefined, async assertCurrent() { counts.policyChecks++; }, release() { counts.policyReleased++; } };
}
export async function getLeasedSharedCodexAppServerClient() { counts.acquired++; return client; }
export const createIsolatedCodexAppServerClient = getLeasedSharedCodexAppServerClient;
export function releaseLeasedSharedCodexAppServerClient() { counts.released++; }
export async function readSharedCodexAppServerUsage() { return undefined; }
`;
if (!values["native-owner"]) {
  const { build, transform } = await import("esbuild");
  const scratchRoot = resolve(".local");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "codex-request-imports-"));
  try {
    const fixturePath = join(scratch, "fixture.mjs");
    const nativeOwner = join(scratch, "request.mjs");
    writeFileSync(fixturePath, fixtureSource);
    symlinkSync(
      resolve("extensions/codex/node_modules"),
      join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await build({
      stdin: {
        contents: source,
        loader: "ts",
        resolveDir: dirname(fileURLToPath(ownerUrl)),
        sourcefile: fileURLToPath(ownerUrl),
      },
      outfile: nativeOwner,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "synthetic-codex-boundaries",
          setup(builder) {
            // Keep source-relative resources (for example schema SQL) at their
            // original locations when bundling this owner outside the dist build.
            builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
              const contents = readFileSync(args.path, "utf8");
              if (!contents.includes("import.meta")) {
                return undefined;
              }
              const transformed = await transform(contents, {
                loader: args.path.endsWith("ts") ? "ts" : "js",
                define: {
                  "import.meta.url": JSON.stringify(pathToFileURL(args.path).href),
                  "import.meta.dirname": JSON.stringify(dirname(args.path)),
                  "import.meta.filename": JSON.stringify(args.path),
                },
              });
              return { contents: transformed.code, loader: "js" };
            });
            builder.onResolve(
              { filter: /^\.\/(sandbox-guard|shared-client|shared-client-usage)\.js$/ },
              (args) => {
                if (args.resolveDir === dirname(fileURLToPath(ownerUrl))) {
                  return { path: pathToFileURL(fixturePath).href, external: true };
                }
                return undefined;
              },
            );
            builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, (args) => ({
              path: fileURLToPath(
                new URL(
                  `../../src/plugin-sdk/${args.path.slice("openclaw/plugin-sdk/".length)}.ts`,
                  import.meta.url,
                ),
              ),
            }));
          },
        },
      ],
    });
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        "--native-owner",
        nativeOwner,
        "--fixture",
        fixturePath,
      ],
      { stdio: "inherit" },
    );
    assert.equal(child.signal, null, `Benchmark terminated: ${child.signal}`);
    assert.ifError(child.error);
    process.exitCode = child.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  const fixtureUrl = pathToFileURL(values.fixture!).href;
  const nativeOwnerUrl = pathToFileURL(values["native-owner"]).href;
  const owner: typeof import("../../extensions/codex/src/app-server/request.js") = await import(
    nativeOwnerUrl
  );
  const fixture: {
    counts: Record<string, number>;
    page: { data: { id: string; preview: string }[]; nextCursor: string };
  } = await import(fixtureUrl);
  const options = Array.from({ length: 10_000 }, (_, index) => ({
    method: "thread/list" as const,
    requestParams: { limit: 100, cursor: `cursor-${index}`, archived: index % 2 === 0 },
    sessionKey: `agent:synthetic:subagent:${index}`,
    config: {},
  }));
  let requests = 0;
  async function run(count: number) {
    for (let index = 0; index < count; index++) {
      const result = await owner.requestCodexAppServerJson(options[index % options.length]!);
      assert.equal(result, fixture.page);
    }
    requests += count;
  }
  await run(values.mode === "counts" ? 1 : 200);
  for (const key of Object.keys(fixture.counts)) {
    fixture.counts[key] = 0;
  }
  requests = 0;
  let resolutions = 0;
  const countingHooks =
    values.mode === "counts"
      ? registerHooks({
          resolve(specifier, context, nextResolve) {
            if (context.parentURL === nativeOwnerUrl && specifier === fixtureUrl) {
              resolutions++;
            }
            return nextResolve(specifier, context);
          },
        })
      : undefined;
  const gc = { count: 0, ms: 0, maxMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.ms += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
    }
  });
  // Forced GC is preparation; only natural collections during the measured run count.
  globalThis.gc?.();
  await nextTurn();
  observer.observe({ entryTypes: ["gc"] });
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let allocatedBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  countingHooks?.deregister();
  assert.equal(fixture.counts.prepared, requests * 2);
  assert.equal(fixture.counts.policyChecks, requests);
  assert.equal(fixture.counts.policyReleased, requests * 2);
  assert.equal(fixture.counts.acquired, requests);
  assert.equal(fixture.counts.released, requests);
  assert.equal(fixture.counts.writes, requests);
  const memory = process.memoryUsage();
  console.log(
    JSON.stringify({
      mode: values.mode,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      cpuMs: (cpu.user + cpu.system) / 1000,
      elapsedMs,
      allocatedBytes,
      resolutions,
      counts: fixture.counts,
      gc,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      hostLoad: loadavg(),
    }),
  );
  if (values["assert-single-load"]) {
    assert.equal(values.mode, "counts", "--assert-single-load requires --mode counts");
    assert.equal(resolutions, 0, "Warm Codex requests must reuse their loaded modules");
  }
}
