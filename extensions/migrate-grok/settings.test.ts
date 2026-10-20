import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { assert, describe, expect, it } from "vitest";
import { applyGrokSettingsItem, planGrokSettings } from "./settings.js";
import type { GrokSourceInventory } from "./source/types.js";

const ctx: MigrationProviderContext = {
  config: {},
  stateDir: "/migration-test",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

function inventory(settings: Record<string, unknown>): GrokSourceInventory {
  return {
    source: "/grok-export",
    kind: "snapshot",
    settings: { status: "complete", value: settings },
    agents: { status: "complete", value: [] },
    mcpServers: { status: "complete", value: [] },
    credentials: [],
    issues: [],
  };
}

describe("Grok settings migration", () => {
  it("preserves the explicit timezone override and reports settings without a native equivalent", () => {
    const items = planGrokSettings({
      ctx,
      inventory: inventory({
        userTimeZone: "Europe/London",
        userTimeZoneOverride: "America/Los_Angeles",
        computerUseModel: "grok-computer-model",
        toolPermissions: { shell: "ask" },
      }),
    });
    expect(items.find((item) => item.kind === "config")?.details).toEqual({
      path: ["agents", "defaults", "userTimezone"],
      value: "America/Los_Angeles",
    });
    expect(items.filter((item) => item.kind === "manual").map((item) => item.source)).toEqual([
      "/grok-export#settings.computerUseModel",
      "/grok-export#settings.toolPermissions",
    ]);
  });

  it("recognizes an exact retry but does not replace another timezone or accept an invalid source timezone", async () => {
    const settings = inventory({ userTimeZone: "Europe/London" });
    expect(
      planGrokSettings({
        inventory: settings,
        ctx: { ...ctx, config: { agents: { defaults: { userTimezone: "UTC" } } } },
      })[0],
    ).toMatchObject({ status: "conflict", target: "agents.defaults.userTimezone" });
    expect(
      planGrokSettings({ inventory: inventory({ userTimeZone: "Unknown/Zone" }), ctx }),
    ).toEqual([expect.objectContaining({ kind: "manual", status: "skipped" })]);
    const sameConfig = { agents: { defaults: { userTimezone: "Europe/London" } } };
    const sameContext: MigrationProviderContext = {
      ...ctx,
      config: sameConfig,
      configRuntime: {
        current: () => sameConfig,
        async mutateConfigFile() {
          throw new Error("An exact retry should not rewrite config.");
        },
      },
    };
    const [same] = planGrokSettings({ inventory: settings, ctx: sameContext });
    assert(same, "Expected the timezone migration item");
    expect(same.status).toBe("planned");
    expect(await applyGrokSettingsItem(sameContext, same)).toMatchObject({ status: "migrated" });
  });
});
