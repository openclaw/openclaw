import { expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { resolveMcpEventsConfig } from "./src/config.js";

type Config = Parameters<typeof normalizeCompatibilityConfig>[0]["cfg"];
type PluginEntry = NonNullable<NonNullable<Config["plugins"]>["entries"]>[string];

function migrate(entry: PluginEntry) {
  const result = normalizeCompatibilityConfig({
    cfg: { plugins: { entries: { "mcp-events": entry } } },
  });
  return {
    entry: result.config.plugins?.entries?.["mcp-events"],
    changes: result.changes,
    warnings: result.warnings,
  };
}

it("reports the retired key and moves it without changing the callback URL", () => {
  expect(legacyConfigRules.map((rule) => rule.path.join("."))).toEqual([
    "plugins.entries.mcp-events.config.callbackOrigin",
  ]);
  const before = { callbackOrigin: "https://Events.Example.com/", maxPendingEvents: 5 };
  const result = migrate({ enabled: true, config: before });
  expect(result.entry).toEqual({
    enabled: true,
    config: { callbackBaseUrl: "https://Events.Example.com/", maxPendingEvents: 5 },
  });
  // The shipped setting resolved to the URL origin; stored callback URLs must keep matching it.
  expect(resolveMcpEventsConfig(result.entry?.config).callbackBaseUrl).toBe(
    new URL(before.callbackOrigin).origin,
  );
  expect(result.changes).toEqual([
    "Moved plugins.entries.mcp-events.config.callbackOrigin to plugins.entries.mcp-events.config.callbackBaseUrl.",
  ]);
});

it("keeps an explicit callbackBaseUrl authoritative over callbackOrigin", () => {
  const result = migrate({
    config: {
      callbackBaseUrl: "https://proxy.example.com/prefix",
      callbackOrigin: "https://events.example.com",
    },
  });
  expect(result.entry?.config).toEqual({ callbackBaseUrl: "https://proxy.example.com/prefix" });
  expect(result.changes).toHaveLength(1);
  const unset = migrate({
    config: { callbackBaseUrl: null, callbackOrigin: "https://events.example.com" },
  });
  expect(unset.entry?.config).toEqual({ callbackBaseUrl: "https://events.example.com" });
});

it("removes an origin the shipped setting rejected without echoing it", () => {
  const secret = "https://user:s3cret@events.example.com";
  const emptied = migrate({ enabled: false, config: { callbackOrigin: secret } });
  // No config object left, so the disabled entry passes schema validation.
  expect(emptied.entry).toEqual({ enabled: false });
  expect(emptied.changes[0]).toContain("it was not a valid HTTPS origin");
  expect(JSON.stringify(emptied)).not.toContain("s3cret");
  expect(emptied.warnings?.[0]).toContain("Set plugins.entries.mcp-events.config.callbackBaseUrl");
  const kept = migrate({
    config: { callbackOrigin: "https://e.example.com/x", maxPendingEvents: 5 },
  });
  expect(kept.entry).toEqual({ config: { maxPendingEvents: 5 } });
});

it("leaves current and absent configs unchanged", () => {
  const cfg: Config = {
    plugins: {
      entries: { "mcp-events": { config: { callbackBaseUrl: "https://a.example.com" } } },
    },
  };
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  expect(normalizeCompatibilityConfig({ cfg: {} })).toEqual({ config: {}, changes: [] });
});
