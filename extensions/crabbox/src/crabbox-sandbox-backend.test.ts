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
import { CRABBOX_MIN_VERSION, resolveManagedCrabboxBinaryPath } from "./crabbox-managed-binary.js";
import {
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
} from "./crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";

const commands = vi.hoisted(() => [] as RemoteShellCommandSpec[]);
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: vi.fn(),
}));
// mock-isolation: Exercise command construction with synthetic sessions, not a live sandbox backend.
vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  createRemoteShellSandboxBackend: async (
    _params: CreateReservedSandboxBackendParamsV1,
    options: RemoteShellSandboxBackendOptions,
  ) => ({
    runShellCommand: async (command: SandboxBackendCommandParams) => {
      const session = await options.createSession();
      return session.runCommand({ remoteCommand: command.script, stdin: command.stdin });
    },
  }),
  createRemoteShellSandboxSession: (options: RemoteShellSessionOptions) => ({
    runCommand: async (command: { remoteCommand: string; tty?: boolean }) => {
      options.assertCurrent?.();
      commands.push(options.buildCommand(command));
      return { stdout: Buffer.from("remote-ok"), stderr: Buffer.alloc(0), code: 0 };
    },
  }),
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
const entry = {
  containerName: LEASE_ID,
  backendId: "crabbox",
  sessionKey: "scope",
  createdAtMs: 1,
  lastUsedAtMs: 1,
  image: "daytona/small",
  workspaceDir: temporaryRoot,
};
function respond(argv: string[]): SpawnResult {
  if (argv[1] === "exec" && argv.includes("--check")) {
    return result(JSON.stringify({ execution: true, currentRepoStop: true }));
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
    .mockImplementation(async (argv) =>
      argv[1] === "--version" ? result(CRABBOX_MIN_VERSION) : await handler(argv),
    );
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
function failedWarmup(inspection: SpawnResult) {
  return setup((argv) =>
    argv[1] === "warmup"
      ? result("fixture-credential@ssh.example.test", 4)
      : argv[1] === "inspect"
        ? inspection
        : respond(argv),
  );
}
beforeEach(() => {
  vi.mocked(runCommandWithTimeout).mockReset();
  commands.length = 0;
});

describe("Crabbox sandbox provider lifecycle", () => {
  it("rejects providers without scoped cleanup before allocating a lease", async () => {
    const { factory, runCommand } = setup(() =>
      result(JSON.stringify({ execution: true, currentRepoStop: false })),
    );
    await expect(factory(params())).rejects.toThrow("repository-scoped cleanup");
    expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["--version", "exec"]);
  });

  it("uses a supported managed binary for an outdated sandbox executable", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(temporaryRoot, "managed-state"));
    const binary = resolveManagedCrabboxBinaryPath();
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, CRABBOX_MIN_VERSION);
    const { factory, runCommand } = setup();
    runCommand.mockImplementation(async (argv) =>
      argv[1] === "--version"
        ? result(argv[0] === "/fixture/crabbox" ? "0.76.0" : CRABBOX_MIN_VERSION)
        : respond(argv),
    );
    const handle = await factory(params());
    await handle.runShellCommand({ script: "printf upgraded" });
    expect(
      runCommand.mock.calls.filter(([argv]) => argv[1] !== "--version").map(([argv]) => argv[0]),
    ).toEqual([binary, binary, binary]);
    expect(commands[0]?.argv[0]).toBe(binary);
  });

  it.each([
    ["matching released lease", inspect("released"), /is retired/],
    ["foreign released lease", inspect("released", "cbx_aaaaaaaaaaaa"), /warmup failed/],
    [
      "failed inspection",
      { ...inspect("released"), code: 1 },
      /Crabbox sandbox warmup failed: exit 4/,
    ],
  ] as const)("handles warmup failure with %s", async (_label, inspection, error) => {
    const { factory } = failedWarmup(inspection);
    await expect(factory(params())).rejects.toThrow(error);
  });

  it("validates runtime authority and unsupported binds before allocation", async () => {
    const { factory, runCommand } = setup();
    await expect(factory(params({ runtimeId: "" }))).rejects.toThrow("fixed lease");
    const assertRuntimeCurrent = () => {
      throw new Error("removed");
    };
    await expect(factory(params({ assertRuntimeCurrent }))).rejects.toThrow("removed");
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
  expect(commands).toMatchObject(
    ["first", "second"].map((name) => ({
      argv: ["/fixture/crabbox", "exec", "--id", LEASE_ID, "--", "/bin/sh", "-c", `printf ${name}`],
      cwd: temporaryRoot,
      env: expect.objectContaining({ CRABBOX_TEST_PROVIDER_CREDENTIAL: "synthetic-host-only" }),
    })),
  );
  expect(runCommand.mock.calls.some(([argv]) => argv[1] === "ssh")).toBe(false);
});

it("keeps management routed by the stored claim and original workspace", async () => {
  let stops = 0;
  const { manager, runCommand } = setup((argv) =>
    argv[1] === "stop" && ++stops === 1 ? result("missing claim", 4) : respond(argv),
  );
  const removing = {
    ...entry,
    runtimeLabel: LEASE_ID,
    runtimeState: "removing-pending" as const,
  };
  await manager.removeRuntime({ entry: removing, config: {} });
  const actions = ["--version", "stop", "exec", "warmup", "inspect", "stop"];
  expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(actions);
  for (const [argv, options] of runCommand.mock.calls) {
    expect(options).toMatchObject({ cwd: temporaryRoot });
    if (argv[1] === "stop" || argv[1] === "inspect") {
      expect(argv).not.toContain("--provider");
    }
  }
  const stop = ["/fixture/crabbox", "stop", "--current-repo", "--id", LEASE_ID];
  expect(
    runCommand.mock.calls.filter(([argv]) => argv[1] === "stop").map(([argv]) => argv),
  ).toEqual([stop, stop]);
  expect(await manager.describeRuntime({ entry: removing, config: {} })).toMatchObject({
    running: true,
    configLabelMatch: true,
  });
});

it.each([
  ["unavailable provider", () => result("provider unavailable", 1), "provider unavailable"],
  ["invalid JSON", () => result("not-json"), "returned invalid JSON"],
  ["foreign lease", () => inspect("started", "cbx_aaaaaaaaaaaa"), "requested lease"],
  [
    "failed process",
    () => {
      throw new Error("process unavailable");
    },
    "process unavailable",
  ],
] as const)("surfaces %s instead of reporting a stopped runtime", async (_label, probe, error) => {
  const { manager } = setup(probe);
  await expect(manager.describeRuntime({ entry, config: {} })).rejects.toThrow(error);
});

it.each([
  [
    "missing exact-ID lease",
    () => result(`daytona claim ${LEASE_ID} is bound to missing sandbox sandbox-fixture`, 4),
    false,
  ],
  ["released lease", () => inspect("released"), true],
] as const)("reports an observed %s as stopped", async (_label, probe, configLabelMatch) => {
  const { manager } = setup(probe);
  await expect(manager.describeRuntime({ entry, config: {} })).resolves.toEqual({
    running: false,
    actualConfigLabel: "daytona/small",
    configLabelMatch,
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
