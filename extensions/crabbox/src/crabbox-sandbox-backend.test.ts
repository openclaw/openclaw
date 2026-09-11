import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type {
  CreateSandboxBackendParams,
  CreateReservedSandboxBackendParamsV1,
  SandboxBackendHandle,
  SshSandboxSettings,
} from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
} from "./crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";
import { parseCrabboxSshCommand } from "./crabbox-sandbox-ssh-command.js";

const ssh = vi.hoisted(() => ({
  create: vi.fn(),
  targets: [] as string[],
}));
vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  createSshSandboxBackend: ssh.create,
  requireSandboxBackendFactory: () => ssh.create,
  createRemoteShellSandboxFsBridge: vi.fn(),
  getSandboxBackendWorkdirResolver: vi.fn(),
  SandboxRuntimeRetiredError: class extends Error {
    constructor(readonly runtimeId: string) {
      super(`Sandbox runtime ${runtimeId} is retired`);
    }
  },
}));

type Runner = NonNullable<Parameters<typeof createCrabboxSandboxBackendFactory>[0]["runCommand"]>;
const LEASE_ID = "cbx_0123456789ab";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crabbox-test-"));
const KNOWN_HOSTS = path.join(temporaryRoot, "known_hosts");
afterAll(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));

function result(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}
function inspect(state = "started", id = LEASE_ID): SpawnResult {
  return result(JSON.stringify({ id, state, ready: state === "started" }));
}
function endpoint(user = "fixture-token"): string {
  return `'ssh' '-p' '2222' '-o' 'UserKnownHostsFile=${KNOWN_HOSTS}' '${user}@ssh.example.test'\n`;
}
function respond(argv: string[]): SpawnResult {
  if (argv[0] === "ssh-keygen") {
    return result("# Host found\n[ssh.example.test]:2222 ssh-ed25519 AAAA\n");
  }
  if (argv[0] === "ssh-keyscan") {
    return result("ssh.example.test ssh-ed25519 AAAAFIXTURE\n");
  }
  if (argv[1] === "inspect") {
    return inspect();
  }
  return result(argv[1] === "ssh" ? endpoint() : "");
}
function params(
  overrides: Partial<CreateSandboxBackendParams> = {},
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
  const runCommand = vi.fn<Runner>(async (argv) => await handler(argv));
  const dependencies = {
    openclawRoot: temporaryRoot,
    pluginConfig: {
      binary: "/fixture/crabbox",
      provider: "daytona",
      class: "small",
      ttl: "2h",
      idleTimeout: "30m",
    },
    runCommand,
  };
  return {
    runCommand,
    factory: createCrabboxSandboxBackendFactory(dependencies),
    manager: createCrabboxSandboxBackendManager(dependencies),
  };
}
beforeEach(() => {
  ssh.targets.length = 0;
  ssh.create.mockReset();
  ssh.create.mockImplementation(
    async (
      _params: CreateSandboxBackendParams,
      options?: { resolveSettings: () => Promise<SshSandboxSettings> },
    ) => {
      const runShellCommand: SandboxBackendHandle["runShellCommand"] = async () => {
        if (options) {
          const settings = await options.resolveSettings();
          ssh.targets.push(settings.target);
        }
        return { stdout: Buffer.from("remote-ok"), stderr: Buffer.alloc(0), code: 0 };
      };
      return {
        id: "ssh",
        runtimeId: "ssh-fixture",
        runtimeLabel: "ssh-fixture",
        workdir: "/remote/workspace",
        remoteWorkspaceDir: "/remote/workspace",
        remoteAgentWorkspaceDir: "/remote/agent",
        runShellCommand,
        runRemoteShellScript: runShellCommand,
        buildExecSpec: vi.fn(),
      };
    },
  );
});

describe("Crabbox sandbox provider lifecycle", () => {
  it("uses the durable reservation and replays warmup with the owning workspace", async () => {
    const { factory, runCommand } = setup();
    const handle = await factory(params());
    expect(handle.runtimeId).toBe(LEASE_ID);
    expect(handle.configLabel).toBe("daytona/small");
    expect(runCommand.mock.calls[0]).toEqual([
      [
        "/fixture/crabbox",
        "warmup",
        "--provider",
        "daytona",
        "--class",
        "small",
        "--lease-id",
        LEASE_ID,
        "--slug",
        "openclaw-sandbox",
        "--keep",
        "--ttl",
        "2h",
        "--idle-timeout",
        "30m",
      ],
      expect.objectContaining({ cwd: temporaryRoot, killProcessTree: true }),
    ]);
  });

  it("resumes a non-ready registered workspace by replaying the same ID", async () => {
    let resumed = false;
    const { factory, runCommand } = setup((argv) => {
      if (argv[1] === "warmup") {
        resumed = true;
      }
      return argv[1] === "inspect"
        ? inspect(resumed ? "started" : "stopped", argv[argv.indexOf("--id") + 1])
        : respond(argv);
    });
    expect((await factory(params({ registeredRuntimeIds: [LEASE_ID] }))).runtimeId).toBe(LEASE_ID);
    expect(
      runCommand.mock.calls
        .filter(([argv]) => argv[1] === "warmup")
        .map(([argv]) => argv[argv.indexOf("--lease-id") + 1]),
    ).toEqual([LEASE_ID]);
  });

  it("retains the reserved ID after post-create inspection fails", async () => {
    let unavailable = true;
    const { factory, runCommand } = setup((argv) =>
      argv[1] === "inspect" && unavailable ? result("provider unavailable", 1) : respond(argv),
    );
    await expect(factory(params())).rejects.toThrow(/inspect failed/);
    unavailable = false;
    expect((await factory(params())).runtimeId).toBe(LEASE_ID);
    expect(
      runCommand.mock.calls
        .filter(([argv]) => argv[1] === "warmup")
        .map(([argv]) => argv[argv.indexOf("--lease-id") + 1]),
    ).toEqual([LEASE_ID, LEASE_ID]);
    expect(runCommand.mock.calls.some(([argv]) => argv[1] === "stop")).toBe(false);
  });

  it("reports only a matching released inspection as retired", async () => {
    for (const state of ["released", "stopped", "unknown"]) {
      const { factory } = setup((argv) =>
        argv[1] === "warmup"
          ? result(endpoint("fixture-warmup-credential"), 4)
          : argv[1] === "inspect"
            ? inspect(state)
            : respond(argv),
      );
      await expect(factory(params())).rejects.toThrow(
        state === "released" ? /is retired/ : "Crabbox sandbox warmup failed: exit 4",
      );
    }
    const { factory } = setup((argv) =>
      argv[1] === "warmup" ? result("unresolved", 4) : inspect("released", "cbx_aaaaaaaaaaaa"),
    );
    await expect(factory(params())).rejects.toThrow(/warmup failed/);
  });

  it("validates the lease ID and current authority before provisioning or returning a handle", async () => {
    const { factory, runCommand } = setup();
    await expect(factory(params({ runtimeId: "" }))).rejects.toThrow(/fixed lease/);
    expect(runCommand).not.toHaveBeenCalled();
    const assertRuntimeCurrent = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("runtime removed");
      });
    await expect(factory(params({ assertRuntimeCurrent }))).rejects.toThrow("runtime removed");
    expect(ssh.create).not.toHaveBeenCalled();
  });

  it("rejects Docker binds before provisioning", async () => {
    const { factory, runCommand } = setup();
    const input = params();
    input.cfg.docker.binds = ["/host:/remote"];
    await expect(factory(input)).rejects.toThrow(/docker.binds/);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("Crabbox sandbox SSH access", () => {
  it("gets fresh access through Crabbox for consecutive operations on one SSH handle", async () => {
    let sequence = 0;
    const { factory } = setup((argv) =>
      argv[1] === "ssh" ? result(endpoint(`fixture-${++sequence}`)) : respond(argv),
    );
    const handle = await factory(params());
    await expect(handle.runShellCommand({ script: "true" })).resolves.toMatchObject({ code: 0 });
    await expect(handle.runShellCommand({ script: "true" })).resolves.toMatchObject({ code: 0 });
    expect(ssh.targets).toEqual([
      "fixture-1@ssh.example.test:2222",
      "fixture-2@ssh.example.test:2222",
    ]);
    expect(ssh.create).toHaveBeenCalledTimes(1);
    expect(ssh.create.mock.calls[0]?.[1]).toHaveProperty("resolveSettings");
  });

  it("does not use an old endpoint when fresh access is refused", async () => {
    let refused = false;
    const { factory } = setup((argv) =>
      argv[1] === "ssh" && refused
        ? result("fixture-credential-must-not-escape", 4)
        : respond(argv),
    );
    const handle = await factory(params());
    await handle.runShellCommand({ script: "true" });
    refused = true;
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow(
      "Crabbox sandbox ssh failed: exit 4",
    );
    expect(ssh.targets).toHaveLength(1);
  });

  it("checks runtime ownership again after SSH access resolves", async () => {
    let active = true;
    const { factory } = setup((argv) => {
      if (argv[1] === "ssh") {
        active = false;
      }
      return respond(argv);
    });
    const handle = await factory(
      params({
        assertRuntimeCurrent: () => {
          if (!active) {
            throw new Error("runtime removed");
          }
        },
      }),
    );
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow("runtime removed");
    expect(ssh.targets).toHaveLength(0);
  });

  it("records a new host key once and requires a lease-owned known_hosts file", async () => {
    let known = false;
    const { factory, runCommand } = setup((argv) => {
      if (argv[0] === "ssh-keygen" && !known) {
        return result("", 1);
      }
      if (argv[0] === "ssh-keyscan") {
        known = true;
      }
      return respond(argv);
    });
    const handle = await factory(params());
    await handle.runShellCommand({ script: "true" });
    await handle.runShellCommand({ script: "true" });
    expect(runCommand.mock.calls.filter(([argv]) => argv[0] === "ssh-keyscan")).toHaveLength(1);
    expect(await fs.readFile(KNOWN_HOSTS, "utf8")).toContain("[ssh.example.test]:2222 ssh-ed25519");
    const noKnownHosts = setup((argv) =>
      argv[1] === "ssh" ? result("ssh user@ssh.example.test") : respond(argv),
    );
    const insecure = await noKnownHosts.factory(params());
    await expect(insecure.runShellCommand({ script: "true" })).rejects.toThrow(/known_hosts/);
  });
});

it("describes and removes the lease through Crabbox", async () => {
  const { manager, runCommand } = setup();
  const entry = {
    containerName: LEASE_ID,
    backendId: "crabbox",
    sessionKey: "scope",
    createdAtMs: 0,
    lastUsedAtMs: 0,
    image: "daytona/small",
  };
  await expect(manager.describeRuntime({ entry, config: {} })).resolves.toMatchObject({
    running: true,
    configLabelMatch: true,
  });
  await manager.removeRuntime({ entry, config: {} });
  expect(runCommand.mock.calls.at(-1)?.[0]).toEqual(["/fixture/crabbox", "stop", LEASE_ID]);
});

it("recovers an unpublished reservation through the original workspace before release", async () => {
  let claimed = false;
  const { manager, runCommand } = setup((argv) => {
    if (argv[1] === "stop" && !claimed) {
      return result("no local claim", 4);
    }
    if (argv[1] === "warmup") {
      claimed = true;
    }
    return respond(argv);
  });
  await manager.removeRuntime({
    entry: {
      containerName: LEASE_ID,
      backendId: "crabbox",
      sessionKey: "scope",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      image: "unused",
      runtimeState: "removing-pending",
      workspaceDir: temporaryRoot,
    },
    config: {},
  });
  expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual([
    "stop",
    "warmup",
    "inspect",
    "stop",
  ]);
  expect(runCommand.mock.calls.every(([, options]) => options.cwd === temporaryRoot)).toBe(true);
  expect(runCommand.mock.calls[1]?.[0]).toContain(LEASE_ID);
});

it("parses quoted SSH endpoints and rejects unusable commands", () => {
  expect(
    parseCrabboxSshCommand(
      "'ssh' '-i' '/tmp/key file' '-p' '2200' '-o' 'UserKnownHostsFile=/tmp/known hosts' 'user@[fe80::1]'",
    ),
  ).toEqual({
    target: "user@[fe80::1]:2200",
    identityFile: "/tmp/key file",
    knownHostsFile: "/tmp/known hosts",
  });
  for (const command of [
    "ssh -p 70000 user@host",
    "ssh -F cfg host",
    "ssh hostonly",
    "ssh 'unterminated",
  ]) {
    expect(() => parseCrabboxSshCommand(command)).toThrow();
  }
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
