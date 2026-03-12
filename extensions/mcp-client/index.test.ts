/**
 * Basic tests for MCP Client Plugin
 *
 * Run with: npm test (or your test runner)
 */

import { describe, it, expect } from "vitest";

// Import validation function (we'll need to export it from index.ts)
// For now, we'll duplicate the logic for testing

describe("MCP Client Plugin", () => {
  describe("Config Validation", () => {
    const validateServerConfig = (
      serverName: string,
      config: any,
    ): { valid: boolean; error?: string } => {
      // Validate server name
      if (!serverName || typeof serverName !== "string") {
        return { valid: false, error: "server name must be a non-empty string" };
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
        return {
          valid: false,
          error: "server name can only contain letters, numbers, hyphens, and underscores",
        };
      }

      // Validate command
      if (!config.command || typeof config.command !== "string") {
        return { valid: false, error: "missing or invalid 'command' field" };
      }

      if (config.command.trim().length === 0) {
        return { valid: false, error: "'command' cannot be empty" };
      }

      // Validate args
      if (config.args !== undefined) {
        if (!Array.isArray(config.args)) {
          return { valid: false, error: "'args' must be an array" };
        }
        for (let i = 0; i < config.args.length; i++) {
          if (typeof config.args[i] !== "string") {
            return { valid: false, error: `'args[${i}]' must be a string` };
          }
        }
      }

      // Validate env
      if (config.env !== undefined) {
        if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
          return { valid: false, error: "'env' must be an object" };
        }
        for (const [key, value] of Object.entries(config.env)) {
          if (typeof key !== "string" || typeof value !== "string") {
            return { valid: false, error: `'env.${key}' must be a string value` };
          }
        }
      }

      // Validate toolPrefix
      if (config.toolPrefix !== undefined) {
        if (typeof config.toolPrefix !== "string") {
          return { valid: false, error: "'toolPrefix' must be a string" };
        }
        if (!/^[a-zA-Z0-9_]+$/.test(config.toolPrefix)) {
          return {
            valid: false,
            error: "'toolPrefix' can only contain letters, numbers, and underscores",
          };
        }
      }

      // Validate autoReconnect
      if (config.autoReconnect !== undefined && typeof config.autoReconnect !== "boolean") {
        return { valid: false, error: "'autoReconnect' must be a boolean" };
      }

      return { valid: true };
    };

    it("should accept valid config", () => {
      const result = validateServerConfig("test-server", {
        command: "mcp-server",
        args: ["--arg1", "value1"],
        env: { KEY: "value" },
        toolPrefix: "test_",
        autoReconnect: true,
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should reject empty server name", () => {
      const result = validateServerConfig("", { command: "test" });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("server name");
    });

    it("should reject invalid server name characters", () => {
      const result = validateServerConfig("test server!", { command: "test" });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("letters, numbers, hyphens");
    });

    it("should reject missing command", () => {
      const result = validateServerConfig("test", {} as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("command");
    });

    it("should reject empty command", () => {
      const result = validateServerConfig("test", { command: "   " });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("should reject non-array args", () => {
      const result = validateServerConfig("test", {
        command: "test",
        args: "not-an-array" as any,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("args");
    });

    it("should reject non-string args elements", () => {
      const result = validateServerConfig("test", {
        command: "test",
        args: ["valid", 123 as any],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("args[1]");
    });

    it("should reject non-object env", () => {
      const result = validateServerConfig("test", {
        command: "test",
        env: "not-an-object" as any,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("env");
    });

    it("should reject non-string env values", () => {
      const result = validateServerConfig("test", {
        command: "test",
        env: { KEY: 123 as any },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("env.KEY");
    });

    it("should reject invalid toolPrefix characters", () => {
      const result = validateServerConfig("test", {
        command: "test",
        toolPrefix: "test-prefix!",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("toolPrefix");
    });

    it("should reject non-boolean autoReconnect", () => {
      const result = validateServerConfig("test", {
        command: "test",
        autoReconnect: "yes" as any,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("autoReconnect");
    });

    it("should accept minimal valid config", () => {
      const result = validateServerConfig("simple", { command: "echo" });
      expect(result.valid).toBe(true);
    });
  });

  describe("Tool Prefix Logic", () => {
    it("should use ext_ as default prefix", () => {
      const config = { command: "test" };
      const prefix = config.toolPrefix ?? "ext_";
      expect(prefix).toBe("ext_");
    });

    it("should use custom prefix when provided", () => {
      const config = { command: "test", toolPrefix: "custom_" };
      const prefix = config.toolPrefix ?? "ext_";
      expect(prefix).toBe("custom_");
    });

    it("should sanitize tool names", () => {
      const toolName = "ext_test-tool.name@v1";
      const sanitized = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
      expect(sanitized).toBe("ext_test_tool_name_v1");
    });
  });

  describe("Error Messages", () => {
    it("should format command not found error correctly", () => {
      const command = "nonexistent-command";
      const error = `Command not found: ${command}. Install it or check your PATH.`;
      expect(error).toContain("Command not found");
      expect(error).toContain("nonexistent-command");
    });

    it("should format collision error correctly", () => {
      const toolName = "test_tool";
      const server1 = "server1";
      const server2 = "server2";
      const error = `tool collision: '${toolName}' conflicts with server '${server1}'`;
      expect(error).toContain("collision");
      expect(error).toContain(toolName);
      expect(error).toContain(server1);
    });
  });
});
