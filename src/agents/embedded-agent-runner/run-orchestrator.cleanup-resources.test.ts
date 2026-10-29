import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { CliPluginInvocationResources } from "../../cli/plugin-invocation-resources.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getPluginRegistryForContext } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { captureAsyncWorkTracker, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { createAgentCleanupScope, runOwnedAgentCleanup } from "../run-cleanup-timeout.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createEmbeddedAgentRunnerOpenAiConfig,
  immediateEnqueue,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const loop = vi.hoisted(() => vi.fn<(typeof import("./run-loop.js"))["runPreparedEmbeddedLoop"]>());
vi.mock("./run-loop.js", () => ({ runPreparedEmbeddedLoop: loop }));

type Registration = {
  file: string;
  read: () => number;
  disposed: number;
  close: { promise: Promise<void>; resolve: () => void };
};
const fixtureKey = "__openclawCandidateCleanupResources";

it.each([
  "model-denied",
  "late-success",
  "late-failure",
  "required-timeout",
  "ordinary-error",
  "parent-cancel",
  "dispose-failure",
] as const)(
  "keeps candidate registration and cleanup within execution authority for %s",
  async (mode) => {
    const state = await createOpenClawTestState({
      label: "candidate-cleanup-resources",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS: "25" },
    });
    const records = new Map<string, Registration>();
    Object.defineProperty(globalThis, fixtureKey, {
      configurable: true,
      value: {
        records,
        next: 0,
        deferred: createDeferred,
        failDispose: mode === "dispose-failure",
      },
    });
    const cleanupStarted = createDeferred();
    const finishCleanup = createDeferred();
    const cleanupSettled = createDeferred();
    const nestedStarted = createDeferred();
    const finishNested = createDeferred();
    const initialWriterStarted = createDeferred();
    const finishInitialWriter = createDeferred();
    let initialWriterDisposals = 0;
    const warnings: string[] = [];
    const expectWarning = (...parts: string[]) =>
      expect(warnings.some((warning) => parts.every((part) => warning.includes(part)))).toBe(true);
    const cleanupScope = createAgentCleanupScope();
    let selected: Registration | undefined;
    let nested: Promise<number> | undefined;
    let lateRead: number | undefined;
    let workSignal: AbortSignal | undefined;
    let logical: Promise<EmbeddedAgentRunResult> | undefined;
    let actualCleanup: Promise<void> | undefined;
    let cleanupSettlement: Promise<void> | undefined;
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
        // The database belongs to the test state, not the disposable source generation.
        const file = require("node:path").join(${JSON.stringify(state.path())}, label + ".sqlite");
        const db = new (require("node:sqlite").DatabaseSync)(file);
        db.exec("CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)");
        const record = { file, read: () => db.prepare("SELECT value FROM observations").get().value, disposed: 0, close: state.deferred() };
        state.records.set(label, record);
        api.registerProvider({ id: "candidate-provider", label, auth: [] });
        api.registerRuntimeLifecycle({ id: label, dispose() {
          record.disposed++;
          db.close();
          record.close.resolve();
          if (state.failDispose) throw new Error("candidate dispose failure");
        } });
      } };`,
      );
      const modelProvider = createEmbeddedAgentRunnerOpenAiConfig(["candidate-model"]).models
        ?.providers?.openai;
      assert(modelProvider, "Expected the model catalog fixture");
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            models: {
              "candidate-provider/candidate-model": { agentRuntime: { id: "openclaw" } },
              ...(mode === "model-denied"
                ? { "candidate-provider/restricted-model": { alias: "blocked-alias" } }
                : {}),
            },
          },
        },
        models: {
          providers: {
            "candidate-provider": {
              api: "openai-completions",
              apiKey: "synthetic-candidate-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: modelProvider.models,
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
      setRuntimeConfigSnapshot(cfg);
      loop.mockImplementation(async (_refresh, input) => {
        cleanupSettlement = input.runParams.runCleanupSettlement;
        const prepared = input.preparedModelRuntime;
        assert(prepared, "Runner did not supply its prepared candidate runtime");
        const label = prepared.pluginRegistry?.providers.find(
          (entry) => entry.provider.id === fixture.providerId,
        )?.provider.label;
        const record = label ? records.get(label) : undefined;
        assert(record, "Candidate did not supply its registered provider source");
        selected = record;
        expect(record.read()).toBe(42);
        input.onInitialWriterPrepared({
          async [Symbol.asyncDispose]() {
            initialWriterDisposals += 1;
            initialWriterStarted.resolve();
            expect(getPluginRegistryForContext()).toBe(prepared.pluginRegistry);
            await finishInitialWriter.promise;
            expect(record.read()).toBe(42);
          },
        });
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
          log: { warn: (message) => void warnings.push(message) },
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
          meta: { durationMs: 1, stopReason: "completed" },
        };
      });
      const runId = `candidate-cleanup-${mode}`;
      const operatorAuthority =
        mode === "model-denied"
          ? createAdmittedRunOperatorAuthority({
              profileId: "candidate-reader",
              scopes: ["operator.write"],
              assertCurrent: () => {},
              modelPolicy: prepareOperatorModelPolicy({
                cfg,
                policy: {
                  sourceAgent: "main",
                  allow: ["candidate-provider/*"],
                  deny: ["candidate-provider/restricted-*"],
                },
                manifestPlugins: [],
              }),
            })
          : undefined;
      admission = prepareSystemAgentRunAdmission(
        cfg,
        runId,
        "main",
        "candidate-cleanup-test",
        undefined,
        operatorAuthority,
      );
      const params: RunEmbeddedAgentInternalParams = {
        config: cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        sessionId: runId,
        sessionKey: `agent:main:${runId}`,
        runId,
        provider: fixture.providerId,
        model: mode === "model-denied" ? "blocked-alias" : "candidate-model",
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
      if (mode === "model-denied") {
        await expect(logical).rejects.toThrow("operator role cannot use this model");
        expect(records.size).toBe(0);
        expect(loop).not.toHaveBeenCalled();
        return;
      }
      await awaitGateBeforeSettlement(
        cleanupStarted.promise,
        logical,
        "Run completed before cleanup started",
      );
      if (mode === "ordinary-error" || mode === "dispose-failure") {
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
      assert(selected, "Candidate registry source was not selected");
      admission.close();
      const generationCleanup = cleanupSettlement;
      assert(generationCleanup, "Attempt did not receive its generation cleanup settlement");
      expect.soft([selected.disposed, workSignal?.aborted ?? false]).toEqual([0, false]);
      expect(cleanupScope.outcome).toBe(mode === "dispose-failure" ? "closed" : "uncertain");
      if (mode !== "ordinary-error" && mode !== "dispose-failure") {
        expectWarning("step=candidate-fixture timeoutMs=25");
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
      expect
        .soft([lateRead, selected.disposed, workSignal?.aborted ?? false])
        .toEqual([42, 0, mode === "parent-cancel"]);
      finishNested.resolve();
      assert(nested, "Cleanup did not start its nested work");
      await expect(nested).resolves.toBe(42);
      await initialWriterStarted.promise;
      expect([selected.disposed, initialWriterDisposals]).toEqual([0, 1]);
      finishInitialWriter.resolve();
      await selected.close.promise;
      await parentClose;
      if (cliResources) {
        expect(parentClosed).toBe(true);
      }
      if (mode === "dispose-failure") {
        await expect(generationCleanup).rejects.toThrow(
          "Prepared plugin generation cleanup failed",
        );
        const embeddedRunState = Reflect.get(
          globalThis,
          Symbol.for("openclaw.embeddedRunState"),
        ) as { pendingCleanupOwners?: Set<{ runId: string }> } | undefined;
        expect(embeddedRunState?.pendingCleanupOwners).toBeUndefined();
      } else {
        await generationCleanup;
      }
      expect([selected.disposed, cleanupScope.outcome]).toEqual([
        1,
        mode === "dispose-failure" ? "closed" : "uncertain",
      ]);
      if (mode === "late-failure") {
        expectWarning("rejected after timeout", "candidate cleanup failure");
      }
      using reopened = new DatabaseSync(selected.file, { readOnly: true });
      expect(reopened.prepare("SELECT value FROM observations").get()?.value).toBe(42);
    } finally {
      finishCleanup.resolve();
      finishNested.resolve();
      finishInitialWriter.resolve();
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
