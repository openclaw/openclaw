import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CliPluginInvocationResources } from "../../cli/plugin-invocation-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getPluginRegistryForContext } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { captureAsyncWorkTracker, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { createAgentCleanupScope, runOwnedAgentCleanup } from "../run-cleanup-timeout.js";
import { SessionManager } from "../sessions/session-manager.js";
import { immediateEnqueue } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const loop = vi.hoisted(() =>
  vi.fn<(input: PreparedEmbeddedRunInput) => Promise<EmbeddedAgentRunResult>>(),
);
vi.mock("./run-loop.js", () => ({ runPreparedEmbeddedLoop: loop }));

type Registration = {
  file: string;
  read: () => number;
  disposed: number;
  close: { promise: Promise<void>; resolve: () => void };
};
const fixtureKey = "__openclawCandidateCleanupResources";

it.each([
  "late-success",
  "late-failure",
  "required-timeout",
  "ordinary-error",
  "parent-cancel",
] as const)(
  "holds the candidate's actual registry through %s cleanup and descendants",
  async (mode) => {
    // Direct cases rely solely on the public runner's work owner.
    const state = await createOpenClawTestState({
      label: "candidate-cleanup-resources",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "25" },
    });
    const records = new Map<string, Registration>();
    Object.defineProperty(globalThis, fixtureKey, {
      configurable: true,
      value: { records, next: 0, deferred: createDeferred },
    });
    const cleanupStarted = createDeferred();
    const finishCleanup = createDeferred();
    const cleanupSettled = createDeferred();
    const nestedStarted = createDeferred();
    const finishNested = createDeferred();
    const warnings: string[] = [];
    const cleanupScope = createAgentCleanupScope();
    let selected: Registration | undefined;
    let nested: Promise<number> | undefined;
    let lateRead: number | undefined;
    let signalAbortedAtLogicalResult: boolean | undefined;
    let workSignal: AbortSignal | undefined;
    let logical: Promise<EmbeddedAgentRunResult> | undefined;
    let actualCleanup: Promise<void> | undefined;
    let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
    const cliResources = mode === "parent-cancel" ? new CliPluginInvocationResources() : undefined;
    let parentSignal: AbortSignal | undefined;
    let parentClose: Promise<void> | undefined;
    let parentClosed = false;
    let cancellationSawCandidate = false;
    try {
      const pluginRoot = state.path("provider");
      fs.mkdirSync(pluginRoot);
      const fixture = createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId: "candidate-cleanup",
        providerId: "candidate-provider",
      });
      fs.writeFileSync(
        fixture.runtimeSource,
        `module.exports = { id: "candidate-cleanup", register(api) {
        const state = globalThis[${JSON.stringify(fixtureKey)}];
        const label = "candidate-registration-" + (++state.next);
        const file = require("node:path").join(__dirname, label + ".sqlite");
        const db = new (require("node:sqlite").DatabaseSync)(file);
        db.exec("CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)");
        const record = { file, read: () => db.prepare("SELECT value FROM observations").get().value, disposed: 0, close: state.deferred() };
        state.records.set(label, record);
        api.registerProvider({ id: "candidate-provider", label, auth: [] });
        api.registerRuntimeLifecycle({ id: label, dispose() {
          record.disposed++;
          db.close();
          record.close.resolve();
        } });
      } };`,
      );
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { default: true, workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: "candidate-provider/candidate-model",
            models: { "candidate-provider/candidate-model": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            "candidate-provider": {
              api: "openai-completions",
              apiKey: "synthetic-candidate-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "candidate-model",
                  name: "Candidate model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          allow: [fixture.pluginId],
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      loop.mockImplementation(async (input) => {
        const prepared = input.preparedModelRuntime;
        if (!prepared) {
          throw new Error("Runner did not supply its prepared candidate runtime");
        }
        const label = prepared.pluginRegistry?.providers.find(
          (entry) => entry.provider.id === fixture.providerId,
        )?.provider.label;
        const record = label ? records.get(label) : undefined;
        if (!record) {
          throw new Error("Candidate did not supply its registered provider source");
        }
        selected = record;
        expect(record.read()).toBe(42);
        workSignal = getAsyncWorkSignal();
        if (cliResources) {
          workSignal?.addEventListener(
            "abort",
            () => {
              cancellationSawCandidate = getPluginRegistryForContext() === prepared.pluginRegistry;
            },
            { once: true },
          );
        }
        await runOwnedAgentCleanup({
          runId: input.runParams.runId,
          sessionId: input.runParams.sessionId,
          oneShotCliRun: mode !== "ordinary-error",
          ...(mode === "required-timeout" ? { settlement: "required" as const } : {}),
          step: "candidate-fixture",
          log: {
            warn: (message) => {
              warnings.push(message);
            },
          },
          cleanup: () => {
            actualCleanup = (async () => {
              cleanupStarted.resolve();
              await finishCleanup.promise;
              nested = captureAsyncWorkTracker()(async () => {
                nestedStarted.resolve();
                await finishNested.promise;
                return record.read();
              });
              void nested.catch(() => {});
              lateRead = record.read();
              if (mode === "late-failure" || mode === "ordinary-error") {
                throw new Error("candidate cleanup failure");
              }
            })();
            void actualCleanup.finally(() => cleanupSettled.resolve()).catch(() => {});
            return actualCleanup;
          },
        });
        return {
          payloads: [{ text: "candidate complete" }],
          meta: {
            durationMs: 1,
            stopReason: "completed",
            agentMeta: {
              sessionId: input.runParams.sessionId,
              provider: input.provider,
              model: input.modelId,
            },
          },
        };
      });
      const runId = `candidate-cleanup-${mode}`;
      admission = prepareSystemAgentRunAdmission(cfg, runId, "main", "candidate-cleanup-test");
      const params: RunEmbeddedAgentInternalParams = {
        config: cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        sessionId: runId,
        sessionKey: `agent:main:${runId}`,
        runId,
        provider: fixture.providerId,
        model: "candidate-model",
        prompt: "Complete the synthetic candidate",
        timeoutMs: 5000,
        enqueue: immediateEnqueue,
        preparedRunAdmission: admission,
        preparedModelRuntimeMode: "isolated-read-only",
        sessionPersistence: "detached",
        sessionManager: SessionManager.inMemory(state.workspaceDir),
        oneShotCliRun: mode !== "ordinary-error",
      };
      logical = cleanupScope.run(() =>
        cliResources
          ? cliResources.run(() => {
              parentSignal = getAsyncWorkSignal();
              return runEmbeddedAgent(params);
            })
          : runEmbeddedAgent(params),
      );
      void logical.catch(() => {});
      await Promise.race([
        cleanupStarted.promise,
        logical.then(() => {
          throw new Error("Run completed before cleanup started");
        }),
      ]);
      if (mode === "ordinary-error") {
        finishCleanup.resolve();
      }
      if (mode === "required-timeout" || mode === "ordinary-error") {
        await expect(logical.then(() => undefined)).rejects.toThrow(
          mode === "required-timeout"
            ? "resource replacement refused"
            : "candidate cleanup failure",
        );
      } else {
        expect((await logical).payloads?.[0]?.text).toBe("candidate complete");
      }
      if (!selected) {
        throw new Error("Candidate registry source was not selected");
      }
      admission.close();
      signalAbortedAtLogicalResult = workSignal?.aborted;
      expect.soft(selected.disposed).toBe(0);
      expect.soft(signalAbortedAtLogicalResult ?? false).toBe(false);
      expect(cleanupScope.outcome).toBe("uncertain");
      if (mode !== "ordinary-error") {
        expect(
          warnings.some((warning) => warning.includes("step=candidate-fixture timeoutMs=25")),
        ).toBe(true);
      }
      if (cliResources) {
        parentClose = withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
          cliResources.release(),
        ).then(() => {
          parentClosed = true;
        });
        await Promise.resolve();
        expect(cancellationSawCandidate).toBe(true);
        expect(workSignal?.reason).toBe(parentSignal?.reason);
        expect(parentClosed).toBe(false);
      }
      finishCleanup.resolve();
      await nestedStarted.promise;
      await cleanupSettled.promise;
      expect.soft(lateRead).toBe(42);
      expect.soft(selected.disposed).toBe(0);
      expect.soft(workSignal?.aborted ?? false).toBe(mode === "parent-cancel");
      finishNested.resolve();
      if (!nested) {
        throw new Error("Cleanup did not start its nested work");
      }
      await expect(nested).resolves.toBe(42);
      await selected.close.promise;
      await parentClose;
      if (cliResources) {
        expect(parentClosed).toBe(true);
      }
      expect(selected.disposed).toBe(1);
      expect(cleanupScope.outcome).toBe("uncertain");
      if (mode === "late-failure") {
        expect(
          warnings.some(
            (warning) =>
              warning.includes("rejected after timeout") &&
              warning.includes("candidate cleanup failure"),
          ),
        ).toBe(true);
      }
      const reopened = new DatabaseSync(selected.file, { readOnly: true });
      try {
        expect(reopened.prepare("SELECT value FROM observations").get()?.value).toBe(42);
      } finally {
        reopened.close();
      }
    } finally {
      finishCleanup.resolve();
      finishNested.resolve();
      await Promise.allSettled([logical, actualCleanup, nested]);
      admission?.close();
      await parentClose;
      await cliResources?.release();
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      loop.mockReset();
      Reflect.deleteProperty(globalThis, fixtureKey);
      await state.cleanup();
    }
  },
);
