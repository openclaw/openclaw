import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";

export function useAuthBridgeFixture() {
  let workspace: TempWorkspace;
  const previousEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
  };
  beforeEach(async () => {
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-acpx-codex-auth-",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of ["CODEX_HOME", "OPENCLAW_AGENT_DIR"] as const) {
      const value = previousEnv[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await workspace.cleanup();
  });
  return () => {
    const root = workspace.dir;
    const stateDir = path.join(root, "state");
    const baseDir = path.join(stateDir, "acpx");
    const config = (command?: string, agent = "codex") =>
      resolveAcpxPluginConfig({
        rawConfig: command ? { agents: { [agent]: { command } } } : {},
        workspaceDir: root,
      });
    return {
      root,
      stateDir,
      config,
      sourceConfig: async (content: string) => {
        const home = path.join(root, "source-codex");
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(home, "config.toml"), content);
        process.env.CODEX_HOME = home;
        return home;
      },
      generated: {
        configPath: path.join(baseDir, "codex-home", "config.toml"),
        wrapperPath: path.join(baseDir, "codex-acp-wrapper.mjs"),
      },
      generatedClaude: { wrapperPath: path.join(baseDir, "claude-agent-acp-wrapper.mjs") },
      prepare: (options: Partial<Parameters<typeof prepareAcpxCodexAuthConfig>[0]> = {}) =>
        prepareAcpxCodexAuthConfig({
          pluginConfig: options.pluginConfig ?? config(),
          stateDir,
          ...options,
        }),
    };
  };
}
