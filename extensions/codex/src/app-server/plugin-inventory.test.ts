import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCodexPluginAppsCache } from "./plugin-apps-cache.js";
import { buildConfiguredCodexPluginRecords, readCodexPluginInventory } from "./plugin-inventory.js";

describe("Codex plugin inventory", () => {
  afterEach(() => {
    clearCodexPluginAppsCache();
    vi.useRealTimers();
  });

  it("builds one OpenClaw tool record per enabled configured plugin", () => {
    const records = buildConfiguredCodexPluginRecords({
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            enabled: true,
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
          slack: { enabled: false, marketplaceName: "openai-curated", pluginName: "slack" },
        },
      },
    });

    expect(records.map((record) => record.toolName)).toEqual(["codex_plugin_google_calendar"]);
    expect(records[0]).toMatchObject({
      activationEligible: true,
      sourceInstalled: true,
      allowDestructiveActions: false,
    });
  });

  it("uses the openai-curated marketplace and marks inaccessible enabled apps as auth-required", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            calendar: {
              enabled: true,
              marketplaceName: "openai-curated",
              pluginName: "google-calendar",
            },
          },
        },
      },
      request: async (method) => {
        if (method === "plugin/list") {
          return {
            marketplaces: [
              {
                name: "openai-curated",
                path: "/market/openai-curated",
                plugins: [
                  {
                    id: "google-calendar",
                    name: "google-calendar",
                    installed: true,
                    enabled: true,
                    interface: { displayName: "Google Calendar" },
                  },
                ],
              },
              {
                name: "other",
                plugins: [{ id: "slack", name: "slack", installed: true, enabled: true }],
              },
            ],
          };
        }
        if (method === "app/list") {
          return {
            data: [
              {
                id: "calendar",
                name: "Calendar",
                isAccessible: false,
                isEnabled: true,
                pluginDisplayNames: ["Google Calendar"],
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    expect(inventory.records[0]).toMatchObject({
      key: "google-calendar",
      displayName: "Google Calendar",
      marketplacePath: "/market/openai-curated",
      authRequired: true,
      activationEligible: true,
    });
  });

  it("serves cached app inventory while asynchronously refreshing expired entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let appListCalls = 0;
    let accessible = false;
    const request = async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated",
              plugins: [
                {
                  id: "google-calendar",
                  name: "google-calendar",
                  installed: true,
                  enabled: true,
                  interface: { displayName: "Google Calendar" },
                },
              ],
            },
          ],
        };
      }
      if (method === "app/list") {
        appListCalls += 1;
        return {
          data: [
            {
              id: "calendar",
              name: "Calendar",
              isAccessible: accessible,
              isEnabled: true,
              pluginDisplayNames: ["Google Calendar"],
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          calendar: {
            enabled: true,
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };

    const first = await readCodexPluginInventory({
      pluginConfig,
      request,
      forceRefetchApps: false,
      appCacheKey: "stale-refresh-test",
    });
    expect(first.records[0]?.authRequired).toBe(true);
    expect(appListCalls).toBe(1);

    accessible = true;
    vi.setSystemTime(60 * 60_000 + 1);
    const second = await readCodexPluginInventory({
      pluginConfig,
      request,
      forceRefetchApps: false,
      appCacheKey: "stale-refresh-test",
    });
    expect(second.records[0]?.authRequired).toBe(true);
    expect(appListCalls).toBe(2);

    await Promise.resolve();
    await Promise.resolve();

    const third = await readCodexPluginInventory({
      pluginConfig,
      request,
      forceRefetchApps: false,
      appCacheKey: "stale-refresh-test",
    });
    expect(third.records[0]?.authRequired).toBe(false);
    expect(appListCalls).toBe(2);
  });

  it("bypasses fresh cached app inventory when force refetch is requested", async () => {
    let appListCalls = 0;
    let accessible = false;
    const request = async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated",
              plugins: [
                {
                  id: "google-calendar",
                  name: "google-calendar",
                  installed: true,
                  enabled: true,
                  interface: { displayName: "Google Calendar" },
                },
              ],
            },
          ],
        };
      }
      if (method === "app/list") {
        appListCalls += 1;
        return {
          data: [
            {
              id: "calendar",
              name: "Calendar",
              isAccessible: accessible,
              isEnabled: true,
              pluginDisplayNames: ["Google Calendar"],
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          calendar: {
            enabled: true,
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };

    const first = await readCodexPluginInventory({
      pluginConfig,
      request,
      forceRefetchApps: false,
      appCacheKey: "force-refresh-test",
    });
    expect(first.records[0]?.authRequired).toBe(true);

    accessible = true;
    const second = await readCodexPluginInventory({
      pluginConfig,
      request,
      forceRefetchApps: true,
      appCacheKey: "force-refresh-test",
    });
    expect(second.records[0]?.authRequired).toBe(false);
    expect(appListCalls).toBe(2);
  });
});
