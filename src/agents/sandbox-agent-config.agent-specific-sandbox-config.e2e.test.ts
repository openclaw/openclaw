// Verifies agent-specific sandbox config, workspace roots, and Docker setup commands.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
    ...mounts.map((mount) => ({
      destination: mount.Destination,
      writable: mount.RW,
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
  const [command = "", ...args] = commandAndArgs;
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
    args[2] === "{{.State.Running}}";
  const code = command === "docker" && !shouldFailContainerInspect ? 0 : 1;
  let stdout = "";
  if (command === "docker" && args[0] === "inspect" && args[2] === "{{.Id}}") {
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
let resolveSandboxRuntimeStatus: typeof import("./sandbox/runtime-status.js").resolveSandboxRuntimeStatus;

async function resolveContext(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  // Convenience wrapper keeps session-key specific sandbox context assertions compact.
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
        args: ["inspect", "--format", "{{.Id}}", context.containerName],
      },
      {
        command: "docker",
        args: ["inspect", "--format", mountInspectFormat, containerId],
      },
      { command: "docker", args: ["exec", containerId, "cat", "/proc/self/mountinfo"] },
    ]);
    expect(context.fsBridge?.resolvePath({ filePath: "marker.txt" }).hostPath).toBe(
      path.join(context.workspaceDir, "marker.txt"),
    );
  }
  return context;
}

function expectDockerSetupCommand(command: string) {
  // Setup commands are executed through docker exec in the resolved container.
  const matched = spawnCalls.some(
    (call) =>
      call.command === "docker" &&
      call.args[0] === "exec" &&
      call.args.includes("-lc") &&
      call.args.includes(command),
  );
  expect(matched, `expected docker setup command; calls=${JSON.stringify(spawnCalls)}`).toBe(true);
}

function createDefaultsSandboxConfig(
  scope: "agent" | "shared" | "session" = "agent",
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope,
        },
      },
    },
  };
}

function createWorkSetupCommandConfig(scope: "agent" | "shared"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope,
          docker: {
            setupCommand: "echo global",
          },
        },
      },
      list: [
        {
          id: "work",
          workspace: "~/openclaw-work",
          sandbox: {
            mode: "all",
            scope,
            docker: {
              setupCommand: "echo work",
            },
          },
        },
      ],
    },
  };
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
    ({ resolveSandboxRuntimeStatus } = runtimeModule);
    spawnCalls.length = 0;
  });

  it("should use agent-specific workspaceRoot", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceRoot: "~/.openclaw/sandboxes",
          },
        },
        list: [
          {
            id: "isolated",
            workspace: "~/openclaw-isolated",
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceRoot: "/tmp/isolated-sandboxes",
            },
          },
        ],
      },
    };

    const context = await resolveContext(cfg, "agent:isolated:main", "/tmp/test-isolated");

    if (!context) {
      throw new Error("Expected sandbox context for isolated agent");
    }
    expect(context.workspaceDir).toContain(path.resolve("/tmp/isolated-sandboxes"));
  });

  it("should prefer agent config over global for multiple agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
            scope: "session",
          },
        },
        list: [
          {
            id: "main",
            workspace: "~/openclaw",
            sandbox: {
              mode: "off",
            },
          },
          {
            id: "family",
            workspace: "~/openclaw-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
          },
        ],
      },
    };

    const mainRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:telegram:group:789",
    });
    expect(mainRuntime.mode).toBe("off");
    expect(mainRuntime.sandboxed).toBe(false);

    const familyRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:family:whatsapp:group:123",
    });
    expect(familyRuntime.mode).toBe("all");
    expect(familyRuntime.sandboxed).toBe(true);
  });

  it("should prefer agent-specific sandbox tool policy", () => {
    const cfg = createRestrictedAgentSandboxConfig({
      agentTools: {
        sandbox: {
          tools: {
            allow: ["read", "write"],
            deny: ["edit"],
          },
        },
      },
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

  it("should use global sandbox config when no agent-specific config exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
          },
        },
        list: [
          {
            id: "main",
            workspace: "~/openclaw",
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.mode).toBe("all");
  });

  it.each([
    {
      scope: "agent" as const,
      expectedSetup: "echo work",
    },
    {
      scope: "shared" as const,
      expectedSetup: "echo global",
    },
  ])("should resolve $scope setupCommand overrides", async ({ scope, expectedSetup }) => {
    const cfg = createWorkSetupCommandConfig(scope);
    const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

    if (!context) {
      throw new Error(`Expected sandbox context for ${scope} scoped setup`);
    }
    expect(context.docker?.setupCommand).toBe(expectedSetup);
    expectDockerSetupCommand(expectedSetup);
  });

  it("should allow agent-specific docker settings beyond setupCommand", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            docker: {
              image: "global-image",
              network: "none",
            },
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              docker: {
                image: "work-image",
                network: "bridge",
              },
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.docker.image).toBe("work-image");
    expect(sandbox.docker.network).toBe("bridge");
  });

  it("should honor agent-specific sandbox mode overrides", () => {
    for (const scenario of [
      {
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                scope: "agent",
              },
            },
            list: [
              {
                id: "main",
                workspace: "~/openclaw",
                sandbox: {
                  mode: "off",
                },
              },
            ],
          },
        } satisfies OpenClawConfig,
        sessionKey: "agent:main:main",
        assert: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
          expect(runtime.mode).toBe("off");
          expect(runtime.sandboxed).toBe(false);
        },
      },
      {
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
              },
            },
            list: [
              {
                id: "family",
                workspace: "~/openclaw-family",
                sandbox: {
                  mode: "all",
                  scope: "agent",
                },
              },
            ],
          },
        } satisfies OpenClawConfig,
        sessionKey: "agent:family:whatsapp:group:123",
        assert: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
          expect(runtime.mode).toBe("all");
          expect(runtime.sandboxed).toBe(true);
        },
      },
    ]) {
      const runtime = resolveSandboxRuntimeStatus({
        cfg: scenario.cfg,
        sessionKey: scenario.sessionKey,
      });
      scenario.assert(runtime);
    }
  });

  it("should use agent-specific scope", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.scope).toBe("agent");
  });

  it("enforces required allowlist tools in default and explicit sandbox configs", () => {
    for (const scenario of [
      {
        cfg: createDefaultsSandboxConfig(),
        expected: ["session_status", "view_image"],
      },
      {
        cfg: {
          tools: {
            sandbox: {
              tools: {
                allow: ["bash", "read"],
                deny: [],
              },
            },
          },
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                scope: "agent",
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: ["view_image"],
      },
    ]) {
      const sandbox = resolveSandboxConfigForAgent(scenario.cfg, "main");
      for (const tool of scenario.expected) {
        expect(sandbox.tools.allow).toContain(tool);
      }
    }
  });
});
