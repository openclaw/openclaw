// Regression for the shipped small-worker graph (requires an already-built dist).
// node scripts/check-worker-module-budget.mjs --package-root <build-root>
// --source-compaction inventories the prepared/render source closures in fresh isolates.
// Source imports include loader overhead and are not a replacement for native cold-task timing.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createBuildSmokeEnv } from "./lib/build-smoke-env.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parsePackageRootArg } from "./lib/package-root-args.mts";

// Keep headroom for small dependency updates, but reject shared Gateway chunks.
const budgets = {
  "agents/identity-file.worker.js": 220,
  "extensions/codex/catalog-page.worker.js": 100,
};

const compactionSourceBudgets = {
  "config/sessions/session-compaction-prepared.worker.ts": 2750,
  "config/sessions/session-compaction-render.worker.ts": 2725,
};

// These host/backend owners are not part of a borrowed read-only compaction task.
const forbiddenCompactionImports = new Set([
  "src/config/sessions/session-accessor.sqlite-active-projection.ts",
  "src/config/sessions/session-transcript-reconcile.ts",
  "src/config/sessions/session-actor-replica.ts",
  "src/config/sessions/session-transcript-worker-resources.ts",
  "src/state/openclaw-agent-execution.ts",
  "packages/ai/src/host.ts",
  "packages/ai/src/internal/default-runtime.ts",
  "packages/ai/src/providers/register-builtins.ts",
  "src/agents/embedded-agent-helpers/bootstrap.ts",
  "src/media/image-ops.ts",
  "src/media/image-processor.ts",
]);

/** @param {string} packageRoot
 * @param {{sourceCompaction?: boolean}} options
 */
export async function checkWorkerModuleBudget(packageRoot, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-budget-"));
  try {
    const source = options.sourceCompaction === true;
    for (const [entry, budget] of Object.entries(source ? compactionSourceBudgets : budgets)) {
      const filename = path.join(packageRoot, source ? "src" : "dist", entry);
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
           if (workerData.loader) {
             const { register } = await import(workerData.loader);
             register({tsconfig: workerData.tsconfig});
           }
           const started = performance.now();
           await import(workerData.entry);
           const importWallMs = performance.now() - started;
           await session.post("Debugger.enable");
           session.disconnect();
           parentPort.postMessage({count: modules.size, importWallMs, modules: [...modules].sort()});
         })().catch(error => { throw error; });`,
        {
          eval: true,
          execArgv: [],
          env: {
            ...createBuildSmokeEnv(home),
            NODE_OPTIONS: "",
            ...(source ? { TSX_DISABLE_CACHE: "1" } : {}),
          },
          workerData: {
            entry: pathToFileURL(filename).href,
            ...(source
              ? {
                  loader: pathToFileURL(
                    createRequire(path.join(packageRoot, "package.json")).resolve("tsx/esm/api"),
                  ).href,
                  tsconfig: path.join(packageRoot, "tsconfig.json"),
                }
              : {}),
          },
        },
      );
      try {
        const [census] = await once(worker, "message", { signal: AbortSignal.timeout(30_000) });
        const { count, importWallMs } = census;
        const modules = census.modules.map((url) =>
          path.relative(packageRoot, fileURLToPath(url)).split(path.sep).join("/"),
        );
        if (source) {
          console.log(
            JSON.stringify({
              entry,
              count,
              importWallMs,
              modules,
            }),
          );
        }
        assert(Number.isSafeInteger(count) && count > 0, `${entry}: empty module census`);
        console.log(`${entry}: ${count} evaluated modules (budget ${budget})`);
        assert(count <= budget, `${entry}: ${count} evaluated modules exceeds budget ${budget}`);
        if (source) {
          const leaked = modules.filter((module) => forbiddenCompactionImports.has(module));
          assert.deepEqual(leaked, [], `${entry}: borrowed compaction imports host/backend owners`);
        }
      } finally {
        await worker.terminate();
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  const sourceCompaction = args.includes("--source-compaction");
  const { packageRoot } = parsePackageRootArg(
    args.filter((arg) => arg !== "--source-compaction"),
    "OPENCLAW_WORKER_BUDGET_ROOT",
  );
  await checkWorkerModuleBudget(packageRoot, { sourceCompaction });
}
