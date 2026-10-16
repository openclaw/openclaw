import { describe, expect, it } from "vitest";
import {
  buildProviderModelAuthSourcePlan,
  type ProviderModelAuthDirectSource,
  type ProviderModelAuthProfileSource,
} from "./provider-model-auth-source-plan.js";
import {
  resolveProviderModelRouteMaterializationAuthMode,
  selectProviderModelAuthSources,
  selectProviderModelRouteAuth,
} from "./provider-model-route-auth.js";

const routes = {
  kind: "routes",
  routes: [
    {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
    {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
  ],
} as const;

function profile(
  profileId: string,
  mode: string,
  readiness: ProviderModelAuthProfileSource["readiness"],
  cooldown: ProviderModelAuthProfileSource["cooldown"] = "clear",
): ProviderModelAuthProfileSource {
  return { kind: "profile", profileId, mode, readiness, cooldown };
}

function direct(
  mode: string,
  authorization: ProviderModelAuthDirectSource["authorization"] = "declared",
): ProviderModelAuthDirectSource {
  return {
    kind: "direct",
    mode,
    readiness: "ready",
    evidence: "provider-config",
    authorization,
  };
}

describe("provider model route auth", () => {
  it("keeps renewable OAuth on the provider-selected API route", () => {
    const source = {
      ...profile("openai:shared", "oauth", "ready"),
      authFlow: "chatgpt-token-sharing",
      authRequirement: "api-key" as const,
    };
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [source] }),
    });
    expect(decision).toMatchObject({
      kind: "selected",
      selection: { source, route: { api: "openai-responses", authRequirement: "api-key" } },
      attempts: [{ kind: "profile", source, sameRouteProfileIds: ["openai:shared"] }],
    });
  });

  it("rejects a pinned OAuth identity with no inference route", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [],
        ownership: {
          reason: "runtime-binding",
          source: { ...profile("openai:identity", "oauth", "ready"), authRequirement: null },
        },
      }),
    });
    expect(decision).toMatchObject({ kind: "rejected", reason: "required-profile" });
  });

  it("applies the provider preference before an automatic remembered API profile", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: { ...routes, preferredAuthRequirement: "subscription" },
      sourcePlan: buildProviderModelAuthSourcePlan({
        preferredProfileId: "openai:platform",
        profiles: [
          profile("openai:platform", "api_key", "ready"),
          profile("openai:chatgpt", "oauth", "ready"),
        ],
      }),
    });
    expect(decision).toMatchObject({
      kind: "selected",
      selection: {
        source: { profileId: "openai:chatgpt" },
        route: { authRequirement: "subscription" },
      },
    });
  });

  it.each(["explicit-order", "profile-priority"])(
    "preserves API selection for %s despite a subscription preference",
    (selection) => {
      const api = profile("openai:platform", "api_key", "ready");
      const decision = selectProviderModelRouteAuth({
        provider: "openai",
        resolution: { ...routes, preferredAuthRequirement: "subscription" },
        sourcePlan: buildProviderModelAuthSourcePlan({
          explicitOrder: selection === "explicit-order",
          preserveProfilePriority: selection === "profile-priority",
          profiles: [api, profile("openai:chatgpt", "oauth", "ready")],
        }),
      });
      expect(decision).toMatchObject({
        kind: "selected",
        selection: {
          source: { profileId: "openai:platform" },
          route: { authRequirement: "api-key" },
        },
      });
    },
  );

  it.each([
    ["api-key", "api-key", "api_key"],
    ["aws-sdk", "api-key", "aws-sdk"],
    [undefined, "api-key", "api_key"],
    [undefined, "subscription", "oauth"],
  ] as const)("materializes %s for a %s route as %s", (mode, requirement, expected) => {
    expect(resolveProviderModelRouteMaterializationAuthMode({ mode, requirement })).toBe(expected);
  });

  it("keeps profile and direct fallback attempts distinct on one route", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      configuredAuthMode: "api-key",
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:platform", "api_key", "unknown")],
        fallback: direct("api-key"),
      }),
    });
    expect(decision).toMatchObject({
      kind: "selected",
      attempts: [
        {
          kind: "profile",
          source: { profileId: "openai:platform" },
          sameRouteProfileIds: ["openai:platform"],
        },
        { kind: "direct", allowAuthProfileFallback: false },
      ],
    });
  });

  it("omits an incompatible direct fallback when a compatible profile exists", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: { ...routes, routes: [routes.routes[1]] },
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:chatgpt", "oauth", "ready")],
        fallback: direct("api-key"),
      }),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      selection: {
        source: { kind: "profile", profileId: "openai:chatgpt" },
        route: { authRequirement: "subscription" },
      },
    });
    if (decision.kind !== "selected") {
      throw new Error("expected selected route");
    }
    expect(decision.attempts).toEqual([
      expect.objectContaining({
        kind: "profile",
        source: expect.objectContaining({ profileId: "openai:chatgpt" }),
      }),
    ]);
  });

  it("does not attach a direct API key to a configured subscription route", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      configuredAuthMode: "oauth",
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:chatgpt", "oauth", "ready")],
        fallback: direct("api-key"),
      }),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      selection: { route: { authRequirement: "subscription" } },
    });
    if (decision.kind !== "selected") {
      throw new Error("expected selected route");
    }
    expect(decision.attempts).toHaveLength(1);
    expect(decision.attempts[0]).toMatchObject({ kind: "profile" });
  });

  it.each([undefined] as const)(
    "does not let a clear wrong-route profile hide a cooldown compatible tier (%s)",
    (configuredAuthMode) => {
      expect(
        selectProviderModelRouteAuth({
          provider: "openai",
          resolution: { ...routes, routes: [routes.routes[0]] },
          configuredAuthMode,
          sourcePlan: buildProviderModelAuthSourcePlan({
            profiles: [
              profile("openai:chatgpt", "oauth", "ready"),
              profile("openai:platform", "api_key", "ready", "active"),
            ],
            fallback: direct("api-key"),
          }),
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: "all-cooldown",
        source: { profileId: "openai:platform" },
      });
    },
  );

  it.each([
    { label: "empty", profiles: [] },
    {
      label: "all unavailable",
      profiles: [profile("openai:invalid", "api_key", "unavailable")],
    },
  ])("rejects an $label explicit order before direct fallback", ({ profiles }) => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        sourcePlan: buildProviderModelAuthSourcePlan({
          profiles,
          explicitOrder: true,
          fallback: direct("api-key"),
        }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "explicit-order" });
  });

  it("keeps a required profile authoritative over configured auth", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        configuredAuthMode: "api-key",
        sourcePlan: buildProviderModelAuthSourcePlan({
          ownership: {
            reason: "provider-binding",
            source: profile("openai:bound", "token", "unknown"),
          },
          profiles: [],
        }),
      }),
    ).toMatchObject({
      kind: "selected",
      selection: {
        source: { profileId: "openai:bound" },
        route: { authRequirement: "subscription" },
      },
    });
  });

  it.each([{ configuredAuthMode: "api-key", profileMode: "oauth", route: "api-key" }])(
    "rejects a $profileMode profile for a configured $configuredAuthMode route",
    ({ configuredAuthMode, profileMode, route }) => {
      expect(
        selectProviderModelRouteAuth({
          provider: "openai",
          resolution: routes,
          configuredAuthMode,
          sourcePlan: buildProviderModelAuthSourcePlan({
            profiles: [profile("openai:wrong-route", profileMode, "ready")],
          }),
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: "configured-auth",
        source: { profileId: "openai:wrong-route" },
        route: { authRequirement: route },
      });
    },
  );

  it("rejects configured auth without a validated harness credential mode", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        configuredAuthMode: "oauth",
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "configured-auth",
      route: { authRequirement: "subscription" },
    });
  });

  it("lets an explicit native owner authenticate its sole compatible route", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: { ...routes, routes: [routes.routes[1]] },
        runtimeAuthOwner: { id: "codex" },
        allowNativeAuthOnSingleRoute: true,
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toEqual({
      kind: "deferred",
      reason: "runtime-auth-owner",
      routeSupport: {
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });

  it("does not infer native ownership for an explicitly authored single route", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: { ...routes, routes: [routes.routes[1]] },
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "configured-auth" });
  });

  it("rejects a runtime owner that cannot reproduce every candidate route", () => {
    const incompatibleRoutes = {
      ...routes,
      routes: [
        routes.routes[0],
        { ...routes.routes[1], runtimePolicy: { compatibleIds: ["openclaw"] } },
      ],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: incompatibleRoutes,
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "configured-auth" });
  });

  it("fails closed when any deferred route omits runtime compatibility", () => {
    const undeclaredRoutes = {
      ...routes,
      routes: [routes.routes[0], { ...routes.routes[1], runtimePolicy: undefined }],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: undeclaredRoutes,
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "configured-auth" });
  });

  it("aggregates request overrides across every deferred route", () => {
    const overrideRoutes = {
      ...routes,
      routes: [routes.routes[0], { ...routes.routes[1], requestTransportOverrides: "present" }],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: overrideRoutes,
        runtimeAuthOwner: { id: "openclaw" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({
      kind: "deferred",
      routeSupport: {
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });
});

describe("ambient credential admission", () => {
  const ambient = (mode: string): ProviderModelAuthDirectSource => direct(mode, "ambient");
  const select = (plan: Parameters<typeof selectProviderModelAuthSources>[0]["plan"]) =>
    selectProviderModelAuthSources({ provider: "openai", plan });

  it("keeps an ambient fallback when the provider declares no profiles", () => {
    const decision = select(
      buildProviderModelAuthSourcePlan({ profiles: [], fallback: ambient("api-key") }),
    );

    expect(decision.kind === "selected" && decision.attempts).toMatchObject([{ kind: "direct" }]);
  });

  it("does not substitute an ambient fallback for all-unavailable profiles", () => {
    const decision = select(
      buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:chatgpt", "oauth", "unavailable")],
        fallback: ambient("api-key"),
      }),
    );

    expect(decision.kind === "selected" && decision.attempts).toMatchObject([]);
  });

  it("does not re-admit an ambient fallback when route filtering empties the profile list", () => {
    // Rebuild shape used by selectProviderModelRouteAuth when narrowing to a
    // route-compatible subset: no profiles survive, but the operator declared one.
    const decision = select(
      buildProviderModelAuthSourcePlan({
        profiles: [],
        declaredProfileCount: 1,
        fallback: ambient("api-key"),
      }),
    );

    expect(decision.kind === "selected" && decision.attempts).toMatchObject([]);
  });
});
