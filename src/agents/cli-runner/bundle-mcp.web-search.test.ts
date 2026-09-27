import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { requireMcpConfigPath } from "./bundle-mcp.test-support.js";

type SearchConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>;
const modes: CliBundleMcpMode[] = [
  "claude-config-file",
  "codex-config-overrides",
  "gemini-system-settings",
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function prepare(
  mode: CliBundleMcpMode,
  search?: SearchConfig,
  toolOverrides?: SessionToolOverrides,
  enabled = true,
) {
  const prepared = await prepareCliBundleMcpConfig({
    enabled,
    mode,
    backend: { command: "fixture-cli", args: ["run"], resumeArgs: ["resume"] },
    workspaceDir: "/synthetic/cli-search",
    config: { plugins: { enabled: false }, tools: { web: { search } } },
    toolOverrides,
    exclusiveConfig: {
      mcpServers: { openclaw: { type: "http", url: "http://127.0.0.1:12345/mcp" } },
    },
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "" },
  });
  if (prepared.cleanup) {
    cleanups.push(prepared.cleanup);
  }
  return prepared;
}

async function nativeSearchDisabled(
  mode: CliBundleMcpMode,
  prepared: Awaited<ReturnType<typeof prepare>>,
  resumed = false,
) {
  const args = (resumed ? prepared.backend.resumeArgs : prepared.backend.args) ?? [];
  if (mode === "claude-config-file") {
    const index = args.indexOf("--disallowedTools");
    return index !== -1 && (args[index + 1] ?? "").split(",").includes("WebSearch");
  }
  if (mode === "codex-config-overrides") {
    return args.includes('web_search="disabled"');
  }
  const settingsPath = prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (!settingsPath) {
    return false;
  }
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
    tools?: { exclude?: string[] };
  };
  return settings.tools?.exclude?.includes("google_web_search") === true;
}

describe.each(modes)("CLI provider selection: %s", (mode) => {
  it("disables native search for a pinned provider while preserving the managed MCP server", async () => {
    const prepared = await prepare(mode, { provider: "parallel-free" });
    expect(await nativeSearchDisabled(mode, prepared)).toBe(true);
    expect(await nativeSearchDisabled(mode, prepared, true)).toBe(true);
    if (mode === "codex-config-overrides") {
      const servers = prepared.backend.args?.find((arg) => arg.startsWith("mcp_servers="));
      expect(servers).toContain("openclaw");
      expect(servers).not.toContain("disabled_tools");
    } else {
      const file =
        mode === "claude-config-file"
          ? requireMcpConfigPath(prepared.backend.args)
          : prepared.env!.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
      const settings = JSON.parse(await fs.readFile(file, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(settings.mcpServers.openclaw).toBeDefined();
      expect(JSON.stringify(settings.mcpServers)).not.toContain("web_search");
    }
  });

  it("invalidates a native search session when its search provider is pinned", async () => {
    const automatic = await prepare(mode);
    const pinned = await prepare(mode, { provider: "brave" });
    expect(await nativeSearchDisabled(mode, automatic)).toBe(false);
    expect(automatic.mcpResumeHash).not.toBe(pinned.mcpResumeHash);
    expect(
      resolveCliSessionReuse({
        binding: {
          sessionId: "native-session",
          mcpResumeHash: automatic.mcpResumeHash,
          authEpochVersion: 1,
        },
        authEpochVersion: 1,
        mcpResumeHash: pinned.mcpResumeHash,
      }),
    ).toMatchObject({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it.each([
    {
      name: "global disable overrides stale session enable",
      search: { enabled: false },
      overrides: { webSearch: true },
    },
    { name: "session disable", search: undefined, overrides: { webSearch: false } },
    { name: "explicit provider", search: { provider: "brave" }, overrides: undefined },
  ])("enforces $name without bundle MCP", async ({ search, overrides }) => {
    const prepared = await prepare(mode, search, overrides, false);
    expect(await nativeSearchDisabled(mode, prepared)).toBe(true);
  });
});

it.each([false, true])(
  "limits default Claude adaptation to opted-in bundle MCP (enabled=%s)",
  async (enabled) => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled,
      backend: { command: "custom-cli", args: ["run"] },
      workspaceDir: "/synthetic/cli-search",
      config: { tools: { web: { search: { provider: "brave" } } } },
      exclusiveConfig: { mcpServers: {} },
    });
    if (prepared.cleanup) {
      cleanups.push(prepared.cleanup);
    }
    expect(await nativeSearchDisabled("claude-config-file", prepared)).toBe(enabled);
    if (!enabled) {
      expect(prepared.backend.args).toEqual(["run"]);
      expect(prepared.mcpResumeHash).toBeUndefined();
    }
  },
);
