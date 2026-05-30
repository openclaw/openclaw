import { describe, expect, it } from "vitest";
import type { ClaudeAppServerStartOptions } from "./client.js";
import {
  resolveManagedClaudeBridgeStartOptions,
  resolveManagedClaudeBridgeVersion,
} from "./managed-binary.js";

const PLUGIN_ROOT = "/fake/extensions/claude";
const BIN_IN_PLUGIN = "/fake/extensions/claude/node_modules/.bin/openclaw-claude-bridge";

describe("resolveManagedClaudeBridgeStartOptions", () => {
  it("resolves a managed command to the bundled binary and tags resolved-managed", async () => {
    const result = await resolveManagedClaudeBridgeStartOptions(
      { command: "openclaw-claude-bridge", commandSource: "managed", args: [], env: {} },
      {
        platform: "linux",
        pluginRoot: PLUGIN_ROOT,
        pathExists: async (filePath) => filePath === BIN_IN_PLUGIN,
      },
    );
    expect(result.command).toBe(BIN_IN_PLUGIN);
    expect(result.commandSource).toBe("resolved-managed");
  });

  it("passes through an explicit override untouched", async () => {
    for (const commandSource of ["config", "env"] as const) {
      const opts: ClaudeAppServerStartOptions = {
        command: "/opt/custom/bridge",
        commandSource,
      };
      const result = await resolveManagedClaudeBridgeStartOptions(opts, {
        platform: "linux",
        pluginRoot: PLUGIN_ROOT,
        pathExists: async () => true,
      });
      expect(result).toBe(opts);
    }
  });

  it("throws an actionable error when the managed binary is missing", async () => {
    await expect(
      resolveManagedClaudeBridgeStartOptions(
        { command: "openclaw-claude-bridge", commandSource: "managed" },
        { platform: "linux", pluginRoot: PLUGIN_ROOT, pathExists: async () => false },
      ),
    ).rejects.toThrow(/Managed @zeroaltitude\/openclaw-claude-bridge binary was not found/);
  });
});

describe("resolveManagedClaudeBridgeVersion", () => {
  it("returns a semver string for the bundled dep or undefined, never throws", () => {
    const version = resolveManagedClaudeBridgeVersion();
    if (version !== undefined) {
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
