import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import * as loader from "../../plugins/loader.js";
import * as metadataInput from "../../plugins/plugin-metadata-snapshot-input.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resolveLegacyInheritedAuthDir } from "../legacy-inherited-auth-dir.js";
import { configFor, modelDefinition } from "../model-auth.fixtures.test-support.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import * as runtimePlugins from "../runtime-plugins.js";
import { SessionManager } from "../sessions/session-manager.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";

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
  vi.restoreAllMocks();
});

it("reuses configured plugins for runs outside the canonical workspace", async () => {
  const taskWorkspace = state.path("cron-task");
  await fs.mkdir(taskWorkspace, { recursive: true });
  await fs.writeFile(path.join(taskWorkspace, "task.txt"), "task fixture");
  const toolsAllow = ["read", "write", "session_status", "llm-task", "memory-core"];
  const config: OpenClawConfig = {
    ...configFor("proof", "http://127.0.0.1:1/v1", {
      apiKey: "synthetic-proof-key",
      api: "openai-completions",
      models: [
        modelDefinition("model", {
          name: "proof",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 4096,
        }),
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
  // A Gateway projects its boot inventory for every run workspace.
  const metadata = loadPluginMetadataSnapshot({ config, workspaceDir: state.workspaceDir });
  expect(metadata.plugins.some((plugin) => plugin.id === "llm-task")).toBe(true);
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
  const configured = getPreparedModelRuntimeSnapshot({
    config,
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
    allowGatewaySubagentBinding: true,
  });
  expect(configured).toBeDefined();
  const reloads = [
    vi.spyOn(loader, "loadPluginRegistryHandle"),
    vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry"),
    vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle"),
    vi.spyOn(metadataInput, "loadPluginMetadataSnapshotInput"),
  ];
  // Cron and subagent workspaces stay local while reusing the configured plugin generation.
  preparation.mockImplementationOnce(async ({ attempt, toolBase, setup }) => {
    expect(attempt.workspaceDir).toBe(taskWorkspace);
    expect(attempt.preparedModelRuntime?.pluginRegistry).toBe(configured?.pluginRegistry);
    expect(attempt.preparedModelRuntime?.metadataSnapshot).toBe(configured?.metadataSnapshot);
    expect(attempt.preparedModelRuntime?.workspaceDir).toBe(state.workspaceDir);
    expect(toolBase.toolsRaw.some((tool) => tool.name === "llm-task")).toBe(true);
    expect(setup).toMatchObject({ effectiveWorkspace: taskWorkspace });
    const read = toolBase.toolsRaw.find((tool) => tool.name === "read");
    if (!read) {
      throw new Error("Run did not expose its read tool");
    }
    expect(await read.execute("task.txt", { path: "task.txt" })).toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("task fixture") })],
    });
  });
  const name = "task-workspace-proof";
  const admission = prepareSystemAgentRunAdmission(config, name, "main", name);
  try {
    await expect(
      runEmbeddedAgent({
        workspaceDir: taskWorkspace,
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        sessionId: name,
        sessionKey: `agent:main:${name}`,
        sessionPersistence: "detached",
        sessionManager: SessionManager.inMemory(taskWorkspace),
        prompt: "Review synthetic workshop files.",
        provider: "proof",
        model: "model",
        agentHarnessId: "openclaw",
        allowGatewaySubagentBinding: true,
        toolsAllow,
        timeoutMs: 30000,
        runId: name,
        preparedRunAdmission: admission,
      }),
    ).rejects.toThrow("rooted preparation complete");
  } finally {
    admission.close();
  }
  expect(preparation).toHaveBeenCalledTimes(1);
  for (const reload of reloads) {
    expect(reload).not.toHaveBeenCalled();
  }
});
