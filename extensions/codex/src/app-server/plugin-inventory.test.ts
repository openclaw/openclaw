import { describe, expect, it } from "vitest";
import { buildConfiguredCodexPluginRecords, readCodexPluginInventory } from "./plugin-inventory.js";

describe("Codex plugin inventory", () => {
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
});
