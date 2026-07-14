import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
// RCS tests: a shared SMS/RCS Twilio webhook must fail fast on a route collision
// instead of leaving a channel silently unavailable. These exercise the REAL core
// plugin HTTP registry (no SDK mock) to prove the opt-in fail-fast policy in BOTH
// startup orders (SMS-first-then-RCS and RCS-first-then-SMS).
import { describe, expect, it } from "vitest";

type Registry = NonNullable<Parameters<typeof registerPluginHttpRoute>[0]["registry"]>;

function emptyRegistry(): Registry {
  // registerPluginHttpRoute only reads and writes registry.httpRoutes.
  return { httpRoutes: [] } as unknown as Registry;
}

function register(registry: Registry, pluginId: string, conflictPolicy?: "ignore" | "throw") {
  return registerPluginHttpRoute({
    registry,
    path: "/webhooks/twilio-shared",
    auth: "plugin",
    pluginId,
    accountId: "default",
    ...(conflictPolicy ? { conflictPolicy } : {}),
    handler: () => {},
  });
}

describe("shared Twilio webhook route collision (real core registry)", () => {
  it("accepts the first owner and rejects a second channel on the same exact path (SMS then RCS)", () => {
    const registry = emptyRegistry();

    register(registry, "sms");

    expect(() => register(registry, "rcs", "throw")).toThrow(
      /route conflict at \/webhooks\/twilio-shared/u,
    );
  });

  it("rejects the second channel regardless of order (RCS then SMS)", () => {
    const registry = emptyRegistry();

    register(registry, "rcs");
    expect(() => register(registry, "sms", "throw")).toThrow(
      /route conflict at \/webhooks\/twilio-shared/u,
    );
  });

  it("frees the path for a new owner only after the first owner unregisters", () => {
    const registry = emptyRegistry();

    const first = register(registry, "sms");
    first();
    expect(() => register(registry, "rcs", "throw")).not.toThrow();
  });
});
