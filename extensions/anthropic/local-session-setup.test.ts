import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableClaudeLocalSharing } from "./local-session-setup.js";

describe("enableClaudeLocalSharing", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-share-"));
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it("merges the hooks into existing settings, registers the channel once, and is idempotent", async () => {
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );
    const claudeCalls: string[][] = [];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    const runClaude = async (args: string[]) => {
      claudeCalls.push(args);
    };

    const notes = await enableClaudeLocalSharing({ env, runClaude });
    const settings = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("say done");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("openclaw-channel-hook.mjs");
    expect(Object.keys(settings.hooks).toSorted()).toEqual([
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(claudeCalls).toEqual([
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "openclaw",
        "--",
        "node",
        expect.stringContaining("openclaw-channel-server.mjs"),
      ],
    ]);
    expect(notes.some((note) => note.includes("dangerously-load-development-channels"))).toBe(true);

    await enableClaudeLocalSharing({
      env,
      runClaude: async () => {
        throw new Error("MCP server openclaw already exists in user config");
      },
    });
    const again = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(again.hooks.Stop).toHaveLength(2);
    expect(again.hooks.SessionStart).toHaveLength(1);
  });

  it("refuses to touch a settings file it cannot parse", async () => {
    await fs.writeFile(path.join(configDir, "settings.json"), "{ not json");
    await expect(
      enableClaudeLocalSharing({
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        runClaude: async () => {},
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(configDir, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("keeps going with a manual command when claude is not installed", async () => {
    const notes = await enableClaudeLocalSharing({
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      runClaude: async () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    expect(notes.some((note) => note.includes("claude mcp add --scope user openclaw"))).toBe(true);
  });
});
