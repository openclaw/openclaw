import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import { splitSandboxBindSpec } from "./sandbox/bind-spec.js";
import { sandboxMountOptionsReadOnly } from "./sandbox/workspace-mounts.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

type SpawnCall = {
  command: string;
  args: string[];
  containerId?: string;
};

const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);
const mountInspectFormat = '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}';

function inspectCreatedDockerMounts(containerName: string | undefined) {
  const create = spawnCalls.findLast(
    (call) =>
      call.command === "docker" &&
      call.args[0] === "create" &&
      (call.args[call.args.indexOf("--name") + 1] === containerName ||
        call.containerId === containerName),
  );
  if (!create?.containerId) {
    throw new Error(`No recorded Docker create for ${containerName}`);
  }
  const mounts: { Type: "bind"; Source: string; Destination: string; RW: boolean }[] = [];
  const tmpfs: Record<string, string> = {};
  for (let index = 0; index < create.args.length; index += 1) {
    const flag = create.args[index];
    const value = create.args[index + 1];
    if (flag === "-v") {
      const bind = value && splitSandboxBindSpec(value);
      if (!bind) {
        throw new Error(`Invalid recorded Docker bind: ${value}`);
      }
      mounts.push({
        Type: "bind",
        Source: bind.host,
        Destination: bind.container,
        RW: !sandboxMountOptionsReadOnly(bind.options),
      });
    } else if (flag === "--tmpfs" && value) {
      const separator = value.indexOf(":");
      tmpfs[separator < 0 ? value : value.slice(0, separator)] =
        separator < 0 ? "" : value.slice(separator + 1);
    }
  }
  const entries = [
    ...mounts.map(({ Destination: destination, RW: writable }) => ({
      destination,
      writable,
      type: "bind",
    })),
    ...Object.entries(tmpfs).map(([destination, options]) => ({
      destination,
      writable: !sandboxMountOptionsReadOnly(options),
      type: "tmpfs",
    })),
  ].map(({ destination, writable, type }, index) => ({
    destination,
    writable,
    type,
    id: index + 2,
  }));
  const escapePath = (value: string) =>
    value.replace(/[\\ \t\n]/g, (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`);
  const rootMode = create.args.includes("--read-only") ? "ro" : "rw";
  // Model this fixture's ordinary, unstacked mounts from the actual create
  // arguments so the real backend snapshot keeps the workspace visible.
  const mountinfo = [
    `1 1 0:1 / / ${rootMode} - overlay overlay ${rootMode}`,
    ...entries.map((entry) => {
      const parent = entries
        .filter((other) => entry.destination.startsWith(`${other.destination}/`))
        .toSorted((a, b) => b.destination.length - a.destination.length)[0];
      const mode = entry.writable ? "rw" : "ro";
      const backing = entry.type === "bind" ? `8:1 /bind-${entry.id}` : `0:${entry.id} /`;
      const filesystem = entry.type === "bind" ? "ext4 /dev/test rw" : `tmpfs tmpfs ${mode}`;
      return `${entry.id} ${parent?.id ?? 1} ${backing} ${escapePath(entry.destination)} ${mode} - ${filesystem}`;
    }),
  ].join("\n");
  return { containerId: create.containerId, mounts, tmpfs, mountinfo };
}

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...rawArgs] = commandAndArgs;
  // Local Docker contexts pin subsequent commands to the captured daemon.
  const args = rawArgs[0] === "--host" ? rawArgs.slice(2) : rawArgs;
  spawnCalls.push({
    command,
    args,
    ...(command === "docker" && args[0] === "create"
      ? { containerId: (spawnCalls.length + 1).toString(16).padStart(64, "0") }
      : {}),
  });
  const shouldFailContainerInspect =
    command === "docker" &&
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2] ===
      '{{.Id}}\n{{.State.Running}}\n{{.HostConfig.ReadonlyRootfs}}\n{{ index .Config.Labels "openclaw.configHash" }}';
  const code = command === "docker" && !shouldFailContainerInspect ? 0 : 1;
  let stdout = "";
  if (command === "docker" && args[0] === "context" && args[1] === "inspect") {
    stdout = JSON.stringify({ Host: "unix:///fixture-docker.sock", SkipTLSVerify: false });
  } else if (command === "docker" && args[0] === "info") {
    stdout = "fixture-daemon";
  } else if (command === "docker" && args[0] === "inspect" && args[2] === "{{json .State}}") {
    stdout = JSON.stringify({
      Running: true,
      Paused: false,
      Pid: 123,
      StartedAt: "2026-01-01T00:00:00.000Z",
    });
  } else if (command === "docker" && args[0] === "create") {
    stdout = inspectCreatedDockerMounts(args[args.indexOf("--name") + 1]).containerId;
  } else if (command === "docker" && args[0] === "inspect" && args[2] === "{{.Id}}") {
    stdout = inspectCreatedDockerMounts(args[3]).containerId;
  } else if (
    command === "docker" &&
    args[0] === "inspect" &&
    args[1] === "--format" &&
    args[2] === mountInspectFormat
  ) {
    const { mounts, tmpfs } = inspectCreatedDockerMounts(args[3]);
    stdout = JSON.stringify({ Mounts: mounts, Tmpfs: tmpfs });
  } else if (
    command === "docker" &&
    args[0] === "exec" &&
    args[2] === "cat" &&
    args[3] === "/proc/self/mountinfo"
  ) {
    stdout = inspectCreatedDockerMounts(args[1]).mountinfo;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(code === 0 ? "" : "No such container"),
  };
}

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

vi.mock("../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: vi.fn(async () => undefined),
}));

let resolveSandboxContext: typeof import("./sandbox/context.js").resolveSandboxContext;
let resolveSandboxConfigForAgent: typeof import("./sandbox/config.js").resolveSandboxConfigForAgent;
let resolvePreparedSandboxRuntimeStatus: typeof import("./sandbox/runtime-status.js").resolvePreparedSandboxRuntimeStatus;

async function resolveContext(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  const context = await resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir,
  });
  if (context) {
    const { containerId } = inspectCreatedDockerMounts(context.containerName);
    expect(
      spawnCalls.filter(
        (call) =>
          call.command === "docker" &&
          (call.args[2] === "{{.Id}}" ||
            call.args[2] === mountInspectFormat ||
            call.args[3] === "/proc/self/mountinfo"),
      ),
    ).toEqual([
      {
        command: "docker",
        args: ["inspect", "--format", mountInspectFormat, containerId],
      },
      { command: "docker", args: ["exec", containerId, "cat", "/proc/self/mountinfo"] },
    ]);
    expect(spawnCalls).toContainEqual({ command: "docker", args: ["start", containerId] });
    expect(context.fsBridge?.resolvePath({ filePath: "marker.txt" }).hostPath).toBe(
      path.join(context.workspaceDir, "marker.txt"),
    );
  }
  return expectDefined(context, "sandbox context");
}

function expectDockerSetupCommand(command: string) {
  expect(
    spawnCalls.filter((call) => call.command === "docker" && call.args[0] === "exec"),
  ).toContainEqual({ command: "docker", args: expect.arrayContaining(["-lc", command]) });
}

function sandboxConfig(
  sandbox: AgentSandboxConfig = {},
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { mode: "all", scope: "agent", ...sandbox } },
      entries,
    },
  };
}

function createWorkSetupCommandConfig(scope: "agent" | "shared"): OpenClawConfig {
  return sandboxConfig(
    { scope, docker: { setupCommand: "echo global" } },
    {
      work: {
        workspace: "~/openclaw-work",
        sandbox: { mode: "all", scope, docker: { setupCommand: "echo work" } },
      },
    },
  );
}

describe("Agent-specific sandbox config", () => {
  beforeEach(async () => {
    vi.resetModules();
    const [configModule, contextModule, runtimeModule] = await Promise.all([
      import("./sandbox/config.js"),
      import("./sandbox/context.js"),
      import("./sandbox/runtime-status.js"),
    ]);
    ({ resolveSandboxConfigForAgent } = configModule);
    ({ resolveSandboxContext } = contextModule);
    ({ resolvePreparedSandboxRuntimeStatus } = runtimeModule);
    spawnCalls.length = 0;
  });

  it("should use agent-specific workspaceRoot", async () => {
    const cfg = sandboxConfig(
      { workspaceRoot: "~/.openclaw/sandboxes" },
      {
        isolated: {
          workspace: "~/openclaw-isolated",
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceRoot: "/tmp/isolated-sandboxes",
          },
        },
      },
    );

    const context = await resolveContext(cfg, "agent:isolated:main", "/tmp/test-isolated");

    expect(context.workspaceDir).toContain(path.resolve("/tmp/isolated-sandboxes"));
  });

  it("should prefer agent-specific sandbox tool policy", () => {
    const cfg = createRestrictedAgentSandboxConfig({
      agentTools: { sandbox: { tools: { allow: ["read", "write"], deny: ["edit"] } } },
      globalSandboxTools: {
        allow: ["read"],
        deny: ["exec"],
      },
    });

    const sandbox = resolveSandboxConfigForAgent(cfg, "restricted");
    expect(sandbox.tools).toEqual({
      allow: ["read", "write", "view_image"],
      deny: ["edit"],
    });
  });

  it.each([
    { scope: "agent" as const, expectedSetup: "echo work" },
    { scope: "shared" as const, expectedSetup: "echo global" },
  ])("should resolve $scope setupCommand overrides", async ({ scope, expectedSetup }) => {
    const cfg = createWorkSetupCommandConfig(scope);
    const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

    expect(context.docker?.setupCommand).toBe(expectedSetup);
    expectDockerSetupCommand(expectedSetup);
  });

  it("should honor agent-specific sandbox mode overrides", () => {
    for (const [globalMode, mode, agentId, session, sandboxed] of [
      ["all", "off", "main", "main", false],
      ["off", "all", "family", "whatsapp:group:123", true],
    ] as const) {
      expect(
        resolvePreparedSandboxRuntimeStatus({
          cfg: sandboxConfig(
            { mode: globalMode },
            { [agentId]: { sandbox: { mode, scope: "agent" } } },
          ),
          sessionKey: `agent:${agentId}:${session}`,
          preparedSessionEntry: null,
        }),
      ).toMatchObject({ mode, sandboxed });
    }
  });

  it("enforces required allowlist tools in default and explicit sandbox configs", () => {
    expect(resolveSandboxConfigForAgent(sandboxConfig(), "main").tools.allow).toEqual(
      expect.arrayContaining(["session_status", "view_image"]),
    );
    const cfg = {
      ...sandboxConfig(),
      tools: { sandbox: { tools: { allow: ["bash", "read"], deny: [] } } },
    } satisfies OpenClawConfig;
    expect(resolveSandboxConfigForAgent(cfg, "main").tools.allow).toContain("view_image");
  });
});
