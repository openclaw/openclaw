import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeWorkerActivity } from "../../test/helpers/worker-activity.js";
import { resolveBundledPublicSurfaceLocation } from "../plugin-sdk/facade-loader.js";
import * as executorPlugins from "../plugins/code-mode-executor.js";
import type { CodeModeExecutor } from "./code-mode-executor-types.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { activeRuns, disposeAllCodeModeRuns } from "./code-mode-state.js";
import { createCatalogCodeModeHarness } from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";

const executorArtifact = resolveBundledPublicSurfaceLocation({
  dirName: "code-mode-quickjs",
  artifactBasename: "code-mode-executor-api.js",
  preferSource: true,
  env: { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions") },
});
assert(executorArtifact, "QuickJS executor public artifact is unavailable");
const { codeModeExecutor } = await vi.importActual<{ codeModeExecutor: CodeModeExecutor }>(
  executorArtifact.modulePath,
);
const productionWorkerUrl = resolveRuntimeWorkerUrl({
  currentModuleUrl: pathToFileURL(executorArtifact.modulePath).href,
  sourceWorkerName: "src/code-mode.worker",
  distWorkerPath: "extensions/code-mode-quickjs/src/code-mode.worker.js",
});

afterEach(disposeAllCodeModeRuns);

it.each(["exec", "resume"] as const)(
  "terminates a real CPU-active %s worker when its catalog closes",
  async (phase) => {
    // Finish hooks stop workers before restoring spies and releasing files.
    const dir = useAutoCleanupTempDirTracker(onTestFinished).make("code-mode-catalog-cpu-");
    const channelName = `catalog-cpu-${phase}-${crypto.randomUUID()}`;
    const executing = observeWorkerActivity(channelName);
    // Keep the real executor in Vitest's graph so the fixture pool receives its work.
    const resolveExecutor = vi
      .spyOn(executorPlugins, "resolvePluginCodeModeExecutor")
      .mockReturnValue(codeModeExecutor);
    onTestFinished(() => resolveExecutor.mockRestore());
    const h = createCatalogCodeModeHarness([], { codeMode: { executor: "quickjs" } });
    onTestFinished(() => clearToolSearchCatalog(h.ctx));
    let parked: Record<string, unknown> = {};
    if (phase === "resume") {
      parked = await h.run("await yield_control(); while (true) {}", "park-cpu");
      expect(parked.status).toBe("waiting");
    }
    const workerUrl = pathToFileURL(path.join(dir, "observed-worker.mts"));
    const quickJsPath = createRequire(productionWorkerUrl).resolve("quickjs-wasi");
    // Observe the real QuickJS interrupt callback, not merely thread startup.
    writeFileSync(
      workerUrl,
      `
        import { BroadcastChannel, threadId } from "node:worker_threads";
        const channel = new BroadcastChannel(${JSON.stringify(channelName)});
        const { QuickJS } = await import(${JSON.stringify(pathToFileURL(quickJsPath).href)});
        for (const method of ["create", "restore"]) {
          const original = QuickJS[method];
          QuickJS[method] = function (...args) {
            const index = method === "create" ? 0 : 1;
            const options = args[index];
            const interrupt = options.interruptHandler;
            let observed = false;
            args[index] = { ...options, interruptHandler: () => {
              if (!observed) { observed = true; channel.postMessage(threadId); }
              return interrupt();
            } };
            return original.apply(this, args);
          };
        }
        await import(${JSON.stringify(productionWorkerUrl.href)});
      `,
    );
    // The executor's pool keeps a process-lifetime URL; temporary workers need their own pool.
    const fixturePool = new WorkerTaskPool({
      workerUrl,
      workerClass: "compute",
      sharedCompute: true,
    });
    const fixtureRun = fixturePool.run.bind(fixturePool);
    const run = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(fixtureRun);
    onTestFinished(async () => {
      run.mockRestore();
      await fixturePool.close();
    });
    const execution =
      phase === "exec" ? h.run("while (true) {}", "cpu") : h.resume(parked, "resume-cpu");
    onTestFinished(async () => {
      clearToolSearchCatalog(h.ctx);
      await execution;
    });
    const worker = await executing;
    clearToolSearchCatalog(h.ctx);
    expect(await execution).toMatchObject({ status: "failed", code: "aborted" });
    // The worker that reported CPU activity must stop before abort settles.
    expect(worker.threadId).toBe(-1);
    expect(activeRuns.size).toBe(0);
    expect(h.catalogRef.onDispose).toBeUndefined();
  },
);

it.each([
  ["returned values", 'return "x".repeat(2_048);', "completed"],
  ["suspended output", 'text("x".repeat(2_048)); await yield_control();', "waiting"],
  ["failed output", 'text("x".repeat(2_048)); throw new Error("boom");', "failed"],
] as const)(
  "bounds oversized %s before sending it across worker threads",
  async (_label, source, status) => {
    const result = await codeModeExecutor.execute(
      {
        kind: "exec",
        source,
        config: resolveCodeModeConfig({
          tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
        } as never),
        catalog: [],
        namespaces: [],
      },
      { timeoutMs: 10_000 },
    );

    if (result.status === "waiting") {
      onTestFinished(() => result.continuation.dispose());
    }
    expect(result.status, result.status === "failed" ? result.error : undefined).toBe(status);

    if (result.status === "failed") {
      expect(result.code).toBe("internal_error");
      expect(result.error).toContain("boom");
    }
    const outputBytes = Buffer.byteLength(result.output.source.json);
    const valueBytes = result.status === "completed" ? Buffer.byteLength(result.value.json) : 0;
    const errorBytes =
      result.status === "failed" ? Buffer.byteLength(JSON.stringify(result.error)) : 0;
    expect(Math.max(outputBytes, valueBytes)).toBeLessThanOrEqual(1_024);
    expect(outputBytes + valueBytes + errorBytes).toBeLessThanOrEqual(2 * 1_024);
  },
);
