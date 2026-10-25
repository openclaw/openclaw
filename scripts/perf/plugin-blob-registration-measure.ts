/** Synthetic HTTP -> plugin runtime -> blob worker registration workload. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.out && values.observer, "--out and --observer are required");
const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const root = path.join(out, "gateway");
const pluginDir = path.join(root, "plugin");
mkdirSync(pluginDir, { recursive: true });
writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: "bench-blob",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
writeFileSync(
  path.join(pluginDir, "index.cjs"),
  `module.exports = { id: "bench-blob", register(api) {
    const stores = Object.fromEntries(["reject-new", "evict-oldest"].map(overflowPolicy => [
      overflowPolicy, api.runtime.state.openBlobStore({ namespace: overflowPolicy,
        maxEntries: 20, maxBytesPerEntry: 16, maxBytesPerNamespace: 320, overflowPolicy })
    ]));
    api.registerHttpRoute({ path: "/bench-blob", auth: "gateway", handler: async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const receipt = await stores[url.searchParams.get("policy")].registerIfAbsentWithReceipt(
        url.searchParams.get("key"), new Uint8Array(16).fill(7), { synthetic: true });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ inserted: receipt !== undefined }));
      return true;
    }});
  }};\n`,
);
const port = await getFreePort();
const token = "synthetic-blob-benchmark";
const configPath = writeGatewayBenchConfig(
  root,
  {
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      port,
      auth: { mode: "token", token },
    },
    plugins: {
      enabled: true,
      allow: ["bench-blob"],
      load: { paths: [pluginDir] },
      entries: { "bench-blob": { enabled: true } },
    },
  },
  { agentList: [{ id: "main", workspace: path.join(root, "workspace") }] },
);
writeFileSync(path.join(out, "phase"), "boot");
const log = createWriteStream(path.join(out, "gateway.log"));
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(
    path.resolve(values.entry),
    port,
    gatewayBenchCpuProfileArgs(values["cpu-profile"] ? path.join(out, "profiles") : undefined),
    "token",
  ),
  {
    env: {
      ...createGatewayBenchEnv(root, configPath, {}),
      SQLMEASURE_OUT: out,
      NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  },
);
child.stdout?.pipe(log);
child.stderr?.pipe(log);
const results: Array<{ phase: string; inserted: boolean }> = [];
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => child.exitCode !== null || child.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway unavailable");
  for (const temperature of ["cold", "warm"]) {
    for (const policy of ["reject-new", "evict-oldest"]) {
      for (let sample = 0; sample < 5; sample++) {
        const key = `${temperature}-${sample}`;
        for (const outcome of ["new", "duplicate"]) {
          const phase = `${temperature}-${policy}-${outcome}-${sample}`;
          writeFileSync(path.join(out, "phase"), phase);
          const response = await fetch(
            `http://127.0.0.1:${port}/bench-blob?${new URLSearchParams({ policy, key })}`,
            { method: "POST", headers: { authorization: `Bearer ${token}` } },
          );
          assert.equal(response.status, 200);
          const result: unknown = await response.json();
          assert.deepEqual(result, { inserted: outcome === "new" });
          results.push({ phase, inserted: outcome === "new" });
        }
      }
    }
  }
} finally {
  writeFileSync(path.join(out, "phase"), "shutdown");
  await stopChild(child, { teardownGraceMs: 20_000 });
  log.end();
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
}
