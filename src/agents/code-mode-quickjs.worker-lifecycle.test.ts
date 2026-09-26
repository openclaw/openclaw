import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as workerUrls from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeWorkerActivity } from "../../test/helpers/worker-activity.js";
import { resolveBundledPublicSurfaceLocation } from "../plugin-sdk/facade-loader.js";
import * as executorPlugins from "../plugins/code-mode-executor.js";
import type { CodeModeExecutor } from "./code-mode-executor-types.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { activeRuns, disposeAllCodeModeRuns } from "./code-mode-state.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { createCodeModeHarness, resultDetails } from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";

const executorArtifact = resolveBundledPublicSurfaceLocation({
  dirName: "code-mode-quickjs",
  artifactBasename: "code-mode-executor-api.js",
  preferSource: true,
  env: { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions") },
});
if (!executorArtifact) {
  throw new Error("QuickJS executor public artifact is unavailable");
}
const { codeModeExecutor } = await vi.importActual<{ codeModeExecutor: CodeModeExecutor }>(
  executorArtifact.modulePath,
);

afterEach(async () => {
  await disposeAllCodeModeRuns();
  vi.useRealTimers();
});

describe("QuickJS host lifecycle and output", () => {
  it.each(["exec", "resume"] as const)(
    "terminates a real CPU-active %s worker when its catalog closes",
    async (phase) => {
      // Finish hooks unwind in reverse order: stop workers before restoring their
      // loader spies and releasing the channel and files, including on setup failure.
      const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
      const dir = tempDirs.make("code-mode-catalog-cpu-");
      const channelName = `catalog-cpu-${phase}-${crypto.randomUUID()}`;
      const executing = observeWorkerActivity(channelName);
      // Public artifacts load outside Vitest's module graph; keep this real executor
      // in the same graph as the worker URL spy that observes its CPU activity.
      const resolveExecutor = vi
        .spyOn(executorPlugins, "resolvePluginCodeModeExecutor")
        .mockReturnValue(codeModeExecutor);
      onTestFinished(() => resolveExecutor.mockRestore());
      const h = createCodeModeHarness({ codeMode: { executor: "quickjs" } });
      onTestFinished(() => clearToolSearchCatalog(h.ctx));
      applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
      const exec = h.tools.find((tool) => tool.name === "exec");
      const wait = h.tools.find((tool) => tool.name === "wait");
      if (!exec || !wait) {
        throw new Error("Expected Code Mode control tools");
      }
      let runId: unknown;
      if (phase === "resume") {
        const parked = resultDetails(
          await exec.execute("park-cpu", {
            code: "await yield_control(); while (true) {}",
          }),
        );
        expect(parked.status).toBe("waiting");
        runId = parked.runId;
      }
      const workerPath = path.join(dir, "observed-worker.ts");
      await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
      const originalResolveWorker = workerUrls.resolveRuntimeWorkerUrl;
      const resolveWorker = vi
        .spyOn(workerUrls, "resolveRuntimeWorkerUrl")
        .mockImplementation((params) => {
          const productionWorkerUrl = originalResolveWorker(params);
          const quickJsUrl = pathToFileURL(
            createRequire(productionWorkerUrl).resolve("quickjs-wasi"),
          );
          // Observe the real QuickJS interrupt callback, not merely thread startup.
          writeFileSync(
            workerPath,
            `
        import { BroadcastChannel, threadId } from "node:worker_threads";
        const channel = new BroadcastChannel(${JSON.stringify(channelName)});
        const { QuickJS } = await import(${JSON.stringify(quickJsUrl.href)});
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
          return pathToFileURL(workerPath);
        });
      onTestFinished(() => resolveWorker.mockRestore());
      const execution =
        phase === "exec"
          ? exec.execute("cpu", { code: "while (true) {}" })
          : wait.execute("resume-cpu", { runId });
      onTestFinished(async () => {
        clearToolSearchCatalog(h.ctx);
        await execution;
      });
      const worker = await executing;
      clearToolSearchCatalog(h.ctx);
      expect(resultDetails(await execution)).toMatchObject({ status: "failed", code: "aborted" });
      // The worker that reported CPU activity must stop before abort settles.
      expect(worker.threadId).toBe(-1);
      expect(activeRuns.size).toBe(0);
      expect(h.catalogRef.onDispose).toBeUndefined();
    },
  );

  it.each([
    { label: "returned values", source: 'return "x".repeat(2_048);', status: "completed" },
    {
      label: "completed output",
      source: 'text("x".repeat(2_048)); return true;',
      status: "completed",
    },
    {
      label: "combined output and returned values",
      source: 'text("x".repeat(700)); return "y".repeat(700);',
      status: "completed",
    },
    {
      label: "suspended output",
      source: 'text("x".repeat(2_048)); await yield_control("pause"); return true;',
      status: "waiting",
    },
    {
      label: "failed output",
      source: 'text("x".repeat(2_048)); throw new Error("boom");',
      status: "failed",
    },
  ])(
    "bounds oversized $label before sending it across worker threads",
    async ({ source, status }) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
      } as never);

      const result = await codeModeExecutor.execute(
        {
          kind: "exec",
          source,
          config,
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
      expect(outputBytes).toBeLessThanOrEqual(1_024);
      expect(valueBytes).toBeLessThanOrEqual(1_024);
      expect(outputBytes + valueBytes + errorBytes).toBeLessThanOrEqual(2 * 1_024);
      const state = new CodeModeOutputState(1_024);
      state.append(result.output);
      const projected = state.take(
        result.status === "completed"
          ? { value: result.value }
          : result.status === "failed"
            ? { error: result.error }
            : {},
      );
      expect(JSON.stringify(projected)).toContain("rerun with narrower args");
    },
  );
});
