import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startChatSendDiagnostics } from "../../gateway/server-methods/chat-send-diagnostics.js";
import { withDiagnosticsTimelineObserver } from "../../infra/diagnostics-timeline.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  prepareSandboxDependencyTemplate,
  resolveSandboxDependencyTemplateIdentity,
  retireSandboxDependencyTemplate,
} from "./dependency-template.js";
import { bindPodmanSandboxEngine, resolvePodmanSandboxRuntimeInfo } from "./podman-runtime.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  ensure: vi.fn(),
  retire: vi.fn(),
  registry: vi.fn(),
  current: vi.fn(),
  mark: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainer: mocks.exec,
}));
vi.mock("./docker.js", () => ({ ensureSandboxContainer: mocks.ensure }));
// mock-isolation: Installer contract tests have no state owner; real lifecycle coverage lives in the lifecycle suite.
vi.mock("./registry-lifecycle.js", () => ({
  withSandboxRegistrySettlement: (_context: unknown, run: () => Promise<unknown>) => run(),
  acquireSandboxRuntimeUse: async () => ({ [Symbol.dispose]: () => {} }),
}));
// mock-isolation: Unit installation contracts must not initialize backend dispatch or real housekeeping.
vi.mock("./prune.js", () => ({ scheduleSandboxPrune: mocks.schedule }));
vi.mock("./container-inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-inspect.js")>()),
  containerHasTerminated: mocks.retire,
}));
vi.mock("./podman-runtime.js", () => ({
  validateSandboxContainerEngineTarget: vi.fn(),
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
  bindPodmanSandboxEngine: vi.fn(),
}));
// mock-isolation: These installer contracts use synthetic registry facts without opening a state database.
vi.mock("./registry.js", () => ({
  assertSandboxRegistryRetirementCurrent: mocks.current,
  beginSandboxRegistryRemoval: mocks.mark,
  withSandboxRegistryEntryLock: (_entry: unknown, run: () => Promise<void>) => run(),
  readRegistry: mocks.registry,
}));

const directory = "/owned/template";
const image = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const cfg: SandboxConfig = {
  ...resolveSandboxConfigForAgent(),
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
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockImplementation(async (_engine, args: string[]) => ({
    code: 0,
    stdout: args[0] === "image" ? image : args[0] === "inspect" ? containerId : "",
    stderr: "",
  }));
  mocks.ensure.mockResolvedValue({ containerName: "builder", containerId });
  mocks.retire.mockResolvedValue(true);
  mocks.mark.mockImplementation(async (entry) => ({ ...entry, runtimeState: "removing" }));
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

afterEach(() => vi.restoreAllMocks());

async function prepare(config = cfg, signal?: AbortSignal, rollbackGuard = vi.fn()) {
  const identity = await resolveSandboxDependencyTemplateIdentity(config, {
    assertCurrent: () => {},
  });
  expect(identity).toBeDefined();
  const closed = vi.fn();
  try {
    return await withDiagnosticsTimelineObserver(
      (name) => (name.endsWith(".dependency.retire") ? closed : undefined),
      () =>
        prepareSandboxDependencyTemplate({
          directory,
          cfg: config,
          scopeKey: "fixture",
          identity: identity!,
          signal,
          assertCurrent: () => {},
          rollbackGuard,
        }),
    );
  } finally {
    expect(closed).toHaveBeenCalledOnce();
  }
}

it.each([undefined, "PNPM_CONFIG_STORE_DIR", "npm_config_store_dir"])(
  "installs the pinned guest image without session credentials or writable Git metadata (store=%s)",
  async (key) => {
    const storeDir = key ? "/operator/pnpm-store" : "/tmp/openclaw-deps/data/pnpm/store";
    const config =
      key === undefined
        ? cfg
        : {
            ...cfg,
            docker: { ...cfg.docker, env: { ...cfg.docker.env, [key]: storeDir } },
          };
    expect(await prepare(config)).toEqual({ installed: true });
    const admitted = mocks.ensure.mock.calls[0]![0];
    expect(admitted.cfg.docker).toMatchObject({
      image,
      workdir: "/workspace",
      network: "bridge",
      env: {
        CI: "1",
        HOME: "/tmp/openclaw-deps",
        XDG_CONFIG_HOME: "/tmp/openclaw-deps/config",
        XDG_DATA_HOME: "/tmp/openclaw-deps/data",
        XDG_STATE_HOME: "/tmp/openclaw-deps/state",
        XDG_CACHE_HOME: "/tmp/openclaw-deps/cache",
        PNPM_CONFIG_STORE_DIR: storeDir,
        npm_config_store_dir: storeDir,
      },
      binds: undefined,
      setupCommand: undefined,
    });
    expect(admitted.cfg.docker.env).not.toHaveProperty("REGISTRY_PASSWORD");
    expect(admitted.agentWorkspaceDir).toBe(directory);
    expect(admitted.readOnlyResourceMounts).toEqual([
      { hostPath: "/owned/template/.git", containerPath: "/workspace/.git" },
    ]);
    expect(mocks.retire).toHaveBeenCalledWith(
      expect.anything(),
      containerId,
      expect.any(AbortSignal),
    );
    expect(mocks.exec.mock.calls.map(([, args]) => args[0])).not.toContain("rm");
    expect(cfg.docker.env).toHaveProperty("REGISTRY_PASSWORD", "private-fixture");
  },
);

// Build test/fixtures/sandbox-home/Dockerfile and opt in with its image tag.
it.runIf(process.env.OPENCLAW_TEST_SANDBOX_HOME_IMAGE)(
  "installs offline with an absent image HOME and read-only root",
  async () => {
    const { buildSandboxCreateArgs } = await import("./container-allocation.js");
    const run = (args: string[]) => {
      const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
      if (result.error) {
        throw result.error;
      }
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    let id = "";
    mocks.exec.mockImplementation((_engine, args: string[]) => run(args));
    mocks.registry.mockResolvedValue({ entries: [] });
    mocks.ensure.mockImplementation(async (params) => {
      const { argv, env } = buildSandboxCreateArgs({
        name: `openclaw-home-test-${process.pid}`,
        cfg: params.cfg.docker,
        scopeKey: "home-test",
      });
      const created = run([
        ...argv,
        ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "--tmpfs",
        "/workspace:mode=1777",
        "--workdir",
        "/workspace",
        params.cfg.docker.image,
      ]);
      expect(created.code, created.stderr).toBe(0);
      id = created.stdout.trim();
      expect(run(["start", id]).code).toBe(0);
      const seeded = run([
        "exec",
        id,
        "/bin/sh",
        "-c",
        [
          "test ! -e /home/sandbox",
          'printf \'%s\' \'{"name":"home-fixture","private":true}\' > package.json',
          "printf '%s\\n' \"lockfileVersion: '9.0'\" 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' 'importers:' '  .: {}' > pnpm-lock.yaml",
        ].join(" && "),
      ]);
      expect(seeded.code, seeded.stderr).toBe(0);
      return { containerName: id, containerId: id };
    });
    try {
      expect(
        await prepare({
          ...cfg,
          docker: {
            ...cfg.docker,
            image: process.env.OPENCLAW_TEST_SANDBOX_HOME_IMAGE!,
            readOnlyRoot: true,
            network: "none",
            user: "1001:1001",
            tmpfs: [],
          },
        }),
      ).toEqual({ installed: true });
      const files = run(["exec", id, "find", "/workspace", "-mindepth", "1", "-maxdepth", "1"]);
      expect(files.stdout.trim().split("\n").toSorted()).toEqual([
        "/workspace/node_modules",
        "/workspace/package.json",
        "/workspace/pnpm-lock.yaml",
      ]);
      expect(run(["exec", id, "find", "/workspace", "-name", ".pnpm-store"]).stdout).toBe("");
    } finally {
      if (id) {
        expect(run(["rm", "-f", id]).code).toBe(0);
      }
    }
  },
);

it.each(["stdout", "stderr"] as const)(
  "records a bounded, redacted install failure from %s and retires the writer",
  async (stream) => {
    mocks.exec.mockImplementation(async (_engine, args: string[]) => ({
      code: args[0] === "exec" ? 1 : 0,
      stdout: args[0] === "image" ? image : containerId,
      stderr: "",
      ...(args[0] === "exec"
        ? {
            [stream]: `${"progress\n".repeat(400)}ERR_PNPM_NO_OFFLINE_META\npassword=fixture-secret`,
          }
        : {}),
    }));
    const result = await prepare();
    expect(result.installed).toBe(false);
    if (!result.installed) {
      expect(result.reason).toContain("pnpm install failed (exit 1)");
      expect(result.reason).toContain("ERR_PNPM_NO_OFFLINE_META");
      expect(result.reason).not.toContain("fixture-secret");
      expect(result.reason.length).toBeLessThanOrEqual(2100);
    }
    expect(mocks.retire).toHaveBeenCalledOnce();
  },
);

it.each(["ENOSPC", "No space left on device", "No space left\n      on device (os error 28)"])(
  "fails preparation on %s instead of publishing a partial install or source-only success",
  async (failure) => {
    mocks.exec.mockImplementation(async (_engine, args: string[]) => ({
      code: args[0] === "exec" ? 1 : 0,
      stdout: args[0] === "image" ? image : containerId,
      stderr: args[0] === "exec" ? `${failure}\n${"progress\n".repeat(400)}` : "",
    }));
    await expect(prepare()).rejects.toThrow(
      /Sandbox dependency installation ran out of space.*PNPM_CONFIG_STORE_DIR/u,
    );
    expect(mocks.retire).toHaveBeenCalledOnce();
  },
);

it("uses offline installation without skipping source lifecycle scripts", async () => {
  const offlineCfg = { ...cfg, docker: { ...cfg.docker, network: "none" } };
  await prepare(offlineCfg);
  expect(mocks.exec.mock.calls.find(([, args]) => args[0] === "exec")?.[1]).toContain(
    'exec pnpm install --offline --frozen-lockfile --config.optimistic-repeat-install=false --store-dir "$PNPM_CONFIG_STORE_DIR"',
  );
});

it("settles cancellation through independent cleanup authority", async () => {
  const controller = new AbortController();
  const rollbackGuard = vi.fn();
  mocks.ensure.mockImplementation(async () => {
    controller.abort(new Error("run ended"));
    return { containerName: "builder", containerId };
  });
  await expect(prepare(cfg, controller.signal, rollbackGuard)).rejects.toThrow("run ended");
  expect(rollbackGuard).toHaveBeenCalled();
  expect(mocks.retire).toHaveBeenCalledOnce();
});

it("refuses to publish a template whose builder could not be retired", async () => {
  mocks.retire.mockRejectedValue(new Error("writer is still live"));
  await expect(prepare()).rejects.toThrow("writer is still live");
});

it.each(["empty", "removed", "populated", "unreadable", "unresolved"] as const)(
  "retires a local Podman builder using kernel evidence (%s)",
  async (outcome) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const target = { key: "native", globalArgs: ["--remote=false"] };
    vi.mocked(resolvePodmanSandboxRuntimeInfo).mockResolvedValue({
      machine: false,
      rootless: true,
      version: "5.7.0",
      target,
    });
    vi.mocked(bindPodmanSandboxEngine).mockReturnValue({
      id: "podman",
      command: "podman",
      displayName: "Podman",
      globalArgs: target.globalArgs,
    });
    const entry = (await mocks.registry()).entries[0];
    mocks.registry.mockResolvedValue({
      entries: [{ ...entry, backendId: "podman", backendTarget: target }],
    });
    let killed = false;
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 5_001));
    const filesystem = await fs.statfs(".");
    filesystem.type = 0x63677270;
    vi.spyOn(fs, "statfs").mockResolvedValue(filesystem);
    const close = vi.fn().mockResolvedValue(undefined);
    const opened = await fs.open(import.meta.filename, "r");
    await opened.close();
    vi.spyOn(opened, "close").mockImplementation(close);
    vi.spyOn(opened, "read").mockImplementation(async (buffer) => {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("Expected a positional kernel read");
      }
      if (killed && (outcome === "removed" || outcome === "unreadable")) {
        throw Object.assign(new Error("kernel read failed"), {
          code: outcome === "removed" ? "ENODEV" : "EIO",
        });
      }
      const bytesRead = Buffer.from(
        `populated ${!killed || outcome === "populated" ? 1 : 0}\nfrozen 0\n`,
      ).copy(buffer);
      return { bytesRead, buffer };
    });
    vi.spyOn(fs, "open").mockResolvedValue(opened);
    mocks.exec.mockImplementation(async (_engine, args: string[]) => {
      if (args[0] === "kill") {
        killed = true;
      }
      if (args[0] === "wait" && outcome !== "unresolved") {
        throw new Error("conmon cleanup still owns the container lock");
      }
      return {
        code: 0,
        stdout:
          args[0] === "image"
            ? image
            : args[2]?.includes("CgroupPath")
              ? `${containerId}\n${outcome === "unresolved" ? "/" : `/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-${containerId}.scope`}`
              : containerId,
        stderr: "",
      };
    });
    const prepared = prepare({ ...cfg, backend: "podman" });
    if (outcome === "populated" || outcome === "unreadable") {
      await expect(prepared).rejects.toThrow(
        outcome === "populated" ? "still populated; template retained" : "kernel read failed",
      );
    } else {
      await expect(prepared).resolves.toEqual({ installed: true });
    }
    expect(killed).toBe(true);
    expect(close).toHaveBeenCalledTimes(outcome === "unresolved" ? 0 : 1);
    expect(mocks.retire).toHaveBeenCalledTimes(outcome === "unresolved" ? 1 : 0);
  },
);

it.each([true, false])(
  "attributes retirement on the slow-send line (terminated=%s)",
  async (terminated) => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const info = vi.fn();
    const diagnostics = startChatSendDiagnostics({ info });
    const prefix =
      "detail.attempt.setup.sandbox.workspace_selection.prepare.reconcile.dependency.retire";
    mocks.exec.mockImplementation(async (_engine, args: string[]) => {
      clock += args[0] === "kill" ? 19_000 : args[0] === "wait" ? 500 : 100;
      return { code: 0, stdout: containerId, stderr: "" };
    });
    mocks.retire.mockImplementation(async () => {
      clock += 200;
      return terminated;
    });
    try {
      const retired = withDiagnosticsTimelineObserver(diagnostics.observeSpan, () =>
        retireSandboxDependencyTemplate(directory, () => {}),
      );
      if (terminated) {
        await retired;
      } else {
        await expect(retired).rejects.toThrow("still running; template retained");
      }
      diagnostics.finish();
      expect(info).toHaveBeenCalledOnce();
      const line = info.mock.calls[0]![0];
      for (const field of [
        "inspect=100ms",
        "kill=19000ms",
        "wait=500ms",
        "verify=200ms",
        "verify.attempts=1",
      ]) {
        expect(line).toContain(`${prefix}.${field}`);
      }
      expect(line).not.toContain(containerId);
      expect(line).not.toContain(directory);
    } finally {
      now.mockRestore();
    }
  },
);

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
