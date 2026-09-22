// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { createPreparedModelRuntimeReplacement } from "./prepared-model-runtime.lifecycle.js";
import * as owners from "./prepared-model-runtime.owner.js";
import { PreparedModelRuntimeOwnerRetention } from "./prepared-model-runtime.retention.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-auto-selection" });

describe("prepared model runtime automatic selections", () => {
  it("acquires nested auto leases without switching to the default agent's runtime policy", async () => {
    fixture.mocks.configuredAgentIds = ["default", "worker"];
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: "xai/grok-4.6", systemAgent: { agentId: "default" } },
        entries: {
          default: { models: { "xai/grok-4.6": { agentRuntime: { id: "openclaw" } } } },
          worker: {},
        },
      },
    };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const dispatch = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    expect(dispatch).toBeDefined();
    const input = {
      ...fixture.agentInput("worker", config),
      workspaceDir: dispatch!.workspaceDir,
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto" }],
    };
    const options = { pluginGeneration: dispatch!.pluginGeneration };
    await using outer = await acquireAgentRunPreparedModelRuntime(input, options);
    const resolveConfiguredOwner = owners.resolveConfiguredOwner;
    let iterations = 0;
    // Bound the pre-fix microtask livelock; a timer cannot interrupt it.
    const guard = vi.spyOn(owners, "resolveConfiguredOwner").mockImplementation((...args) => {
      if (++iterations > 8) {
        throw new Error("lease admission repeated without completing");
      }
      return resolveConfiguredOwner(...args);
    });
    try {
      await using nested = await acquireAgentRunPreparedModelRuntime(
        {
          ...input,
          runtimePluginSelections: [{ ...input.runtimePluginSelections[0]!, agentId: "worker" }],
        },
        options,
      );
      expect(nested.snapshot).toBe(outer.snapshot);
      expect(nested.snapshot.isCurrent()).toBe(true);
    } finally {
      guard.mockRestore();
    }
  });

  it.each([undefined, "worker"])("keeps auto policy scoped before keying (%s)", (agentId) => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "default" } },
        entries: {
          default: { models: { "xai/grok-4.6": { agentRuntime: { id: "other-harness" } } } },
          worker: {},
        },
      },
    };
    fixture.mocks.configuredAgentIds = ["default", "worker"];
    const input = owners.normalizePreparedModelRuntimeInput({
      ...fixture.agentInput("worker", config),
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto", agentId }],
    });
    expect(input.runtimePluginSelections).toEqual([
      { provider: "xai", modelId: "grok-4.6", runtime: "openclaw" },
    ]);
    expect(owners.normalizePreparedModelRuntimeInput(input)).toEqual(input);
  });

  it("rejects a settled replacement that never publishes instead of spinning", async () => {
    const replacement = createPreparedModelRuntimeReplacement();
    replacement.resolve();
    let iterations = 0;
    await expect(
      acquirePreparedModelRuntimeLeaseFromOwners(fixture.agentInput("worker", {}), "run", {
        captureLifetime: () => () => {
          if (++iterations > 16) {
            throw new Error("test iteration guard reached");
          }
        },
        owners: new Map(),
        agentBuildCompletions: new Map(),
        retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
        retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(8),
        getBuildTimeoutMs: () => 120_000,
        getGatewayLifecycleActive: () => true,
        getPendingReplacement: () => replacement,
      }),
    ).rejects.toThrow("lease admission made no publication progress");
  });
});
