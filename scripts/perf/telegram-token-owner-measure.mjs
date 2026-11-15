// Run from the checkout root with synthetic credentials only:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/telegram-token-owner-measure.mjs
// Repeat with --mode allocation; timing and allocation passes are separate.
// Save the base account-inspect.ts beside the original (to preserve relative imports),
// then pass --owner-file extensions/telegram/src/.account-inspect-benchmark-base.ts.
// Alternate base/candidate launch order. Remove the temporary base file afterward.
// Measures account inspection used by startup describe/isConfigured and status; not
// Gateway throughput. Each case cycles through 1, 4, or 16 distinct-token accounts.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "4000" },
    "owner-file": { type: "string" },
    credentials: { type: "string", default: "config" },
  },
});
assert(["timing", "allocation"].includes(values.mode));
assert(["config", "file"].includes(values.credentials));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = values["owner-file"]
  ? pathToFileURL(resolve(values["owner-file"]))
  : new URL("../../extensions/telegram/src/account-inspect.ts", import.meta.url);
const { inspectTelegramAccount } = await import(owner.href);
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/telegram-token-owner-"));
try {
  const results = [];
  for (const accountCount of [1, 4, 16]) {
    const ids = Array.from(
      { length: accountCount },
      (_, i) => `account-${String(i).padStart(2, "0")}`,
    );
    const accounts = Object.fromEntries(
      ids.map((id, i) => {
        const token = `${i + 100}:synthetic-benchmark-token`;
        if (values.credentials === "config") {
          return [id, { botToken: token }];
        }
        const tokenFile = join(root, id);
        writeFileSync(tokenFile, token);
        return [id, { tokenFile }];
      }),
    );
    const cfg = { channels: { telegram: { defaultAccount: ids[0], accounts } } };
    for (const accountId of ids) {
      assert.equal(inspectTelegramAccount({ cfg, accountId }).configured, true);
    }
    let configured = 0;
    function run(count) {
      for (let i = 0; i < count; i++) {
        if (inspectTelegramAccount({ cfg, accountId: ids[i % ids.length] }).configured) {
          configured++;
        }
      }
    }
    run(1000);
    configured = 0;
    globalThis.gc?.();
    const inspector = new Session();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    run(iterations);
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    let allocation;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      allocation = {
        sampledBytesPerInspection:
          profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
        samples: profile.samples.length,
      };
    }
    assert.equal(configured, iterations);
    results.push({
      accountCount,
      iterations,
      hostLoad,
      wallMs,
      cpuUsPerInspection: (cpu.user + cpu.system) / iterations,
      allocation,
    });
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      credentials: values.credentials,
      node: process.version,
      results,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
