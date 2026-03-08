import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACPX_BUNDLED_BIN,
  ACPX_PINNED_VERSION,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginConfig,
} from "./config.js";

describe("acpx plugin config parsing", () => {
  it("resolves bundled acpx with pinned version by default", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        cwd: "/tmp/workspace",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(ACPX_BUNDLED_BIN);
    expect(resolved.expectedVersion).toBe(ACPX_PINNED_VERSION);
    expect(resolved.allowPluginLocalInstall).toBe(true);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
    expect(resolved.strictWindowsCmdWrapper).toBe(true);
    expect(resolved.mcpServers).toEqual({});
  });

  it("accepts command override and disables plugin-local auto-install", () => {
    const command = "/home/user/repos/acpx/dist/cli.js";
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command,
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(path.resolve(command));
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
  });

  it("resolves relative command paths against workspace directory", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "../acpx/dist/cli.js",
      },
      workspaceDir: "/home/user/repos/openclaw",
    });

    expect(resolved.command).toBe(path.resolve("/home/user/repos/openclaw", "../acpx/dist/cli.js"));
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
  });

  it("keeps bare command names as-is", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "acpx",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe("acpx");
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
  });

  it("accepts exact expectedVersion override", () => {
    const command = "/home/user/repos/acpx/dist/cli.js";
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command,
        expectedVersion: "0.1.99",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(path.resolve(command));
    expect(resolved.expectedVersion).toBe("0.1.99");
    expect(resolved.allowPluginLocalInstall).toBe(false);
  });

  it("treats expectedVersion=any as no version constraint", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "/home/user/repos/acpx/dist/cli.js",
        expectedVersion: "any",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.expectedVersion).toBeUndefined();
  });

  it("rejects commandArgs overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          commandArgs: ["--foo"],
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: commandArgs");
  });

  it("schema rejects empty cwd", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({ cwd: "   " });

    expect(parsed.success).toBe(false);
  });

  it("accepts strictWindowsCmdWrapper override", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        strictWindowsCmdWrapper: true,
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.strictWindowsCmdWrapper).toBe(true);
  });

  it("rejects non-boolean strictWindowsCmdWrapper", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          strictWindowsCmdWrapper: "yes",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("strictWindowsCmdWrapper must be a boolean");
  });
});

describe("acpx plugin mcpServers config parsing", () => {
  it("accepts mcpServers with command-only configuration", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpServers: {
          canva: {
            command: "npx",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpServers).toEqual({
      canva: {
        command: "npx",
      },
    });
  });

  it("accepts mcpServers with command and args", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpServers: {
          canva: {
            command: "npx",
            args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          },
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpServers).toEqual({
      canva: {
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
      },
    });
  });

  it("accepts mcpServers with command, args, and env", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpServers: {
          canva: {
            command: "npx",
            args: ["-y", "mcp-remote@latest"],
            env: {
              API_KEY: "secret123",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpServers).toEqual({
      canva: {
        command: "npx",
        args: ["-y", "mcp-remote@latest"],
        env: {
          API_KEY: "secret123",
        },
      },
    });
  });

  it("accepts multiple mcpServers", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpServers: {
          canva: {
            command: "npx",
            args: ["mcp-remote@latest", "https://mcp.canva.com/mcp"],
          },
          github: {
            command: "npx",
            args: ["-y", "@github/mcp-server"],
            env: {
              GITHUB_TOKEN: "token123",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(Object.keys(resolved.mcpServers)).toHaveLength(2);
    expect(resolved.mcpServers.canva).toBeDefined();
    expect(resolved.mcpServers.github).toBeDefined();
  });

  it("rejects mcpServers with missing command", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              args: ["-y"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("rejects mcpServers with non-string command", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: 123,
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("rejects mcpServers with non-array args", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: "npx",
              args: "-y",
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("rejects mcpServers with non-string args items", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: "npx",
              args: ["-y", 123],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("rejects mcpServers with non-object env", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: "npx",
              env: "API_KEY=secret",
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("rejects mcpServers with non-string env values", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: "npx",
              env: {
                API_KEY: 123,
              },
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("mcpServers.canva must have a command string, optional args array, and optional env object");
  });

  it("schema accepts valid mcpServers config", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({
      mcpServers: {
        canva: {
          command: "npx",
          args: ["-y", "mcp-remote@latest"],
          env: {
            API_KEY: "secret",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("schema rejects mcpServers with invalid structure", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({
      mcpServers: "invalid",
    });

    expect(parsed.success).toBe(false);
  });
});
