import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME, type CodexMigratedPluginIdentity } from "./config.js";
import {
  ensureCodexAppsSubstrateConfig,
  ensureCodexPluginActivation,
  upsertTomlBoolean,
} from "./plugin-activation.js";
import type { v2 } from "./protocol-generated/typescript/index.js";

describe("Codex plugin activation", () => {
  it("skips plugin/install when the migrated plugin is already active", async () => {
    const calls: string[] = [];
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      request: async (method) => {
        calls.push(method);
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "already_active",
      installAttempted: false,
    });
    expect(calls).toEqual(["plugin/list"]);
  });

  it("can reinstall an already active plugin when migration explicitly applies it", async () => {
    const calls: string[] = [];
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      installEvenIfActive: true,
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/install") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
        }
        if (method === "skills/list") {
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "already_active",
      installAttempted: true,
    });
    expect(calls).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
    ]);
  });

  it("installs a migration-authorized local curated plugin and refreshes runtime state", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const appCache = new CodexAppInventoryCache();
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      appCache,
      appCacheKey: "runtime",
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: false, enabled: false }),
          ]);
        }
        if (method === "plugin/install") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
        }
        if (method === "skills/list") {
          expect(params).toMatchObject({ forceReload: true });
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        if (method === "app/list") {
          return { data: [], nextCursor: null } satisfies v2.AppsListResponse;
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "installed",
      installAttempted: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "skills/list",
      "hooks/list",
      "config/mcpServer/reload",
      "app/list",
    ]);
    expect(appCache.getRevision()).toBeGreaterThan(0);
  });

  it("fails closed when a missing plugin requires a remote marketplace install", async () => {
    const result = await ensureCodexPluginActivation({
      identity: identity("google-calendar"),
      request: async (method) => {
        if (method === "plugin/list") {
          return {
            ...pluginList([pluginSummary("google-calendar", { installed: false, enabled: false })]),
            marketplaces: [
              {
                name: CODEX_PLUGINS_MARKETPLACE_NAME,
                path: null,
                interface: null,
                plugins: [pluginSummary("google-calendar", { installed: false, enabled: false })],
              },
            ],
          } satisfies v2.PluginListResponse;
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "remote_install_unsupported",
      installAttempted: false,
    });
  });

  it("upserts native apps substrate config without clobbering other toml", async () => {
    const existing = 'model = "gpt-5.5"\n\n[features]\nother = true\n';
    expect(upsertTomlBoolean(existing, "features", "apps", true)).toBe(
      'model = "gpt-5.5"\n\n[features]\nother = true\napps = true\n',
    );

    const writes: Array<{ path: string; content: string }> = [];
    const result = await ensureCodexAppsSubstrateConfig({
      codexHome: "/codex-home",
      readFile: vi.fn(async () => existing),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (filePath, content) => {
        writes.push({ path: String(filePath), content: String(content) });
      }),
    });

    expect(result).toEqual({ changed: true, configPath: "/codex-home/config.toml" });
    expect(writes[0]?.content).toContain("[features]\nother = true\napps = true");
    expect(writes[0]?.content).toContain("[apps._default]\nenabled = true");
  });
});

function identity(pluginName: string): CodexMigratedPluginIdentity {
  return {
    configKey: pluginName,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    pluginName,
  };
}

function pluginList(plugins: v2.PluginSummary[]): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: CODEX_PLUGINS_MARKETPLACE_NAME,
        path: "/marketplaces/openai-curated",
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginSummary(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
    ...overrides,
  };
}
