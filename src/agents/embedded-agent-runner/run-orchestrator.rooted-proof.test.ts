import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import * as loader from "../../plugins/loader.js";
import * as metadataInput from "../../plugins/plugin-metadata-snapshot-input.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resolveLegacyInheritedAuthDir } from "../legacy-inherited-auth-dir.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import * as runtimePlugins from "../runtime-plugins.js";
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
  clearCurrentPluginMetadataSnapshot();
  await resetPreparedModelRuntimeSnapshotsForTest();
  await state.cleanup();
  vi.restoreAllMocks();
});

async function readText(
  tools: SessionRuntimeInput["toolBase"]["toolsRaw"],
  file: string,
): Promise<unknown> {
  const read = tools.find((tool) => tool.name === "read");
  if (!read) {
    throw new Error("Run did not expose its read tool");
  }
  return await read.execute(file, { path: file });
}

it("reuses configured plugins for runs outside the canonical workspace", async () => {
  const taskWorkspace = state.path("cron-task");
  await fs.mkdir(taskWorkspace, { recursive: true });
  await fs.writeFile(path.join(taskWorkspace, "task.txt"), "task fixture");
  const toolsAllow = ["read", "write", "session_status", "llm-task", "memory-core"];
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } },
      defaults: {
        model: "proof/model",
        models: { "proof/model": { agentRuntime: { id: "openclaw" } } },
        sandbox: { mode: "off" },
        skipBootstrap: true,
      },
    },
    models: {
      providers: {
        proof: {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "synthetic-proof-key",
          api: "openai-completions",
          models: [
            {
              id: "model",
              name: "proof",
              contextWindow: 128000,
              maxTokens: 4096,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
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
  const load = vi.spyOn(loader, "loadPluginRegistryHandle");
  const runtimeLoad = vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry");
  const syncRuntimeLoad = vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle");
  const metadataBuild = vi.spyOn(metadataInput, "loadPluginMetadataSnapshotInput");
  const expectConfiguredGeneration = ({ attempt, toolBase }: SessionRuntimeInput) => {
    expect(attempt.preparedModelRuntime?.pluginRegistry === configured?.pluginRegistry).toBe(true);
    expect(attempt.preparedModelRuntime?.metadataSnapshot === configured?.metadataSnapshot).toBe(
      true,
    );
    expect(attempt.preparedModelRuntime?.workspaceDir).toBe(state.workspaceDir);
    expect(toolBase.toolsRaw.some((tool) => tool.name === "llm-task")).toBe(true);
  };
  const run = async (name: string, params: { workspaceDir: string }) => {
    const admission = prepareSystemAgentRunAdmission(config, name, "main", name);
    try {
      await expect(
        runEmbeddedAgent({
          ...params,
          config,
          agentId: "main",
          agentDir: state.agentDir(),
          sessionId: name,
          sessionKey: `agent:main:${name}`,
          sessionPersistence: "detached",
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
  };
  try {
    // Cron and subagent workspaces without a bootstrap stay bound to their own directory.
    preparation.mockImplementationOnce(async (input) => {
      expect(input.attempt.workspaceDir).toBe(taskWorkspace);
      expectConfiguredGeneration(input);
      expect(input.setup).toMatchObject({ effectiveWorkspace: taskWorkspace });
      expect(await readText(input.toolBase.toolsRaw, "task.txt")).toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining("task fixture") })],
      });
    });
    await run("task-workspace-proof", { workspaceDir: taskWorkspace });
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(runtimeLoad).not.toHaveBeenCalled();
    expect(syncRuntimeLoad).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(metadataBuild).not.toHaveBeenCalled();
  } finally {
    await resetPreparedModelRuntimeSnapshotsForTest();
  }
});
