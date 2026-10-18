import { beforeEach, expect, it, vi } from "vitest";
import {
  prepareSandboxDependencyTemplate,
  resolveSandboxDependencyTemplateIdentity,
} from "./dependency-template.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  ensure: vi.fn(),
  retire: vi.fn(),
  registry: vi.fn(),
  current: vi.fn(),
}));
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainer: mocks.exec,
}));
vi.mock("./docker.js", () => ({ ensureSandboxContainer: mocks.ensure }));
vi.mock("./manage.js", () => ({ removeSandboxRuntimeGeneration: mocks.retire }));
vi.mock("./podman-runtime.js", () => ({
  validateSandboxContainerEngineTarget: vi.fn(),
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
  bindPodmanSandboxEngine: vi.fn(),
}));
vi.mock("./registry.js", () => ({
  assertSandboxRegistryEntryCurrent: mocks.current,
  readRegistry: mocks.registry,
}));

const directory = "/owned/template";
const image = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const cfg: SandboxConfig = {
  mode: "all",
  backend: "docker",
  scope: "session",
  workspaceAccess: "rw",
  workspaceRoot: "/owned",
  dockerTmpfsSource: "default",
  docker: createSandboxTestContext({
    dockerOverrides: {
      image: "fixture:mutable",
      network: "bridge",
      env: { REGISTRY_PASSWORD: "private-fixture" },
      binds: ["/private:/private"],
      setupCommand: "private-setup",
    },
  }).docker,
  ssh: {
    command: "ssh",
    workspaceRoot: "/workspace",
    strictHostKeyChecking: true,
    updateHostKeys: false,
  },
  browser: {
    enabled: false,
    image: "unused",
    containerPrefix: "unused",
    network: "none",
    cdpPort: 9222,
    vncPort: 5900,
    noVncPort: 6080,
    headless: true,
    noVncEnabled: false,
    allowHostControl: false,
    autoStart: false,
    autoStartTimeoutMs: 1000,
  },
  tools: {},
  prune: { idleHours: 24, maxAgeDays: 7 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockImplementation(async (_engine, args: string[]) => ({
    code: 0,
    stdout: args[0] === "image" ? image : args[0] === "inspect" ? containerId : "",
    stderr: "",
  }));
  mocks.ensure.mockResolvedValue({ containerName: "builder", containerId });
  mocks.retire.mockResolvedValue(undefined);
  mocks.registry.mockResolvedValue({
    entries: [
      {
        containerName: "builder",
        backendId: "docker",
        sessionKey: "worktree-dependencies:fixture",
        workspaceDir: directory,
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image,
      },
    ],
  });
});

async function prepare(signal?: AbortSignal, rollbackGuard = vi.fn()) {
  const identity = await resolveSandboxDependencyTemplateIdentity(cfg, {
    assertCurrent: () => {},
  });
  expect(identity).toBeDefined();
  return await prepareSandboxDependencyTemplate({
    directory,
    cfg,
    scopeKey: "fixture",
    identity: identity!,
    signal,
    assertCurrent: () => {},
    rollbackGuard,
  });
}

it("installs the pinned guest image without session credentials or writable Git metadata", async () => {
  expect(await prepare()).toEqual({ installed: true });
  const admitted = mocks.ensure.mock.calls[0]![0];
  expect(admitted.cfg.docker).toMatchObject({
    image,
    workdir: "/workspace",
    network: "bridge",
    env: { CI: "1" },
    binds: undefined,
    setupCommand: undefined,
  });
  expect(admitted.cfg.docker.env).not.toHaveProperty("REGISTRY_PASSWORD");
  expect(admitted.agentWorkspaceDir).toBe(directory);
  expect(admitted.readOnlyResourceMounts).toEqual([
    { hostPath: "/owned/template/.git", containerPath: "/workspace/.git" },
  ]);
  expect(mocks.retire).toHaveBeenCalledWith(expect.objectContaining({ id: containerId }));
  expect(cfg.docker.env).toHaveProperty("REGISTRY_PASSWORD", "private-fixture");
});

it("records install failure without exposing installer output and retires the writer", async () => {
  mocks.exec.mockImplementation(async (_engine, args: string[]) => ({
    code: args[0] === "exec" ? 1 : 0,
    stdout: args[0] === "image" ? image : containerId,
    stderr: "registry password private-fixture",
  }));
  expect(await prepare()).toEqual({ installed: false, reason: "pnpm install failed (exit 1)" });
  expect(mocks.retire).toHaveBeenCalledOnce();
});

it("uses offline installation when the sandbox has no network", async () => {
  const offlineCfg = { ...cfg, docker: { ...cfg.docker, network: "none" } };
  const identity = await resolveSandboxDependencyTemplateIdentity(offlineCfg, {
    assertCurrent: () => {},
  });
  if (!identity) {
    throw new Error("Fixture image identity is missing");
  }
  await prepareSandboxDependencyTemplate({
    directory,
    cfg: offlineCfg,
    scopeKey: "fixture",
    identity,
    assertCurrent: () => {},
    rollbackGuard: () => {},
  });
  expect(mocks.exec.mock.calls.find(([, args]) => args[0] === "exec")?.[1]).toContain(
    "exec pnpm install --offline --frozen-lockfile",
  );
});

it("settles cancellation through independent cleanup authority", async () => {
  const controller = new AbortController();
  const rollbackGuard = vi.fn();
  mocks.ensure.mockImplementation(async () => {
    controller.abort(new Error("run ended"));
    return { containerName: "builder", containerId };
  });
  await expect(prepare(controller.signal, rollbackGuard)).rejects.toThrow("run ended");
  expect(rollbackGuard).toHaveBeenCalled();
  expect(mocks.retire).toHaveBeenCalledOnce();
});

it("refuses to publish a template whose builder could not be retired", async () => {
  mocks.retire.mockRejectedValue(new Error("writer is still live"));
  await expect(prepare()).rejects.toThrow("writer is still live");
});

it("retries a failed dependency generation when its network policy changes", async () => {
  const options = { assertCurrent: () => {} };
  const disconnected = await resolveSandboxDependencyTemplateIdentity(
    { ...cfg, docker: { ...cfg.docker, network: "none" } },
    options,
  );
  const connected = await resolveSandboxDependencyTemplateIdentity(cfg, options);
  expect(disconnected?.key).not.toBe(connected?.key);
  const rotatedCredentials = await resolveSandboxDependencyTemplateIdentity(
    { ...cfg, docker: { ...cfg.docker, env: { REGISTRY_PASSWORD: "rotated-private-fixture" } } },
    options,
  );
  expect(rotatedCredentials?.key).toBe(connected?.key);
});
