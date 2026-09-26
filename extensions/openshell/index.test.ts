import type {
  OpenClawPluginService,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createOpenShellBackendSandboxConfig } from "./src/openshell.test-support.js";

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

  it.each(["disable", "restart"] as const)(
    "restores eager backend hooks on global %s",
    async (reason) => {
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
    },
  );

  it.each(["disable", "reset"] as const)(
    "preserves global backend hooks during scoped %s cleanup",
    async (reason) => {
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
    },
  );

  it("does not register runtime hooks or services in discovery mode", () => {
    const original = readBackend();
    const services: OpenClawPluginService[] = [];
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    plugin.register(
      createTestPluginApi({
        registrationMode: "discovery",
        pluginConfig: { remoteWorkspaceDir: "/outside-managed-roots" },
        registerService: (service) => services.push(service),
        registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
      }),
    );
    expect(services).toEqual([]);
    expect(lifecycles).toEqual([]);
    expect(readBackend()).toEqual(original);
  });

  it("retires a registered backend even when no plugin services ever start", async () => {
    const originalBackend = readBackend();
    const originalRegistry = getActivePluginRegistry();
    const { registry } = createPluginRegistryFixture();
    const record = createPluginRecord({ id: "openshell" });
    registry.registry.plugins.push(record);
    plugin.register(
      registry.createApi(record, {
        config: {},
        pluginConfig: { remoteWorkspaceDir: "/sandbox/unstarted" },
      }),
    );
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      expect(readBackend().resolveWorkdir?.(workdirParams)).toBe("/sandbox/unstarted");
      setActivePluginRegistry(registry.registry);
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect.poll(readBackend).toEqual(originalBackend);
    } finally {
      await expect(disposePluginRegistryInstances(registry.registry)).resolves.toMatchObject({
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
