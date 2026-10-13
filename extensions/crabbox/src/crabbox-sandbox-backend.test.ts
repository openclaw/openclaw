import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type {
  CreateReservedSandboxBackendParamsV1,
  RemoteShellCommandSpec,
  RemoteShellSandboxBackendOptions,
  RemoteShellSessionOptions,
  SandboxBackendCommandParams,
} from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
} from "./crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";

const remote = vi.hoisted(() => ({
  createBackend: vi.fn(),
  createSession: vi.fn(),
  commands: [] as RemoteShellCommandSpec[],
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  createRemoteShellSandboxBackend: remote.createBackend,
  createRemoteShellSandboxSession: remote.createSession,
  getSandboxBackendWorkdirResolver: vi.fn(),
  SandboxRuntimeRetiredError: class extends Error {
    constructor(readonly runtimeId: string) {
      super(`Sandbox runtime ${runtimeId} is retired`);
    }
  },
}));

const LEASE_ID = "cbx_0123456789ab";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crabbox-test-"));
afterAll(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function result(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}
function inspect(state = "started", id = LEASE_ID): SpawnResult {
  return result(JSON.stringify({ id, state, ready: state === "started" }));
}
function respond(argv: string[]): SpawnResult {
  if (argv[1] === "exec" && argv.includes("--check")) {
    return result(
      JSON.stringify({
        provider: "daytona",
        target: "linux",
        execution: true,
        currentRepoStop: true,
      }),
    );
  }
  return argv[1] === "inspect" ? inspect() : result();
}
function params(
  overrides: Partial<CreateReservedSandboxBackendParamsV1> = {},
): CreateReservedSandboxBackendParamsV1 {
  const context = createSandboxTestContext();
  return {
    runtimeId: LEASE_ID,
    assertRuntimeCurrent: vi.fn(() => {}),
    scopeKey: "agent:main:session:fixture",
    sessionKey: "agent:main:session:fixture",
    workspaceDir: temporaryRoot,
    agentWorkspaceDir: temporaryRoot,
    cfg: {
      mode: "all",
      backend: "crabbox",
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: temporaryRoot,
      dockerTmpfsSource: "default",
      docker: context.docker,
      ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
      browser: createSandboxBrowserConfig(),
      tools: context.tools,
      prune: createSandboxPruneConfig(),
    },
    ...overrides,
  };
}
function setup(handler: (argv: string[]) => SpawnResult | Promise<SpawnResult> = respond) {
  const runCommand = vi
    .mocked(runCommandWithTimeout)
    .mockImplementation(async (argv) => await handler(argv));
  const dependencies = {
    openclawRoot: temporaryRoot,
    pluginConfig: {
      binary: "/fixture/crabbox",
      provider: "daytona",
      class: "small",
      ttl: "2h",
      idleTimeout: "30m",
    },
  };
  return {
    runCommand,
    factory: createCrabboxSandboxBackendFactory(dependencies),
    manager: createCrabboxSandboxBackendManager(dependencies),
  };
}
beforeEach(() => {
  vi.mocked(runCommandWithTimeout).mockReset();
  remote.commands.length = 0;
  remote.createBackend.mockReset();
  remote.createSession.mockReset();
  remote.createSession.mockImplementation((options: RemoteShellSessionOptions) => ({
    runCommand: async (command: { remoteCommand: string; tty?: boolean }) => {
      options.assertCurrent?.();
      remote.commands.push(options.buildCommand(command));
      return { stdout: Buffer.from("remote-ok"), stderr: Buffer.alloc(0), code: 0 };
    },
  }));
  remote.createBackend.mockImplementation(
    async (
      _params: CreateReservedSandboxBackendParamsV1,
      options: RemoteShellSandboxBackendOptions,
    ) => ({
      id: options.backendId,
      runtimeId: options.runtimeId,
      configLabel: options.configLabel,
      runShellCommand: async (command: SandboxBackendCommandParams) => {
        const session = await options.createSession();
        return session.runCommand({ remoteCommand: command.script, stdin: command.stdin });
      },
    }),
  );
});

describe("Crabbox sandbox provider lifecycle", () => {
  it("rejects providers without scoped cleanup before allocating a lease", async () => {
    const { factory, runCommand } = setup(() =>
      result(JSON.stringify({ execution: true, currentRepoStop: false })),
    );
    await expect(factory(params())).rejects.toThrow("repository-scoped cleanup");
    expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["exec"]);
  });

  it.each(["released"])("retires only a matching released inspection (%s)", async (state) => {
    const { factory } = setup((argv) =>
      argv[1] === "warmup"
        ? result("fixture-credential@ssh.example.test", 4)
        : argv[1] === "inspect"
          ? inspect(state)
          : respond(argv),
    );
    await expect(factory(params())).rejects.toThrow(
      state === "released" ? /is retired/ : "Crabbox sandbox warmup failed: exit 4",
    );
  });

  it("rejects a foreign released ID without retiring the reservation", async () => {
    const { factory } = setup((argv) =>
      argv[1] === "warmup"
        ? result("failed", 4)
        : argv[1] === "inspect"
          ? inspect("released", "cbx_aaaaaaaaaaaa")
          : respond(argv),
    );
    await expect(factory(params())).rejects.toThrow("warmup failed");
  });

  it("validates runtime authority and unsupported binds before allocation", async () => {
    const { factory, runCommand } = setup();
    await expect(factory(params({ runtimeId: "" }))).rejects.toThrow("fixed lease");
    await expect(
      factory(
        params({
          assertRuntimeCurrent: () => {
            throw new Error("removed");
          },
        }),
      ),
    ).rejects.toThrow("removed");
    const input = params();
    input.cfg.docker.binds = ["/host:/remote"];
    await expect(factory(input)).rejects.toThrow("docker.binds");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

it("routes every remote operation through Crabbox with original local cwd and host credentials", async () => {
  vi.stubEnv("CRABBOX_TEST_PROVIDER_CREDENTIAL", "synthetic-host-only");
  const { factory, runCommand } = setup();
  const handle = await factory(params());
  await handle.runShellCommand({ script: "printf first" });
  await handle.runShellCommand({ script: "printf second" });
  expect(remote.commands.map((command) => command.argv)).toEqual([
    ["/fixture/crabbox", "exec", "--id", LEASE_ID, "--", "/bin/sh", "-c", "printf first"],
    ["/fixture/crabbox", "exec", "--id", LEASE_ID, "--", "/bin/sh", "-c", "printf second"],
  ]);
  for (const command of remote.commands) {
    expect(command.cwd).toBe(temporaryRoot);
    expect(command.env.CRABBOX_TEST_PROVIDER_CREDENTIAL).toBe("synthetic-host-only");
    expect(command.argv.join(" ")).not.toContain("synthetic-host-only");
  }
  expect(runCommand.mock.calls.some(([argv]) => argv[1] === "ssh")).toBe(false);
});

it("keeps management routed by the stored claim and original workspace", async () => {
  let stops = 0;
  const { manager, runCommand } = setup((argv) =>
    argv[1] === "stop" && ++stops === 1 ? result("missing claim", 4) : respond(argv),
  );
  const entry = {
    containerName: LEASE_ID,
    backendId: "crabbox",
    runtimeLabel: LEASE_ID,
    sessionKey: "scope",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "daytona/small",
    workspaceDir: temporaryRoot,
    runtimeState: "removing-pending" as const,
  };
  await manager.removeRuntime({ entry, config: {} });
  expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual([
    "stop",
    "exec",
    "warmup",
    "inspect",
    "stop",
  ]);
  for (const [argv, options] of runCommand.mock.calls) {
    expect(options).toMatchObject({ cwd: temporaryRoot });
    if (argv[1] === "stop" || argv[1] === "inspect") {
      expect(argv).not.toContain("--provider");
    }
  }
  expect(
    runCommand.mock.calls.filter(([argv]) => argv[1] === "stop").map(([argv]) => argv),
  ).toEqual([
    ["/fixture/crabbox", "stop", "--current-repo", "--id", LEASE_ID],
    ["/fixture/crabbox", "stop", "--current-repo", "--id", LEASE_ID],
  ]);
  expect(await manager.describeRuntime({ entry, config: {} })).toMatchObject({
    running: true,
    configLabelMatch: true,
  });
});

it("resolves optional sandbox config independently from warm images", () => {
  expect(resolveCrabboxSandboxConfig({ warmImages: { keepPrevious: 1 } })).toBeUndefined();
  expect(resolveCrabboxSandboxConfig({ sandbox: {} })).toEqual({});
  expect(resolveCrabboxSandboxConfig({ sandbox: { provider: " daytona ", ttl: "90m" } })).toEqual({
    provider: "daytona",
    ttl: "90m",
  });
  for (const sandbox of [{ ttl: "soon" }, { provider: " " }, { region: "eu" }, "daytona"]) {
    expect(() => resolveCrabboxSandboxConfig({ sandbox })).toThrow();
  }
});
