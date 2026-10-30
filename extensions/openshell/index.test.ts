import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import * as runtime from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sandbox from "openclaw/plugin-sdk/sandbox";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import plugin from "./index.js";
import { createOpenShellBackendSandboxConfig } from "./src/openshell.test-support.js";
import { createWorkerFixture } from "./src/worker.test-support.js";

function readBackend() {
  return {
    factory: sandbox.getSandboxBackendFactory("openshell"),
    manager: sandbox.getSandboxBackendManager("openshell"),
    resolveWorkdir: sandbox.getSandboxBackendWorkdirResolver("openshell"),
  };
}

const workdirParams: sandbox.CreateSandboxBackendParams = {
  sessionKey: "agent:openshell-lifecycle:main",
  scopeKey: "agent:openshell-lifecycle:main",
  workspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  agentWorkspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  cfg: createOpenShellBackendSandboxConfig(),
};

const registries: Array<ReturnType<typeof runtime.createEmptyPluginRegistry>> = [];

function registerInRegistry(pluginConfig: OpenClawPluginApi["pluginConfig"]) {
  const { registry } = createPluginRegistryFixture();
  const record = runtime.createPluginRecord({ id: "openshell", origin: "bundled" });
  registry.registry.plugins.push(record);
  registries.push(registry.registry);
  plugin.register(registry.createApi(record, { config: {}, pluginConfig }));
  return registry.registry;
}

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  for (const registry of registries.splice(0).toReversed()) {
    await expect(runtime.disposePluginRegistryInstances(registry)).resolves.toMatchObject({
      failures: [],
    });
  }
});

function registerGeneration(remoteWorkspaceDir: string) {
  const registry = registerInRegistry({ remoteWorkspaceDir });
  const cleanup: NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]> = async (context) => {
    for (const { lifecycle } of registry.runtimeLifecycles.toReversed()) {
      await lifecycle.cleanup?.(context);
    }
  };
  return { backend: readBackend(), cleanup };
}

it.each(["disable", "restart", "reset"] as const)("scopes %s cleanup", async (reason) => {
  const original = readBackend();
  for (const remoteWorkspaceDir of ["/sandbox/first", "/sandbox/second", "/agent/third"]) {
    const generation = registerGeneration(remoteWorkspaceDir);
    expect(generation.backend.factory).toEqual(expect.any(Function));
    expect(generation.backend.manager).not.toBeNull();
    expect(generation.backend.resolveWorkdir?.(workdirParams)).toBe(remoteWorkspaceDir);
    for (const scope of [
      { sessionKey: "agent:other:main" },
      { runId: "other-run" },
      { sessionKey: "" },
      { runId: "" },
    ]) {
      await generation.cleanup({ reason, ...scope });
      expect(readBackend()).toEqual(generation.backend);
    }
    await generation.cleanup({ reason });
    expect(readBackend()).toEqual(reason === "reset" ? generation.backend : original);
    await generation.cleanup({ reason: "disable" });
    expect(readBackend()).toEqual(original);
  }
});

it("routes only the bound agent using the current File Transfer binding", async () => {
  const registry = registerInRegistry({
    worker: createWorkerFixture({ agentId: "main", remoteRoot: "/agent/canonical" }),
  });
  const hooks = runtime.createHookRunner(registry, { catchErrors: false });
  const prompt = (agentId = "main") =>
    hooks.runBeforePromptBuild({ prompt: "hello", messages: [] }, { agentId });
  setRuntimeConfigSnapshot({});
  expect(await prompt()).toBeUndefined();
  for (const nodeId of ["first-node", "replacement-node"]) {
    const config = {
      policyVersion: 2,
      workspaces: { main: { nodeId, remoteRoot: "/agent/canonical" } },
    };
    setRuntimeConfigSnapshot({
      plugins: { entries: { "file-transfer": { enabled: true, config } } },
    });
    expect(await prompt("other")).toBeUndefined();
    const context = (await prompt())?.appendSystemContext;
    for (const part of [nodeId, "/agent/canonical", "file_fetch", "file_write"]) {
      expect(context).toContain(part);
    }
  }
  setRuntimeConfigSnapshot({});
  expect(await prompt()).toBeUndefined();
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
  const originalRegistry = runtime.getActivePluginRegistry();
  onTestFinished(() => {
    if (originalRegistry) {
      runtime.setActivePluginRegistry(originalRegistry);
    } else {
      runtime.resetPluginRuntimeStateForTest();
    }
  });
  const registry = registerInRegistry({ remoteWorkspaceDir: "/sandbox/unstarted" });
  expect(readBackend().resolveWorkdir?.(workdirParams)).toBe("/sandbox/unstarted");
  runtime.setActivePluginRegistry(registry);
  runtime.setActivePluginRegistry(runtime.createEmptyPluginRegistry());
  await expect(runtime.waitForPluginRegistryRetirement(registry)).resolves.toMatchObject({
    failures: [],
  });
  expect(readBackend()).toEqual(originalBackend);
});
