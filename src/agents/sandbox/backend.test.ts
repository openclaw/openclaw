import { describe, expect, it, vi } from "vitest";
import * as backend from "./backend.js";
import type { ReservedSandboxBackendFactoryV1 } from "./backend.types.js";
import { resolveSandboxConfigForAgent as resolveTestSandboxConfig } from "./config.js";
const {
  getSandboxBackendCapabilities,
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
} = backend;
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
  it("checks reserved-runtime authority before invoking an opted-in factory", async () => {
    const factory = vi.fn<ReservedSandboxBackendFactoryV1>(async () => {
      throw new Error("provider factory reached");
    });
    const restore = registerSandboxBackend("reserved-authority", {
      factory,
      reserveRuntimeId: () => "reserved-runtime",
    });
    try {
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
    } finally {
      restore();
    }
  });

  it("registers Podman as a built-in backend", () => {
    expect(getSandboxBackendFactory("podman")).not.toBeNull();
    expect(getSandboxBackendManager("podman")).not.toBeNull();
    expect(getSandboxBackendWorkdirResolver("podman")).not.toBeNull();
  });

  it("advertises read-only resource projection only for supporting backends", () => {
    expect(getSandboxBackendCapabilities("docker")?.readOnlyResourceMounts).toBe(true);
    expect(getSandboxBackendCapabilities("podman")?.readOnlyResourceMounts).toBe(true);
    expect(getSandboxBackendCapabilities("ssh")?.readOnlyResourceMounts).not.toBe(true);

    const restore = registerSandboxBackend("test-capabilities", {
      factory: createGenerationRegistration("capabilities").factory,
      capabilities: { readOnlyResourceMounts: true },
    });
    try {
      expect(getSandboxBackendCapabilities("test-capabilities")?.readOnlyResourceMounts).toBe(true);
    } finally {
      restore();
    }
    expect(getSandboxBackendCapabilities("test-capabilities")).toBeUndefined();
  });

  it.each(["docker", "podman", "ssh"] as const)(
    "preserves %s overrides through repeated module reloads and restores its defaults",
    async (backendId) => {
      const defaults = hooks(backendId);
      const registration = createGenerationRegistration(backendId);
      const restore = registerSandboxBackend(backendId, registration);

      try {
        const { factory, manager, resolveWorkdir } = registration;
        for (let reload = 0; reload < 2; reload++) {
          vi.resetModules();
          const fresh = await import("./backend.js");
          expectHooks(backendId, [factory, manager, resolveWorkdir], fresh);
        }
      } finally {
        restore();
      }

      expectHooks(backendId, defaults);

      const fresh = await import("./backend.js");
      const container = await import("./docker-backend.js");
      const ssh = await import("./ssh-backend.js");
      const { resolveSandboxConfigForAgent } = await import("./config.js");
      const [factory, manager] = {
        docker: [container.createDockerSandboxBackend, container.dockerSandboxBackendManager],
        podman: [container.createPodmanSandboxBackend, container.podmanSandboxBackendManager],
        ssh: [ssh.createSshSandboxBackend, ssh.sshSandboxBackendManager],
      }[backendId];
      expect(fresh.getSandboxBackendFactory(backendId)).toBe(factory);
      expect(fresh.getSandboxBackendManager(backendId)).toBe(manager);
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
    const restore = registerSandboxBackend("docker", registration.factory);
    try {
      expectHooks("docker", [registration.factory, null, null]);
    } finally {
      restore();
    }
  });

  it("restores distinct entries when the same registration object is installed twice", () => {
    const backendId = "test-repeated-registration";
    const shared = createGenerationRegistration("shared");
    const middle = createGenerationRegistration("middle");
    const first = registerSandboxBackend(backendId, shared);
    const second = registerSandboxBackend(backendId, middle);
    const third = registerSandboxBackend(backendId, shared);
    try {
      third();
      expect(getSandboxBackendFactory(backendId)).toBe(middle.factory);
      expect(getSandboxBackendManager(backendId)).toBe(middle.manager);
      expect(getSandboxBackendWorkdirResolver(backendId)).toBe(middle.resolveWorkdir);
      first();
      expect(getSandboxBackendFactory(backendId)).toBe(middle.factory);
      second();
      expect(getSandboxBackendFactory(backendId)).toBeNull();
      third();
      expect(getSandboxBackendFactory(backendId)).toBeNull();
    } finally {
      third();
      second();
      first();
    }
  });

  it.each([
    ["older retires first", ["A", "B"], ["B", null]],
    ["restore predecessor", ["B", "A"], ["A", null]],
    ["skip retired predecessors", ["B", "A", "C"], ["C", "C", null]],
    ["restore newest predecessor", ["B", "C", "A"], ["C", "A", null]],
    ["repeat stale disposal", ["B", "A", "B"], ["A", null, null]],
  ] as const)("preserves all backend authority: %s", (_scenario, dispose, active) => {
    const generations = [...new Set(dispose)].toSorted();
    const backendId = "test-generation-ownership";
    const registrations = new Map<string, ReturnType<typeof createGenerationRegistration>>();
    const disposers = new Map<string, () => void>();

    try {
      for (const label of generations) {
        const registration = createGenerationRegistration(label);
        registrations.set(label, registration);
        disposers.set(label, registerSandboxBackend(backendId, registration));
      }

      for (const [index, disposedLabel] of dispose.entries()) {
        const expectedLabel = active[index];
        disposers.get(disposedLabel)!();

        const expected = expectedLabel ? registrations.get(expectedLabel) : undefined;
        expectHooks(backendId, [
          expected?.factory ?? null,
          expected?.manager ?? null,
          expected?.resolveWorkdir ?? null,
        ]);
      }
    } finally {
      for (const retire of Array.from(disposers.values()).toReversed()) {
        retire();
      }
    }
  });
});
