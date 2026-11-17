// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, onTestFinished, vi } from "vitest";
import * as configRuntime from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { LegacyContextEngine } from "../context-engine/legacy.js";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { registerPluginSubagentRunFromGateway } from "../gateway/server-methods/agent-subagent-registration.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { createSubagentRegistryContextCleanup } from "./subagents/registry/subagent-registry-context-cleanup.js";
import { createSubagentRegistrationRecord } from "./subagents/registry/subagent-registry-run-launch-record.js";
import { registerSubagentRun } from "./subagents/registry/subagent-registry.js";

// mock-isolation: Capture registration without starting persistence, launchers, or sweeper timers.
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: vi.fn(),
  adoptPausedSubagentRunForFollowUp: vi.fn(async () => false),
  adoptPausedSubagentRunIntoSuccessor: vi.fn(async () => false),
}));

const fixture = usePreparedModelRuntimeHarness({ label: "plugin-subagent-cleanup" });

it.each(["admitted", "inherited", "managed"] as const)(
  "reuses the published registry for plugin-run completion in the %s workspace",
  async (scope) => {
    const { mocks, state } = fixture;
    const admittedScope = {
      agentDir: state.agentDir("work"),
      workspaceDir: state.path("admitted-workspace"),
    };
    const workspaceDir =
      scope === "admitted" ? admittedScope.workspaceDir : state.path(`${scope}-workspace`);
    const sessionEntry: SessionEntry = {
      sessionId: "child-session",
      updatedAt: 1,
      ...(scope === "inherited"
        ? { spawnedBy: "agent:default:main", spawnedWorkspaceDir: workspaceDir }
        : scope === "managed"
          ? { spawnedCwd: workspaceDir }
          : {}),
    };
    mocks.configuredAgentIds = ["default", "work"];
    mocks.configuredWorkspaces.set("work", workspaceDir);
    const config = {
      agents: { entries: { default: {}, work: { workspace: state.path("configured-workspace") } } },
      plugins: { slots: { contextEngine: "fixture" } },
    };
    const configSpy = vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
    onTestFinished(() => configSpy.mockRestore());
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "work" });
    if (!published) {
      throw new Error("Expected the child's published runtime");
    }
    // A lifecycle publication can use a workspace different from config. Neither
    // that admitted scope nor a session override may be reconstructed from config.
    mocks.configuredWorkspaces.set("work", state.path("configured-workspace"));
    const onSubagentEnded = vi.fn();
    registerContextEngineInRegistry(
      published.inboundPluginRegistry,
      "fixture",
      () => Object.assign(new LegacyContextEngine(), { onSubagentEnded }),
      "core",
    );
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
    vi.mocked(registerSubagentRun).mockClear();
    await registerPluginSubagentRunFromGateway({
      ...admittedScope,
      cfg: config,
      runId: "plugin-run",
      childSessionKey: "agent:work:subagent:plugin-run",
      childAgentId: "work",
      task: "background plugin task",
      pluginId: "fixture",
      assertCurrent: () => sessionEntry,
    });
    const registration = vi.mocked(registerSubagentRun).mock.calls[0]?.[0];
    if (!registration) {
      throw new Error("Plugin run was not registered");
    }
    const entry = createSubagentRegistrationRecord(registration, {
      now: 1,
      generation: 1,
      lifecycleGeneration: "fixture",
      childAgentId: "work",
    });
    const cleanup = createSubagentRegistryContextCleanup({ isEndedHookOwnerCurrent: () => true });
    await cleanup.runContextEngineSubagentEnded({
      childSessionKey: entry.childSessionKey,
      reason: "completed",
      agentDir: entry.agentDir,
      workspaceDir: entry.workspaceDir,
    });
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
    expect(onSubagentEnded).toHaveBeenCalledExactlyOnceWith({
      childSessionKey: "agent:work:subagent:plugin-run",
      reason: "completed",
      agentDir: admittedScope.agentDir,
      workspaceDir,
    });
  },
);
