// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import {
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared fleet batches", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-fleet-batch" });
    await resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentIds = ["first", "middle", "last"];
  });

  afterEach(async (context) => {
    await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
  });

  it.each([false, true])(
    "services queued event-loop work between agents (shared workspace: %s)",
    async (sharedWorkspace) => {
      if (sharedWorkspace) {
        for (const id of mocks.configuredAgentIds) {
          mocks.configuredWorkspaces.set(id, state.workspaceDir);
        }
      }
      const events: string[] = [];
      let queued: Promise<void> | undefined;
      mocks.discoverAuthStorage.mockImplementation((agentDir) => {
        const agent = mocks.configuredAgentIds.find((id) => state.agentDir(id) === agentDir)!;
        events.push(agent);
        if (agent === "first") {
          queued = nextTurn().then(() => {
            events.push("event-loop");
          });
        }
        return mocks.authStorage;
      });

      await refreshPreparedModelRuntimeSnapshots(
        {},
        {
          gatewayLifecycle: true,
          catalogMode: "static",
        },
      );
      await queued;

      expect(events.indexOf("first")).toBeLessThan(events.indexOf("event-loop"));
      expect(events.indexOf("event-loop")).toBeLessThan(events.indexOf("last"));
    },
  );

  it("does not start plugin callbacks after cancellation at an event-loop boundary", async () => {
    let cancelled = false;
    let lateLoads = 0;
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      if (cancelled) {
        lateLoads += 1;
      }
      return createEmptyPluginRegistry();
    });
    const publication = publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: state.agentDir("cancelled"),
      workspaceDir: state.workspaceDir,
    });
    cancelled = true;
    markPreparedModelRuntimeSnapshotsStale("cancel before workspace preparation");
    await expect(publication).rejects.toThrow("superseded");
    expect(lateLoads).toBe(0);
  });

  it("captures one immutable config per fleet without freezing the caller or reusing a stale capture", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/first" } },
    };
    const captures: OpenClawConfig[] = [];
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      captures.push((options as { config: OpenClawConfig }).config);
      return { entries: [] };
    });

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(captures).toHaveLength(3);
    expect(new Set(captures).size).toBe(1);
    const first = captures[0]!;
    expect(first).not.toBe(config);
    expect(Object.isFrozen(first.agents?.defaults)).toBe(true);
    expect(Object.isFrozen(config.agents?.defaults)).toBe(false);

    config.agents!.defaults!.model = "fixture/second";
    expect(first.agents?.defaults?.model).toBe("fixture/first");
    captures.length = 0;
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(new Set(captures).size).toBe(1);
    expect(captures[0]).not.toBe(first);
    expect(captures[0]?.agents?.defaults?.model).toBe("fixture/second");
  });

  it("replays an auth change once the first owner starts capturing credentials", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    const previous = AuthStorage.inMemory({ custom: { type: "api_key", key: "old-test-key" } });
    const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      mocks.authStorage.getAll.mockReturnValue(credentials);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return previous;
    });

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const snapshot = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "first",
      agentDir: state.agentDir("first"),
      inheritedAuthDir: state.agentDir("default"),
      workspaceDir: "/tmp/workspace-first",
    });
    expect(snapshot?.createStores().authStorage.getAll()).toEqual(credentials);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
  });

  it("rebinds inherited auth when shared-store ownership moves before first capture", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    const inherited = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    inherited.mockReturnValue(state.agentDir("default"));
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      inherited.mockReturnValue(undefined);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    try {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const snapshot = getPreparedModelRuntimeSnapshot({
        config,
        agentId: "first",
        agentDir: state.agentDir("first"),
        workspaceDir: "/tmp/workspace-first",
      });
      expect(snapshot).toBeDefined();
      expect(snapshot?.inheritedAuthDir).toBeUndefined();
      expect(mocks.discoverAuthStorage.mock.calls.at(-1)?.[1]).not.toHaveProperty(
        "inheritedAuthDir",
      );
    } finally {
      inherited.mockRestore();
    }
  });
});
