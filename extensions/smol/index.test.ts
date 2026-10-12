import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createSmolBackendSandboxConfig } from "./src/smol.test-support.js";

function readBackend() {
  return {
    factory: getSandboxBackendFactory("smol"),
    manager: getSandboxBackendManager("smol"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("smol"),
  };
}

const workdirParams: CreateSandboxBackendParams = {
  sessionKey: "agent:smol-lifecycle:main",
  scopeKey: "agent:smol-lifecycle:main",
  workspaceDir: "/tmp/openclaw-smol-lifecycle/workspace",
  agentWorkspaceDir: "/tmp/openclaw-smol-lifecycle/workspace",
  cfg: createSmolBackendSandboxConfig(),
};

describe("smol plugin registration lifecycle", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
  });

  function registerGeneration(workdir?: string) {
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    const api = createTestPluginApi({
      id: "smol",
      pluginConfig: workdir ? { workdir } : {},
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
      for (const workdir of [undefined, "/work/first", "/work/second"]) {
        const generation = registerGeneration(workdir);
        expect(generation.backend.factory).toEqual(expect.any(Function));
        expect(generation.backend.manager).toEqual({
          describeRuntime: expect.any(Function),
          removeRuntime: expect.any(Function),
        });
        expect(generation.backend.resolveWorkdir?.(workdirParams)).toBe(workdir ?? "/workspace");

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
      const generation = registerGeneration("/work/scoped");
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
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
    plugin.register(
      createTestPluginApi({
        registrationMode: "discovery",
        pluginConfig: { workdir: "/work/discovery" },
        registerService: (service) => services.push(service),
        registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
      }),
    );
    expect(services).toEqual([]);
    expect(lifecycles).toEqual([]);
    expect(readBackend()).toEqual(original);
  });

  it("rejects an invalid plugin config at registration", () => {
    expect(() =>
      plugin.register(createTestPluginApi({ id: "smol", pluginConfig: { cpus: 0 } })),
    ).toThrow("Invalid smol plugin config: cpus must be an integer >= 1");
  });
});
