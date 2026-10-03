import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import * as loader from "../../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
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
import { rootedAgentRunParams } from "../rooted-run-params.js";
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
  await resetPreparedModelRuntimeSnapshotsForTest();
  await state.cleanup();
  vi.restoreAllMocks();
});

it("reuses configured plugins while keeping rooted file tools confined", async () => {
  const executionRoot = state.path("workshop-skills");
  await fs.mkdir(executionRoot, { recursive: true });
  await fs.writeFile(path.join(executionRoot, "inside.txt"), "rooted fixture");
  const outsideFile = path.join(state.workspaceDir, "outside.txt");
  await fs.writeFile(outsideFile, "canonical workspace fixture");
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
      allow: ["llm-task"],
      entries: { "llm-task": { enabled: true } },
      slots: { memory: "none" },
    },
    skills: { load: { watch: false } },
    tools: { allow: ["read", "write", "session_status", "llm-task"] },
  };
  await state.writeConfig(config);
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir: state.workspaceDir });
    expect(metadata.plugins.some((plugin) => plugin.id === "llm-task")).toBe(true);
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      pluginMetadataSnapshot: metadata,
    });
    const configured = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
    });
    expect(configured).toBeDefined();
    const load = vi.spyOn(loader, "loadPluginRegistryHandle");
    const runtimeLoad = vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry");
    const syncRuntimeLoad = vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle");
    const metadataBuild = vi.spyOn(metadataInput, "loadPluginMetadataSnapshotInput");
    const rooted = rootedAgentRunParams(state.workspaceDir, executionRoot);
    preparation.mockImplementation(async ({ attempt, setup, toolBase }) => {
      expect(attempt).toMatchObject(rooted);
      expect(attempt.preparedModelRuntime?.pluginRegistry === configured?.pluginRegistry).toBe(
        true,
      );
      expect(attempt.preparedModelRuntime?.metadataSnapshot === configured?.metadataSnapshot).toBe(
        true,
      );
      expect(attempt.preparedModelRuntime?.workspaceDir).toBe(state.workspaceDir);
      expect(setup).toMatchObject({
        effectiveWorkspace: executionRoot,
        effectiveCwd: executionRoot,
        effectiveFsWorkspaceOnly: true,
        sessionPermissionRoot: executionRoot,
      });
      expect(toolBase.toolsRaw.some((tool) => tool.name === "llm-task")).toBe(true);
      const read = toolBase.toolsRaw.find((tool) => tool.name === "read");
      if (!read) {
        throw new Error("Rooted run did not expose its read tool");
      }
      expect(await read.execute("inside", { path: "inside.txt" })).toMatchObject({
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("rooted fixture"),
          }),
        ],
      });
      await expect(read.execute("outside", { path: outsideFile })).rejects.toThrow(
        /escapes sandbox root/,
      );
    });
    const admission = prepareSystemAgentRunAdmission(
      config,
      "rooted-proof",
      "main",
      "rooted-proof",
    );
    try {
      await expect(
        runEmbeddedAgent({
          ...rooted,
          config,
          agentId: "main",
          agentDir: state.agentDir(),
          sessionId: "rooted-proof",
          sessionKey: "agent:main:rooted-proof",
          sessionPersistence: "detached",
          prompt: "Review synthetic workshop files.",
          provider: "proof",
          model: "model",
          agentHarnessId: "openclaw",
          toolsAllow: ["read", "write", "session_status", "llm-task"],
          timeoutMs: 30000,
          runId: "rooted-proof",
          preparedRunAdmission: admission,
        }),
      ).rejects.toThrow("rooted preparation complete");
      expect(preparation).toHaveBeenCalledOnce();
      expect(runtimeLoad).not.toHaveBeenCalled();
      expect(syncRuntimeLoad).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(metadataBuild).not.toHaveBeenCalled();
    } finally {
      admission.close();
      await resetPreparedModelRuntimeSnapshotsForTest();
    }
  });
});
