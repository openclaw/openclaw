import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACPX_BUNDLED_BIN,
  ACPX_PINNED_VERSION,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginConfig,
  toAcpMcpServers,
  type McpServerConfig,
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
    expect(resolved.stripProviderAuthEnvVars).toBe(true);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
    expect(resolved.strictWindowsCmdWrapper).toBe(true);
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
});

describe("McpServerConfig SecretInput env values", () => {
  describe("config parsing", () => {
    it("accepts SecretRef env values", () => {
      const schema = createAcpxPluginConfigSchema();
      if (!schema.safeParse) {
        throw new Error("acpx config schema missing safeParse");
      }
      const result = schema.safeParse({
        mcpServers: {
          "test-server": {
            command: "/usr/bin/test",
            env: {
              API_KEY: {
                source: "env",
                provider: "default",
                id: "MCP_API_KEY",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts mixed plain string and SecretRef env values", () => {
      const schema = createAcpxPluginConfigSchema();
      if (!schema.safeParse) {
        throw new Error("acpx config schema missing safeParse");
      }
      const result = schema.safeParse({
        mcpServers: {
          "test-server": {
            command: "/usr/bin/test",
            env: {
              PLAIN_VAR: "hello",
              SECRET_VAR: {
                source: "env",
                provider: "default",
                id: "MY_SECRET",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects SecretRef env values with extra keys", () => {
      const schema = createAcpxPluginConfigSchema();
      if (!schema.safeParse) {
        throw new Error("acpx config schema missing safeParse");
      }
      const result = schema.safeParse({
        mcpServers: {
          "test-server": {
            command: "/usr/bin/test",
            env: {
              API_KEY: {
                source: "env",
                provider: "default",
                id: "MCP_API_KEY",
                extra: "not-allowed",
              },
            },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string non-SecretRef env values", () => {
      const schema = createAcpxPluginConfigSchema();
      if (!schema.safeParse) {
        throw new Error("acpx config schema missing safeParse");
      }
      const result = schema.safeParse({
        mcpServers: {
          "test-server": {
            command: "/usr/bin/test",
            env: { BAD: 42 },
          },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("resolveAcpxPluginConfig", () => {
    it("preserves SecretRef values in resolved config", () => {
      const secretRef = {
        source: "env" as const,
        provider: "default",
        id: "MY_SECRET",
      };
      const resolved = resolveAcpxPluginConfig({
        rawConfig: {
          mcpServers: {
            "test-server": {
              command: "/usr/bin/test",
              env: { API_KEY: secretRef },
            },
          },
        },
      });
      expect(resolved.mcpServers["test-server"].env).toEqual({
        API_KEY: secretRef,
      });
    });
  });

  describe("toAcpMcpServers", () => {
    it("resolves plain string env values", () => {
      const mcpServers: Record<string, McpServerConfig> = {
        "test-server": {
          command: "/usr/bin/test",
          args: ["--flag"],
          env: {
            API_KEY: "sk-test-123",
            OTHER: "value",
          },
        },
      };
      const result = toAcpMcpServers(mcpServers);
      expect(result).toEqual([
        {
          name: "test-server",
          command: "/usr/bin/test",
          args: ["--flag"],
          env: [
            { name: "API_KEY", value: "sk-test-123" },
            { name: "OTHER", value: "value" },
          ],
        },
      ]);
    });

    it("throws on unresolved SecretRef", () => {
      const mcpServers: Record<string, McpServerConfig> = {
        "test-server": {
          command: "/usr/bin/test",
          env: {
            API_KEY: {
              source: "env",
              provider: "default",
              id: "MCP_API_KEY",
            },
          },
        },
      };
      expect(() => toAcpMcpServers(mcpServers)).toThrow(/unresolved SecretRef/);
    });

    it("handles servers with no env", () => {
      const mcpServers: Record<string, McpServerConfig> = {
        "test-server": { command: "/usr/bin/test" },
      };
      const result = toAcpMcpServers(mcpServers);
      expect(result).toEqual([
        {
          name: "test-server",
          command: "/usr/bin/test",
          args: [],
          env: [],
        },
      ]);
    });

    it("preserves empty-string env values", () => {
      const mcpServers: Record<string, McpServerConfig> = {
        "test-server": {
          command: "/usr/bin/test",
          env: {
            EMPTY: "",
            NONEMPTY: "value",
          },
        },
      };
      const result = toAcpMcpServers(mcpServers);
      expect(result[0].env).toEqual([
        { name: "EMPTY", value: "" },
        { name: "NONEMPTY", value: "value" },
      ]);
    });

    it("handles empty env object", () => {
      const mcpServers: Record<string, McpServerConfig> = {
        "test-server": { command: "/usr/bin/test", env: {} },
      };
      const result = toAcpMcpServers(mcpServers);
      expect(result[0].env).toEqual([]);
    });
  });
});
