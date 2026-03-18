import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACPX_BUNDLED_BIN,
  ACPX_PINNED_VERSION,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginRoot,
  resolveAcpxPluginConfig,
  toAcpMcpServers,
} from "./config.js";

describe("acpx plugin config parsing", () => {
  it("resolves source-layout plugin root from a file under src", () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-source-"));
    try {
      fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(pluginRoot, "src", "config.ts")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(pluginRoot);
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("resolves bundled-layout plugin root from the dist entry file", () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-dist-"));
    try {
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(pluginRoot, "index.js")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(pluginRoot);
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("prefers the workspace plugin root for dist/extensions/acpx bundles", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-workspace-"));
    const workspacePluginRoot = path.join(repoRoot, "extensions", "acpx");
    const bundledPluginRoot = path.join(repoRoot, "dist", "extensions", "acpx");
    try {
      fs.mkdirSync(workspacePluginRoot, { recursive: true });
      fs.mkdirSync(bundledPluginRoot, { recursive: true });
      fs.writeFileSync(path.join(workspacePluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(workspacePluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(bundledPluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(bundledPluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(bundledPluginRoot, "index.js")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(workspacePluginRoot);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

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
    expect(resolved.stripProviderAuthEnvVars).toBe(true);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
    expect(resolved.strictWindowsCmdWrapper).toBe(true);
  });

  it("does not strip provider auth env vars when agentCommand is set", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agentCommand: "npx --yes kilocode@latest",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(ACPX_BUNDLED_BIN);
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
    expect(resolved.agentCommand).toBe("npx --yes kilocode@latest");
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
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
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
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
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
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
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
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
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

  it("accepts mcp server maps", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        mcpServers: {
          canva: {
            command: "npx",
            args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
            env: {
              CANVA_TOKEN: "secret",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.mcpServers).toEqual({
      canva: {
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        env: {
          CANVA_TOKEN: "secret",
        },
      },
    });
  });

  it("rejects invalid mcp server definitions", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            canva: {
              command: "npx",
              args: ["-y", 1],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow(
      "mcpServers.canva must have a command string, optional args array, and optional env object",
    );
  });

  it("accepts agentCommand override", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agentCommand: "npx --yes kilocode@latest",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.agentCommand).toBe("npx --yes kilocode@latest");
  });

  it("trims agentCommand whitespace", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agentCommand: "  npx --yes kilocode@latest  ",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.agentCommand).toBe("npx --yes kilocode@latest");
  });

  it("resolves agentCommand as undefined when not set", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.agentCommand).toBeUndefined();
  });

  it("rejects empty agentCommand", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          agentCommand: "",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("agentCommand must be a non-empty string");
  });

  it("rejects whitespace-only agentCommand", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          agentCommand: "   ",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("agentCommand must be a non-empty string");
  });

  it("rejects non-string agentCommand", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          agentCommand: 42,
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("agentCommand must be a non-empty string");
  });

  it("schema accepts mcp server config", () => {
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
            CANVA_TOKEN: "secret",
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe("toAcpMcpServers", () => {
  it("converts plugin config maps into ACP stdio MCP entries", () => {
    expect(
      toAcpMcpServers({
        canva: {
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: {
            CANVA_TOKEN: "secret",
          },
        },
      }),
    ).toEqual([
      {
        name: "canva",
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        env: [
          {
            name: "CANVA_TOKEN",
            value: "secret",
          },
        ],
      },
    ]);
  });
});
