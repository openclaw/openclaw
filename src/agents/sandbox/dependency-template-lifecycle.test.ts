import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  prepareSandboxDependencyTemplate,
  resolveSandboxDependencyTemplateIdentity,
} from "./dependency-template.js";
import { maybePruneSandboxes, scheduleSandboxPrune } from "./prune.js";
import { prepareSandboxRegistryClose } from "./registry-lifecycle.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { useSandboxRegistryState } from "./registry.test-support.js";

const fake = vi.hoisted(() => ({
  containers: new Map<string, { name: string; running: boolean }>(),
  remove: vi.fn(),
  install: vi.fn(),
  error: vi.fn(),
}));
// mock-isolation: Only the external engine is synthetic; registry, cleanup, and publication are real.
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainer: async (_engine: unknown, args: string[]) => {
    const target = args.at(-1)!;
    const found = [...fake.containers].find(([id, item]) => id === target || item.name === target);
    if (args[0] === "image") {
      return { code: 0, stdout: "a".repeat(64), stderr: "" };
    }
    if (args[0] === "exec") {
      await fake.install();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (!found) {
      return { code: 1, stdout: "", stderr: `no such container ${target}` };
    }
    const [id, item] = found;
    if (args[0] === "kill") {
      item.running = false;
    }
    if (args[0] === "rm") {
      await fake.remove();
      fake.containers.delete(id);
    }
    return {
      code: 0,
      stdout: args.includes("{{json .State}}")
        ? JSON.stringify({ Running: item.running, Paused: false, Pid: item.running ? 123 : 0 })
        : id,
      stderr: "",
    };
  },
}));
// mock-isolation: Provisioning supplies engine facts; the real registry still persists every generation.
vi.mock("./docker.js", async () => {
  const engine = await import("./container-engine.js");
  return {
    ...engine,
    validateSandboxContainerEngineTarget: async () => {},
    ensureSandboxContainer: async (params: { scopeKey: string; workspaceDir: string }) => {
      const id = (fake.containers.size + 1).toString(16).padStart(64, "0");
      const name = `builder-${params.scopeKey}`;
      fake.containers.set(id, { name, running: true });
      await updateRegistry({
        containerName: name,
        backendId: "docker",
        sessionKey: params.scopeKey,
        workspaceDir: params.workspaceDir,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        image: "fixture",
      });
      return { containerName: name, containerId: id };
    },
  };
});
// mock-isolation: This suite exercises dependency builders, never ordinary backend dispatch.
vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: vi.fn(),
  createPodmanSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: {},
  podmanSandboxBackendManager: {},
}));
// mock-isolation: Engine target validation belongs to the synthetic engine, not the host Podman service.
vi.mock("./podman-runtime.js", () => ({ validateSandboxContainerEngineTarget: async () => {} }));
// mock-isolation: No persistent execs or live operator configuration are involved in dependency installation.
vi.mock("./persistent-exec.js", () => ({ recoverSandboxPersistentExecOrphans: async () => {} }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    agents: { defaults: { sandbox: { prune: { idleHours: 0, maxAgeDays: 0 } } } },
  }),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: { error: fake.error },
}));
const fixture = useSandboxRegistryState("dependency-disposal-");
const cfg = {
  ...resolveSandboxConfigForAgent(),
  backend: "docker",
  dockerTmpfsSource: "default",
} as const;
beforeEach(() => {
  fake.containers.clear();
  fake.remove.mockReset().mockResolvedValue(undefined);
  fake.install.mockReset().mockResolvedValue(undefined);
  fake.error.mockClear();
});
async function prepare(scopeKey: string) {
  const identity = await resolveSandboxDependencyTemplateIdentity(cfg, { assertCurrent: () => {} });
  return prepareSandboxDependencyTemplate({
    directory: `${fixture.root}/${scopeKey}`,
    scopeKey,
    cfg,
    identity: identity!,
    assertCurrent: () => {},
    rollbackGuard: () => {},
  });
}

it("publishes stopped builders before slow disposal, serializes removal, and drains all prepares", async () => {
  const remove = createEnteredGate();
  fake.remove.mockImplementation(() => remove.wait());
  const gateway = prepareSandboxRegistryClose();
  const prepared = prepare("one");
  try {
    await awaitGateBeforeSettlement(
      prepared,
      remove.entered,
      "preparation waited for builder removal",
    );
    expect(await prepared).toEqual({ installed: true });
    expect(await Promise.all([prepare("two"), prepare("three")])).toEqual([
      { installed: true },
      { installed: true },
    ]);
    expect([...fake.containers.values()].every((item) => !item.running)).toBe(true);
    expect((await readRegistry()).entries.every((entry) => entry.runtimeState === "removing")).toBe(
      true,
    );
    await remove.entered;
    expect(fake.remove).toHaveBeenCalledOnce();
  } finally {
    remove.release();
    await prepared;
    await gateway.drain();
  }
  expect(fake.containers.size).toBe(0);
  expect((await readRegistry()).entries).toEqual([]);
});

it("retains failed removal for retry and recovers an interrupted running builder at startup", async () => {
  fake.containers.set("b".repeat(64), { name: "interrupted", running: true });
  await updateRegistry({
    containerName: "interrupted",
    backendId: "docker",
    sessionKey: "worktree-dependencies:crashed",
    workspaceDir: `${fixture.root}/crashed`,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: "fixture",
  });
  fake.remove.mockRejectedValueOnce(new Error("synthetic engine failure"));
  const gateway = prepareSandboxRegistryClose();
  try {
    await maybePruneSandboxes();
    expect(fake.error).toHaveBeenCalledWith(expect.stringContaining("synthetic engine failure"));
    expect((await readRegistry()).entries[0]?.runtimeState).toBe("removing");
    scheduleSandboxPrune(() => {}, true);
    await maybePruneSandboxes();
  } finally {
    await gateway.drain();
  }
  expect(fake.containers.size).toBe(0);
  expect((await readRegistry()).entries).toEqual([]);
});

it("protects an active installer and joins its disposal when shutdown begins during installation", async () => {
  const install = createEnteredGate();
  const remove = createEnteredGate();
  fake.install.mockImplementation(() => install.wait());
  fake.remove.mockImplementation(() => remove.wait());
  const gateway = prepareSandboxRegistryClose();
  const prepared = prepare("closing");
  let closing: Promise<void> | undefined;
  try {
    await install.entered;
    scheduleSandboxPrune(() => {}, true);
    await maybePruneSandboxes();
    expect([...fake.containers.values()].every((item) => item.running)).toBe(true);
    expect(fake.remove).not.toHaveBeenCalled();
    closing = gateway.drain();
    install.release();
    await awaitGateBeforeSettlement(prepared, closing, "shutdown forgot the accepted installer");
    await awaitGateBeforeSettlement(remove.entered, closing, "shutdown skipped builder disposal");
  } finally {
    install.release();
    remove.release();
    await prepared;
    await (closing ?? gateway.drain());
  }
  expect(fake.containers.size).toBe(0);
  expect((await readRegistry()).entries).toEqual([]);
});
