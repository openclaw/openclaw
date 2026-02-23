import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as {
        stdout?: Readable;
        stderr?: Readable;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => boolean;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });

      const dockerArgs = command === "docker" ? args : [];
      const shouldFailContainerInspect =
        dockerArgs[0] === "inspect" &&
        dockerArgs[1] === "-f" &&
        dockerArgs[2] === "{{.State.Running}}";
      const shouldSucceedImageInspect = dockerArgs[0] === "image" && dockerArgs[1] === "inspect";

      queueMicrotask(() =>
        child.emit("close", shouldFailContainerInspect && !shouldSucceedImageInspect ? 1 : 0),
      );
      return child;
    },
  };
});

vi.mock("./skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skills.js")>();
  return {
    ...actual,
    syncSkillsToWorkspace: vi.fn(async () => undefined),
  };
});

let resolveSandboxContext: typeof import("./sandbox.js").resolveSandboxContext;
let resolveSandboxConfigForAgent: typeof import("./sandbox.js").resolveSandboxConfigForAgent;

async function resolveContext(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  return resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir,
  });
}

function expectDockerSetupCommand(command: string) {
  expect(
    spawnCalls.some(
      (call) =>
        call.command === "docker" &&
        call.args[0] === "exec" &&
        call.args.includes("-lc") &&
        call.args.includes(command),
    ),
  ).toBe(true);
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
  beforeAll(async () => {
    ({ resolveSandboxConfigForAgent, resolveSandboxContext } = await import("./sandbox.js"));
  });

  beforeEach(() => {
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

    expect(context).toBeDefined();
    expect(context?.workspaceDir).toContain(path.resolve("/tmp/isolated-sandboxes"));
  });

  it("should prefer agent config over global for multiple agents", async () => {
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

    const mainContext = await resolveContext(
      cfg,
      "agent:main:telegram:group:789",
      "/tmp/test-main",
    );
    expect(mainContext).toBeNull();

    const familyContext = await resolveContext(
      cfg,
      "agent:family:whatsapp:group:123",
      "/tmp/test-family",
    );
    expect(familyContext).toBeDefined();
    expect(familyContext?.enabled).toBe(true);
  });

  it("should prefer agent-specific sandbox tool policy", async () => {
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

    const context = await resolveContext(cfg, "agent:restricted:main", "/tmp/test-restricted");

    expect(context).toBeDefined();
    expect(context?.tools).toEqual({
      allow: ["read", "write", "image"],
      deny: ["edit"],
    });
  });

  it("should use global sandbox config when no agent-specific config exists", async () => {
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

    const context = await resolveContext(cfg, "agent:main:main", "/tmp/test");

    expect(context).toBeDefined();
    expect(context?.enabled).toBe(true);
  });

  it("should allow agent-specific docker setupCommand overrides", async () => {
    const cfg = createWorkSetupCommandConfig("agent");

    const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

    expect(context).toBeDefined();
    expect(context?.docker.setupCommand).toBe("echo work");
    expectDockerSetupCommand("echo work");
  });

  it("should ignore agent-specific docker overrides when scope is shared", async () => {
    const cfg = createWorkSetupCommandConfig("shared");

    const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

    expect(context).toBeDefined();
    expect(context?.docker.setupCommand).toBe("echo global");
    expect(context?.containerName).toContain("shared");
    expectDockerSetupCommand("echo global");
  });

  it("should allow agent-specific docker settings beyond setupCommand", async () => {
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

    const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

    expect(context).toBeDefined();
    expect(context?.docker.image).toBe("work-image");
    expect(context?.docker.network).toBe("bridge");
  });

  it("should override with agent-specific sandbox mode 'off'", async () => {
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
            sandbox: {
              mode: "off",
            },
          },
        ],
      },
    };

    const context = await resolveContext(cfg, "agent:main:main", "/tmp/test");

    expect(context).toBeNull();
  });

  it("should use agent-specific sandbox mode 'all'", async () => {
    const cfg: OpenClawConfig = {
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
    };

    const context = await resolveContext(
      cfg,
      "agent:family:whatsapp:group:123",
      "/tmp/test-family",
    );

    expect(context).toBeDefined();
    expect(context?.enabled).toBe(true);
  });

  it("should use agent-specific scope", async () => {
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

    const context = await resolveContext(cfg, "agent:work:slack:channel:456", "/tmp/test-work");

    expect(context).toBeDefined();
    expect(context?.containerName).toContain("agent-work");
  });

  it("includes session_status in default sandbox allowlist", async () => {
    const cfg = createDefaultsSandboxConfig();

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("session_status");
  });

  it("includes image in default sandbox allowlist", async () => {
    const cfg = createDefaultsSandboxConfig();

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("image");
  });

  it("injects image into explicit sandbox allowlists", async () => {
    const cfg: OpenClawConfig = {
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
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("image");
  });
});
