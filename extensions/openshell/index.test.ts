import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  createHookRunner,
  createPluginRecord,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { createOpenShellBackendSandboxConfig } from "./src/openshell.test-support.js";
import { createWorkerFixture } from "./src/worker.test-support.js";

function readBackend() {
  return {
    factory: getSandboxBackendFactory("openshell"),
    manager: getSandboxBackendManager("openshell"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("openshell"),
  };
}

const workdirParams: CreateSandboxBackendParams = {
  sessionKey: "agent:openshell-lifecycle:main",
  scopeKey: "agent:openshell-lifecycle:main",
  workspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  agentWorkspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  cfg: createOpenShellBackendSandboxConfig(),
};

function registerInRegistry(pluginConfig: OpenClawPluginApi["pluginConfig"]) {
  const { registry } = createPluginRegistryFixture();
  const record = createPluginRecord({ id: "openshell", origin: "bundled" });
  registry.registry.plugins.push(record);
  plugin.register(registry.createApi(record, { config: {}, pluginConfig }));
  return registry.registry;
}

describe("OpenShell plugin registration lifecycle", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
  });

  function registerGeneration(remoteWorkspaceDir: string) {
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    const api = createTestPluginApi({
      id: "openshell",
      pluginConfig: { remoteWorkspaceDir },
      registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    });
    plugin.register(api);
    const cleanup = async (
      context: Parameters<NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>>[0],
    ) => {
      for (const lifecycle of lifecycles.toReversed()) {
        await lifecycle.cleanup?.(context);
      }
    };
    const stop = () => cleanup({ reason: "disable" });
    stops.push(stop);
    return { backend: readBackend(), cleanup, stop };
  }

  it.each(["disable", "restart"] as const)("restores hooks on global %s", async (reason) => {
    const original = readBackend();
    for (const remoteWorkspaceDir of ["/sandbox/first", "/sandbox/second", "/agent/third"]) {
      const generation = registerGeneration(remoteWorkspaceDir);
      expect(generation.backend.factory).toEqual(expect.any(Function));
      expect(generation.backend.manager).toEqual({
        describeRuntime: expect.any(Function),
        removeRuntime: expect.any(Function),
      });
      expect(generation.backend.resolveWorkdir?.(workdirParams)).toBe(remoteWorkspaceDir);

      await generation.cleanup({ reason });
      expect(readBackend()).toEqual(original);
      await generation.stop();
      expect(readBackend()).toEqual(original);
    }
  });

  it.each(["disable", "reset"] as const)("preserves hooks on scoped %s", async (reason) => {
    const generation = registerGeneration("/sandbox/scoped");
    for (const scope of [
      { sessionKey: "agent:other:main" },
      { runId: "other-run" },
      { sessionKey: "" },
      { runId: "" },
    ]) {
      await generation.cleanup({ reason, ...scope });
      expect(readBackend()).toEqual(generation.backend);
    }
    if (reason === "reset") {
      await generation.cleanup({ reason });
      expect(readBackend()).toEqual(generation.backend);
    }
  });

  it("routes only the bound agent using the current File Transfer binding", async () => {
    const registry = registerInRegistry({
      worker: createWorkerFixture({ agentId: "main", remoteRoot: "/agent/canonical" }),
    });
    const hooks = createHookRunner(registry, { catchErrors: false });
    const prompt = (agentId = "main") =>
      hooks.runBeforePromptBuild({ prompt: "hello", messages: [] }, { agentId });
    try {
      setRuntimeConfigSnapshot({});
      expect(await prompt()).toBeUndefined();
      for (const nodeId of ["first-node", "replacement-node"]) {
        setRuntimeConfigSnapshot({
          plugins: {
            entries: {
              "file-transfer": {
                enabled: true,
                config: {
                  policyVersion: 2,
                  workspaces: { main: { nodeId, remoteRoot: "/agent/canonical" } },
                },
              },
            },
          },
        });
        expect(await prompt("other")).toBeUndefined();
        const context = (await prompt())?.appendSystemContext;
        for (const part of [nodeId, "/agent/canonical", "file_fetch", "file_write"]) {
          expect(context).toContain(part);
        }
      }
      setRuntimeConfigSnapshot({});
      expect(await prompt()).toBeUndefined();
    } finally {
      clearRuntimeConfigSnapshot();
      await disposePluginRegistryInstances(registry);
    }
  });

  it("does not register runtime hooks or services in discovery mode", () => {
    const original = readBackend();
    const registerService = vi.fn();
    const registerRuntimeLifecycle = vi.fn();
    plugin.register(
      createTestPluginApi({
        registrationMode: "discovery",
        pluginConfig: { remoteWorkspaceDir: "/outside-managed-roots" },
        registerService,
        registerRuntimeLifecycle,
      }),
    );
    expect(registerService).not.toHaveBeenCalled();
    expect(registerRuntimeLifecycle).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
  });

  it("retires a registered backend even when no plugin services ever start", async () => {
    const originalBackend = readBackend();
    const originalRegistry = getActivePluginRegistry();
    const registry = registerInRegistry({ remoteWorkspaceDir: "/sandbox/unstarted" });
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      expect(readBackend().resolveWorkdir?.(workdirParams)).toBe("/sandbox/unstarted");
      setActivePluginRegistry(registry);
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(waitForPluginRegistryRetirement(registry)).resolves.toMatchObject({
        failures: [],
      });
      expect(readBackend()).toEqual(originalBackend);
    } finally {
      await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({
        failures: [],
      });
      if (originalRegistry) {
        setActivePluginRegistry(originalRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
