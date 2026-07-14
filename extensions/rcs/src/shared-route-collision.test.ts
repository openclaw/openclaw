import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
// RCS tests: a new required RCS route must fail fast when its path is unavailable,
// while existing callers keep the core registry's legacy no-op conflict behavior.
// These exercise the real core registry without an SDK mock.
import { describe, expect, it } from "vitest";

type Registry = NonNullable<Parameters<typeof registerPluginHttpRoute>[0]["registry"]>;

function emptyRegistry(): Registry {
  // registerPluginHttpRoute only reads and writes registry.httpRoutes.
  return { httpRoutes: [] } as unknown as Registry;
}

function register(registry: Registry, pluginId: string, throwOnFailure = false) {
  return registerPluginHttpRoute({
    registry,
    path: "/webhooks/twilio-shared",
    auth: "plugin",
    pluginId,
    accountId: "default",
    ...(throwOnFailure ? { throwOnFailure: true } : {}),
    handler: () => {},
  });
}

describe("shared Twilio webhook route collision (real core registry)", () => {
  it("accepts the first owner and rejects a second channel on the same exact path (SMS then RCS)", () => {
    const registry = emptyRegistry();

    register(registry, "sms");

    expect(() => register(registry, "rcs", true)).toThrow(
      /route conflict at \/webhooks\/twilio-shared/u,
    );
  });

  it("preserves the legacy SMS no-op when RCS already owns the path", () => {
    const registry = emptyRegistry();

    const unregisterRcs = register(registry, "rcs", true);
    const unregisterSms = register(registry, "sms");

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.pluginId).toBe("rcs");

    unregisterSms();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.pluginId).toBe("rcs");

    unregisterRcs();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("frees the path for a new owner only after the first owner unregisters", () => {
    const registry = emptyRegistry();

    const first = register(registry, "sms");
    first();
    expect(() => register(registry, "rcs", true)).not.toThrow();
  });
});
