import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as backend from "./backend.js";
import type { ReservedSandboxBackendFactoryV1 } from "./backend.types.js";
import { resolveSandboxConfigForAgent as resolveTestSandboxConfig } from "./config.js";
import * as registry from "./registry.js";
const { getSandboxBackendCapabilities, getSandboxBackendFactory } = backend;
const restorers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const restore of restorers.splice(0).toReversed()) {
    restore();
  }
});
function registerSandboxBackend(...args: Parameters<typeof backend.registerSandboxBackend>) {
  const restore = backend.registerSandboxBackend(...args);
  restorers.push(restore);
  return restore;
}
const hooks = (id: string, api = backend) => [
  api.getSandboxBackendFactory(id),
  api.getSandboxBackendManager(id),
  api.getSandboxBackendWorkdirResolver(id),
];

function expectHooks(id: string, expected: ReturnType<typeof hooks>, api = backend) {
  hooks(id, api).forEach((value, index) => expect(value).toBe(expected[index]));
}

const paramsFor = (cfg = resolveTestSandboxConfig(), scopeKey = "test") => ({
  cfg,
  sessionKey: scopeKey,
  scopeKey,
  workspaceDir: "/workspace",
  agentWorkspaceDir: "/workspace",
});

function createGenerationRegistration(label: string) {
  return {
    factory: () => Promise.reject(new Error(`unused sandbox backend ${label}`)),
    manager: {
      describeRuntime: async () => ({ running: true, configLabelMatch: true }),
      removeRuntime: async () => {},
    },
    resolveWorkdir: () => `/runtime/${label}`,
  };
}

describe("sandbox backend registry", () => {
  it.each([false, true])(
    "does not dispatch a retired factory after discovery (replacement=%s)",
    async (replace) => {
      const discovered = createDeferred<string[]>();
      vi.spyOn(registry, "readRegisteredSandboxRuntimeIds").mockReturnValue(discovered.promise);
      const retired = vi.fn(async () => {
        throw new Error("retired factory reached");
      });
      const restore = registerSandboxBackend("changing-selection", retired);
      const preparation = backend.createSandboxBackend(
        paramsFor({ ...resolveTestSandboxConfig(), backend: "changing-selection" }),
      );
      restore();
      const replacement = vi.fn(async () => {
        throw new Error("replacement factory reached");
      });
      if (replace) {
        registerSandboxBackend("changing-selection", replacement);
      }
      discovered.resolve(["registered"]);
      await expect(preparation).rejects.toThrow(
        replace
          ? "replacement factory reached"
          : 'Sandbox backend "changing-selection" is not registered',
      );
      expect(retired).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalledTimes(replace ? 1 : 0);
    },
  );

  it("prepares registered runtimes for custom factories and preserves supplied selection", async () => {
    const read = vi
      .spyOn(registry, "readRegisteredSandboxRuntimeIds")
      .mockResolvedValue(["new", "old"]);
    const factory = vi.fn(async () => {
      throw new Error("provider factory reached");
    });
    registerSandboxBackend("runtime-selection", factory);
    const params = paramsFor({ ...resolveTestSandboxConfig(), backend: "runtime-selection" });
    await expect(backend.createSandboxBackend(params)).rejects.toThrow("provider factory reached");
    expect(read).toHaveBeenCalledExactlyOnceWith({
      backendId: "runtime-selection",
      scopeKey: "test",
    });
    expect(factory).toHaveBeenLastCalledWith({ ...params, registeredRuntimeIds: ["new", "old"] });
    for (const registeredRuntimeIds of [[], ["prepared"]]) {
      await expect(
        backend.createSandboxBackend({ ...params, registeredRuntimeIds }),
      ).rejects.toThrow("provider factory reached");
      expect(factory).toHaveBeenLastCalledWith({ ...params, registeredRuntimeIds });
    }
    expect(read).toHaveBeenCalledOnce();
  });

  it("rechecks runtime authority after custom backend selection", async () => {
    let current = true;
    vi.spyOn(registry, "readRegisteredSandboxRuntimeIds").mockImplementation(async () => {
      current = false;
      return ["retired"];
    });
    const factory = vi.fn(async () => {
      throw new Error("provider factory reached");
    });
    registerSandboxBackend("revoked-selection", factory);
    await expect(
      backend.createSandboxBackend({
        ...paramsFor({ ...resolveTestSandboxConfig(), backend: "revoked-selection" }),
        assertRuntimeCurrent: () => {
          if (!current) {
            throw new Error("runtime removed");
          }
        },
      }),
    ).rejects.toThrow("runtime removed");
    expect(factory).not.toHaveBeenCalled();
  });

  it("checks reserved-runtime authority before invoking an opted-in factory", async () => {
    const factory = vi.fn<ReservedSandboxBackendFactoryV1>(async () => {
      throw new Error("provider factory reached");
    });
    registerSandboxBackend("reserved-authority", {
      factory,
      reserveRuntimeId: () => "reserved-runtime",
    });
    const invoke = getSandboxBackendFactory("reserved-authority")!;
    const params = paramsFor();
    const assertRuntimeCurrent = vi.fn(() => {});
    for (const incomplete of [
      params,
      { ...params, runtimeId: "reserved-runtime" },
      { ...params, assertRuntimeCurrent },
    ]) {
      await expect(invoke(incomplete)).rejects.toThrow("registry-reserved runtime");
    }
    await expect(
      invoke({
        ...params,
        runtimeId: "reserved-runtime",
        assertRuntimeCurrent: () => {
          throw new Error("runtime removed");
        },
      }),
    ).rejects.toThrow("runtime removed");
    expect(factory).not.toHaveBeenCalled();
    await expect(
      invoke({ ...params, runtimeId: "reserved-runtime", assertRuntimeCurrent }),
    ).rejects.toThrow("provider factory reached");
    expect(assertRuntimeCurrent).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("advertises read-only resource projection only for supporting backends", () => {
    expect(getSandboxBackendCapabilities("docker")?.readOnlyResourceMounts).toBe(true);
    expect(getSandboxBackendCapabilities("podman")?.readOnlyResourceMounts).toBe(true);
    expect(getSandboxBackendCapabilities("ssh")?.readOnlyResourceMounts).not.toBe(true);

    const restore = registerSandboxBackend("test-capabilities", {
      factory: createGenerationRegistration("capabilities").factory,
      capabilities: { readOnlyResourceMounts: true },
    });
    expect(getSandboxBackendCapabilities("test-capabilities")?.readOnlyResourceMounts).toBe(true);
    restore();
    expect(getSandboxBackendCapabilities("test-capabilities")).toBeUndefined();
  });

  it.each(["docker", "podman", "ssh"] as const)(
    "preserves %s overrides through repeated module reloads and restores its defaults",
    async (backendId) => {
      const registration = createGenerationRegistration(backendId);
      const restore = registerSandboxBackend(backendId, registration);

      const { factory, manager, resolveWorkdir } = registration;
      for (let reload = 0; reload < 2; reload++) {
        vi.resetModules();
        const fresh = await import("./backend.js");
        expectHooks(backendId, [factory, manager, resolveWorkdir], fresh);
      }
      restore();

      const fresh = await import("./backend.js");
      const container = await import("./docker-backend.js");
      const ssh = await import("./ssh-backend.js");
      const { resolveSandboxConfigForAgent } = await import("./config.js");
      const [defaultFactory, defaultManager] = {
        docker: [container.createDockerSandboxBackend, container.dockerSandboxBackendManager],
        podman: [container.createPodmanSandboxBackend, container.podmanSandboxBackendManager],
        ssh: [ssh.createSshSandboxBackend, ssh.sshSandboxBackendManager],
      }[backendId];
      expect(fresh.getSandboxBackendFactory(backendId)).toBe(defaultFactory);
      expect(fresh.getSandboxBackendManager(backendId)).toBe(defaultManager);
      const cfg = resolveSandboxConfigForAgent();
      const scopeKey = "agent:registry-test:main";
      const workdir = fresh.getSandboxBackendWorkdirResolver(backendId)?.(paramsFor(cfg, scopeKey));
      expect(workdir).toBe(
        backendId === "ssh"
          ? ssh.resolveSshRuntimePaths(cfg.ssh.workspaceRoot, scopeKey).remoteWorkspaceDir
          : cfg.docker.workdir,
      );
    },
  );

  it("does not inherit built-in management hooks for a factory-only override", () => {
    const registration = createGenerationRegistration("docker");
    registerSandboxBackend("docker", registration.factory);
    expectHooks("docker", [registration.factory, null, null]);
  });

  it.each([
    ["skip retired predecessors", ["A", "B", "C"], [1, 0, 2], ["C", "C", null]],
    ["restore newest predecessor", ["A", "B", "C"], [1, 2, 0], ["C", "A", null]],
    ["repeat stale disposal", ["A", "B"], [1, 0, 1], ["A", null, null]],
    ["same object registered twice", ["A", "B", "A"], [2, 0, 1, 2], ["B", "B", null, null]],
  ] as const)("preserves all backend authority: %s", (_scenario, initial, dispose, active) => {
    const backendId = "test-generation-ownership";
    const registrations = new Map(
      [...new Set(initial)].map((label) => [label, createGenerationRegistration(label)]),
    );
    const disposers = initial.map((label) =>
      registerSandboxBackend(backendId, registrations.get(label)!),
    );
    for (const [index, slot] of dispose.entries()) {
      const expectedLabel = active[index];
      disposers[slot]!();
      const expected = expectedLabel ? registrations.get(expectedLabel) : undefined;
      expectHooks(backendId, [
        expected?.factory ?? null,
        expected?.manager ?? null,
        expected?.resolveWorkdir ?? null,
      ]);
    }
  });
});
