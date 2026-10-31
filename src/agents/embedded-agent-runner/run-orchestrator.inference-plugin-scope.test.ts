import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { configFor, modelDefinition } from "../model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { immediateEnqueue } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";

const loop = vi.hoisted(() => vi.fn<(typeof import("./run-loop.js"))["runPreparedEmbeddedLoop"]>());
// mock-isolation: stop before provider inference; plugin selection and ownership remain real.
vi.mock("./run-loop.js", () => ({ runPreparedEmbeddedLoop: loop }));

const evaluationKey = "__openclawInferencePluginEvaluations";

it.each([
  ["modelRun", { modelRun: true }, true, true, false],
  ["promptMode none", { promptMode: "none" }, true, true, false],
  ["ordinary", {}, true, true, true],
  ["tool capable", { modelRun: true }, false, true, true],
  ["ordinary runtime", { modelRun: true }, true, false, true],
] as const)(
  "prepares only the required plugin owners for %s inference",
  async (name, raw, disableTools, isolated, ambient) => {
    const state = await createOpenClawTestState({
      label: "inference-plugin-scope",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const evaluated: string[] = [];
    Object.defineProperty(globalThis, evaluationKey, { configurable: true, value: evaluated });
    let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
    try {
      const plugins = ["selected-provider", "unused-memory", "unused-context"].map((id) => {
        const rootDir = state.path(id);
        fs.mkdirSync(rootDir);
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId: id,
          providerId: id,
          manifest: id === "unused-memory" ? { kind: "memory" } : {},
        });
        fs.writeFileSync(
          fixture.runtimeSource,
          `globalThis[${JSON.stringify(evaluationKey)}].push(${JSON.stringify(id)});
        ${
          id === "selected-provider"
            ? `module.exports = { id: "selected-provider", register(api) {
                api.registerProvider({ id: "selected-provider", label: "Selected provider", auth: [] });
              } };`
            : `throw new Error("Unused agent plugin must not execute for prompt-only inference");`
        }`,
        );
        return fixture;
      });
      const config: OpenClawConfig = {
        ...configFor("selected-provider", "http://127.0.0.1:9/v1", {
          api: "openai-completions",
          apiKey: "synthetic-inference-key",
          models: [
            modelDefinition("model", {
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 1024,
            }),
          ],
        }),
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            model: "selected-provider/model",
            models: { "selected-provider/model": { agentRuntime: { id: "openclaw" } } },
          },
        },
        plugins: {
          allow: plugins.map(({ pluginId }) => pluginId),
          load: { paths: plugins.map(({ rootDir }) => rootDir) },
          slots: { memory: "unused-memory", contextEngine: "unused-context" },
        },
      };
      setRuntimeConfigSnapshot(config);
      loop.mockImplementation(async (_refresh, input) => {
        expect(
          input.preparedModelRuntime?.pluginRegistry?.providers.map(({ provider }) => provider.id),
        ).toContain("selected-provider");
        return {
          payloads: [{ text: "inference boundary reached" }],
          meta: { durationMs: 1, stopReason: "completed" },
        };
      });
      const runId = `inference-plugin-scope-${name.replaceAll(" ", "-")}`;
      admission = prepareSystemAgentRunAdmission(config, runId, "main", "inference-plugin-scope");
      const result = await runEmbeddedAgent({
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        sessionId: runId,
        sessionKey: `agent:main:${runId}`,
        sessionPersistence: "detached",
        sessionManager: SessionManager.inMemory(state.workspaceDir),
        runId,
        provider: "selected-provider",
        model: "model",
        prompt: "Reply briefly.",
        timeoutMs: 5000,
        enqueue: immediateEnqueue,
        preparedRunAdmission: admission,
        ...(isolated ? { preparedModelRuntimeMode: "isolated-read-only" as const } : {}),
        disableTools,
        ...raw,
      });
      expect(result.payloads?.[0]?.text).toBe("inference boundary reached");
      expect(evaluated).toContain("selected-provider");
      expect(evaluated.includes("unused-memory")).toBe(ambient);
      expect(evaluated.includes("unused-context")).toBe(ambient);
    } finally {
      admission?.close();
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      loop.mockReset();
      Reflect.deleteProperty(globalThis, evaluationKey);
      await state.cleanup();
    }
  },
);
