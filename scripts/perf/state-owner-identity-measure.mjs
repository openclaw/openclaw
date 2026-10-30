/**
 * Measure captured owner and exact session-candidate assertions with real filesystem custody.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-owner-identity-measure.mjs
 *   [--source-dir <baseline-source-snapshots>] [--iterations 4000]
 *
 * Snapshot the two files below at the baseline revision, then alternate baseline/candidate
 * invocations. All other imports retain the current checkout's canonical module identity.
 * One shared root, 64 captured owners and 40 agent paths model the assertion inputs; session
 * row count does not affect these operations. CPU and allocation use separate passes.
 * This is an owner microbenchmark, not a whole-Gateway load test. No operator state is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    iterations: { type: "string", default: "4000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const sources = new Map(
  ["src/infra/gateway-state-owner.ts", "src/config/sessions/session-store-read-candidates.ts"].map(
    (file) => {
      const source = fs.readFileSync(path.join(values["source-dir"] ?? sourceRoot, file), "utf8");
      return [
        path.join(sourceRoot, file),
        {
          file,
          hash: createHash("sha256").update(source).digest("hex"),
          code: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
        },
      ];
    },
  ),
);
const hooks = registerHooks({
  load(url, context, next) {
    const source = url.startsWith("file:") && sources.get(fileURLToPath(url));
    return source
      ? { format: "module", source: source.code, shortCircuit: true }
      : next(url, context);
  },
});
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/state-owner-identity-"));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  HOME: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const { acquireGatewayStateOwner, captureGatewayStateOwner } =
  await import("../../src/infra/gateway-state-owner.ts");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.ts");
const { captureSessionStoreReadCandidate, assertSessionStoreReadCandidate } =
  await import("../../src/config/sessions/session-store-read-candidates.ts");
const databasePath = path.join(root, "state", "openclaw.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(databasePath, "synthetic identity only");
const owner = acquireGatewayStateOwner({
  databasePath,
  payload: {
    pid: process.pid,
    role: "gateway",
    createdAt: new Date().toISOString(),
    configPath: path.join(root, "openclaw.json"),
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
const inspector = new Session();
try {
  const handles = Array.from({ length: 64 }, () => captureGatewayStateOwner(databasePath));
  const candidates = Array.from({ length: 40 }, (_, index) => {
    const pathname = path.join(root, "agents", `agent-${index}`, "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, "synthetic identity only");
    return captureSessionStoreReadCandidate(pathname);
  });
  const results = [];
  for (const [name, run] of [
    ["captured-owner", (i) => handles[i % handles.length].assertCurrent()],
    [
      "exact-session-candidate",
      (i) => {
        const candidate = candidates[i % candidates.length];
        assertSessionStoreReadCandidate(candidate.path, [candidate]);
      },
    ],
  ]) {
    const repeat = async (count) => {
      for (let i = 0; i < count; i++) {
        run(i);
        if (i % 100 === 99) {
          await immediate();
        }
      }
    };
    await repeat(500);
    let realpaths = 0;
    const native = fs.realpathSync.native;
    fs.realpathSync.native = (...args) => {
      realpaths++;
      return native(...args);
    };
    try {
      for (let i = 0; i < 100; i++) {
        run(i);
      }
    } finally {
      fs.realpathSync.native = native;
    }
    global.gc();
    await immediate();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    await repeat(iterations);
    const durationMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await repeat(iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    let allocated = 0;
    const pending = [profile.head];
    while (pending.length) {
      const node = pending.pop();
      allocated += node.selfSize;
      pending.push(...node.children);
    }
    results.push({
      name,
      iterations,
      realpathsPerOperation: realpaths / 100,
      mainCpuUsPerOperation: (used.user + used.system) / iterations,
      durationMs,
      sampledBytesPerOperation: allocated / iterations,
    });
  }
  console.log(
    JSON.stringify({
      sources: [...sources.values()].map(({ file, hash }) => ({ file, hash })),
      load: loadavg(),
      results,
    }),
  );
} finally {
  inspector.disconnect();
  owner.release();
  hooks.deregister();
  fs.rmSync(root, { recursive: true, force: true });
}
