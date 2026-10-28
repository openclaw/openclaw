import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { configFor, modelDefinition } from "../model-auth.fixtures.test-support.js";
import { scopePreparedModelRuntimeLease } from "../prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";
import { withTestAdmission } from "./run-orchestrator.test-support.js";

type SessionRuntimeInput = Parameters<
  typeof import("./run/attempt-session-runtime-prepare.js").prepareEmbeddedAttemptSessionRuntime
>[0];
const preparation = vi.hoisted(() => vi.fn<(input: SessionRuntimeInput) => Promise<void>>());
// Keep real orchestration, plugin loading, tool construction, and prompts; stop before inference.
vi.mock("./run/attempt-session-runtime-prepare.js", () => ({
  prepareEmbeddedAttemptSessionRuntime: async (input: SessionRuntimeInput) => {
    await preparation(input);
    throw new Error("rooted preparation complete");
  },
}));

const state = await createOpenClawTestState({ label: "rooted-prepared-runtime" });
afterAll(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearCurrentPluginMetadataSnapshot();
  await state.cleanup();
});

it.each([false, true])(
  "reuses configured plugins outside the canonical workspace (admitted=%s)",
  async (admitted) => {
    const taskWorkspace = state.statePath("cron-task");
    await state.writeText("cron-task/task.txt", "task fixture");
    const toolsAllow = ["read", "write", "session_status", "llm-task", "memory-core"];
    const config: OpenClawConfig = {
      ...configFor("proof", "http://127.0.0.1:1/v1", {
        apiKey: "synthetic-proof-key",
        api: "openai-completions",
        models: [
          modelDefinition("model", { reasoning: false, contextWindow: 128000, maxTokens: 4096 }),
        ],
      }),
      agents: {
        entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } },
        defaults: {
          model: "proof/model",
          models: { "proof/model": { agentRuntime: { id: "openclaw" } } },
          sandbox: { mode: "off" },
          skipBootstrap: true,
        },
      },
      plugins: {
        allow: ["llm-task", "memory-core"],
        // The memory slot keeps memory-core's selected tools disabled: a settled generation outcome.
        entries: { "llm-task": { enabled: true }, "memory-core": { enabled: true } },
        slots: { memory: "none" },
      },
      skills: { load: { watch: false } },
      tools: { allow: toolsAllow },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir: state.workspaceDir });
    setGatewayPluginMetadataSnapshot(metadata, {
      config,
      env: process.env,
      workspaceDir: state.workspaceDir,
    });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: metadata,
      allowGatewaySubagentBinding: true,
    });
    const dispatch = expectDefined(
      await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }),
      "published runtime",
    );
    await using parent = admitted
      ? scopePreparedModelRuntimeLease(
          await acquireAgentRunPreparedModelRuntime(
            {
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: dispatch.workspaceDir,
              allowGatewaySubagentBinding: true,
              runtimePluginSelections: [
                { provider: "proof", modelId: "model", runtime: "openclaw" },
              ],
            },
            { pluginGeneration: dispatch.pluginGeneration },
          ),
        )
      : undefined;
    preparation.mockImplementationOnce(async ({ toolBase }) => {
      expect(toolBase.toolsRaw.some((tool) => tool.name === "llm-task")).toBe(true);
      const read = expectDefined(
        toolBase.toolsRaw.find((tool) => tool.name === "read"),
        "rooted read tool",
      );
      expect(await read.execute("task.txt", { path: "task.txt" })).toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining("task fixture") })],
      });
    });
    const name = `task-workspace-proof-${admitted}`;
    const run = withTestAdmission(runEmbeddedAgent, prepareSystemAgentRunAdmission, name);
    const execute = () =>
      run({
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: taskWorkspace,
        config,
        sessionId: name,
        sessionKey: `agent:main:${name}`,
        sessionPersistence: "detached",
        sessionManager: SessionManager.inMemory(taskWorkspace),
        prompt: "Review synthetic workshop files.",
        provider: "proof",
        model: "model",
        agentHarnessId: "openclaw",
        allowGatewaySubagentBinding: true,
        ...(parent ? { pluginGeneration: parent.pluginGeneration } : {}),
        toolsAllow,
        timeoutMs: 30000,
        runId: name,
      });
    await expect(
      parent
        ? parent.run(() => withPluginRuntimeGenerationScope(parent.snapshot, execute))
        : execute(),
    ).rejects.toThrow("rooted preparation complete");
  },
);
