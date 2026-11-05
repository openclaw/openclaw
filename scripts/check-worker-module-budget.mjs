// Regression for the shipped small-worker graph (requires an already-built dist).
// node scripts/check-worker-module-budget.mjs --package-root <build-root>
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createBuildSmokeEnv } from "./lib/build-smoke-env.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parsePackageRootArg } from "./lib/package-root-args.mts";

// Keep headroom for small dependency updates, but reject shared Gateway chunks.
const budgets = {
  "agents/identity-file.worker.js": 220,
  "extensions/codex/catalog-page.worker.js": 100,
};

/** @param {string} packageRoot */
export async function checkWorkerModuleBudget(packageRoot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-budget-"));
  try {
    for (const [entry, budget] of Object.entries(budgets)) {
      const filename = path.join(packageRoot, "dist", entry);
      // Published root packages omit separately installed plugins.
      if (entry.startsWith("extensions/") && !fs.existsSync(filename)) {
        continue;
      }
      fs.accessSync(filename);
      const worker = new Worker(
        `const {parentPort, workerData} = require("node:worker_threads");
         const {Session} = require("node:inspector/promises");
         (async () => {
           const session = new Session();
           session.connect();
           const modules = new Set();
           session.on("Debugger.scriptParsed", ({params}) => {
             if (params.url.startsWith("file:")) modules.add(params.url);
           });
           await import(workerData);
           await session.post("Debugger.enable");
           session.disconnect();
           parentPort.postMessage(modules.size);
         })().catch(error => { throw error; });`,
        {
          eval: true,
          execArgv: [],
          env: { ...createBuildSmokeEnv(home), NODE_OPTIONS: "" },
          workerData: pathToFileURL(filename).href,
        },
      );
      try {
        const [count] = await once(worker, "message", { signal: AbortSignal.timeout(30_000) });
        assert(Number.isSafeInteger(count) && count > 0, `${entry}: empty module census`);
        console.log(`${entry}: ${count} evaluated modules (budget ${budget})`);
        assert(count <= budget, `${entry}: ${count} evaluated modules exceeds budget ${budget}`);
      } finally {
        await worker.terminate();
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { packageRoot } = parsePackageRootArg(process.argv.slice(2), "OPENCLAW_WORKER_BUDGET_ROOT");
  await checkWorkerModuleBudget(packageRoot);
}
