import { describe, expect, it } from "vitest";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
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
  readiness: ProviderModelAuthProfileSource["readiness"] = "ready",
  cooldown: ProviderModelAuthProfileSource["cooldown"] = "clear",
): ProviderModelAuthProfileSource {
  return { kind: "profile", profileId, mode, readiness, cooldown };
}

const direct = (
  mode: string,
  authorization: ProviderModelAuthDirectSource["authorization"] = "declared",
): ProviderModelAuthDirectSource => ({
  kind: "direct",
  mode,
  readiness: "ready",
  evidence: "provider-config",
  authorization,
});

function selectRoute(
  plan: Parameters<typeof buildProviderModelAuthSourcePlan>[0],
  overrides: Partial<Parameters<typeof selectProviderModelRouteAuth>[0]> = {},
) {
  return selectProviderModelRouteAuth({
    provider: "openai",
    resolution: routes,
    sourcePlan: buildProviderModelAuthSourcePlan(plan),
    ...overrides,
  });
}

const apiProfile = () => profile("openai:platform", "api_key");
const subscriptionProfile = () => profile("openai:chatgpt", "oauth");
const subscriptionPreference = { ...routes, preferredAuthRequirement: "subscription" } as const;
const singleRoute = (index: 0 | 1) => ({ ...routes, routes: [routes.routes[index]] }) as const;
const selected = (profileId: string, authRequirement: string) => ({
  kind: "selected",
  selection: { source: { kind: "profile", profileId }, route: { authRequirement } },
});
type RouteOptions = Partial<Parameters<typeof selectProviderModelRouteAuth>[0]>;
const selectNative = (options: RouteOptions) =>
  selectRoute({ profiles: [] }, { runtimeAuthOwner: { id: "codex" }, ...options });
const withSubscription = (patch: Partial<ProviderModelRouteCandidate>) =>
  ({ ...routes, routes: [routes.routes[0], { ...routes.routes[1], ...patch }] }) as const;

describe("provider model route auth", () => {
  it("keeps renewable OAuth on the provider-selected API route", () => {
    const source = {
      ...profile("openai:shared", "oauth", "ready"),
      authFlow: "chatgpt-token-sharing",
      authRequirement: "api-key" as const,
    };
    expect(selectRoute({ profiles: [source] })).toMatchObject({
      kind: "selected",
      selection: { source, route: { api: "openai-responses", authRequirement: "api-key" } },
      attempts: [{ kind: "profile", source, sameRouteProfileIds: ["openai:shared"] }],
    });
  });

  it("rejects a pinned OAuth identity with no inference route", () => {
    expect(
      selectRoute({
        profiles: [],
        ownership: {
          reason: "runtime-binding",
          source: { ...profile("openai:identity", "oauth"), authRequirement: null },
        },
      }),
    ).toMatchObject({ kind: "rejected", reason: "required-profile" });
  });

  it("applies the provider preference before an automatic remembered API profile", () => {
    const decision = selectRoute(
      {
        preferredProfileId: "openai:platform",
        profiles: [apiProfile(), subscriptionProfile()],
      },
      { resolution: subscriptionPreference },
    );
    expect(decision).toMatchObject(selected("openai:chatgpt", "subscription"));
  });

  it.each(["explicit-order", "profile-priority"])(
    "preserves API selection for %s despite a subscription preference",
    (selection) => {
      const decision = selectRoute(
        {
          explicitOrder: selection === "explicit-order",
          preserveProfilePriority: selection === "profile-priority",
          profiles: [apiProfile(), subscriptionProfile()],
        },
        { resolution: subscriptionPreference },
      );
      expect(decision).toMatchObject(selected("openai:platform", "api-key"));
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
    const decision = selectRoute(
      {
        profiles: [profile("openai:platform", "api_key", "unknown")],
        fallback: direct("api-key"),
      },
      { configuredAuthMode: "api-key" },
    );
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

  it.each([
    { name: "single subscription route", resolution: singleRoute(1) },
    { name: "configured subscription auth", configuredAuthMode: "oauth" },
  ])("omits a direct API key fallback for $name", ({ name: _name, ...overrides }) => {
    const decision = selectRoute(
      {
        profiles: [subscriptionProfile()],
        fallback: direct("api-key"),
      },
      overrides,
    );

    expect(decision).toMatchObject(selected("openai:chatgpt", "subscription"));
    expect(decision.kind === "selected" && decision.attempts).toEqual([
      expect.objectContaining({
        kind: "profile",
        source: expect.objectContaining({ profileId: "openai:chatgpt" }),
      }),
    ]);
  });

  it("does not let a clear wrong-route profile hide a cooldown compatible tier", () => {
    expect(
      selectRoute(
        {
          profiles: [
            subscriptionProfile(),
            profile("openai:platform", "api_key", "ready", "active"),
          ],
          fallback: direct("api-key"),
        },
        { resolution: singleRoute(0) },
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: "all-cooldown",
      source: { profileId: "openai:platform" },
    });
  });

  it.each([
    { label: "empty", profiles: [] },
    {
      label: "all unavailable",
      profiles: [profile("openai:invalid", "api_key", "unavailable")],
    },
  ])("rejects an $label explicit order before direct fallback", ({ profiles }) => {
    expect(
      selectRoute({
        profiles,
        explicitOrder: true,
        fallback: direct("api-key"),
      }),
    ).toMatchObject({ kind: "rejected", reason: "explicit-order" });
  });

  it("keeps a required profile authoritative over configured auth", () => {
    expect(
      selectRoute(
        {
          ownership: {
            reason: "provider-binding",
            source: profile("openai:bound", "token", "unknown"),
          },
          profiles: [],
        },
        { configuredAuthMode: "api-key" },
      ),
    ).toMatchObject(selected("openai:bound", "subscription"));
  });

  it("rejects an oauth profile for a configured api-key route", () => {
    expect(
      selectRoute(
        { profiles: [profile("openai:wrong-route", "oauth", "ready")] },
        { configuredAuthMode: "api-key" },
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: "configured-auth",
      source: { profileId: "openai:wrong-route" },
      route: { authRequirement: "api-key" },
    });
  });

  it.each<{
    name: string;
    resolution: RouteOptions["resolution"];
    configuredAuthMode?: string;
    route?: { authRequirement: string };
  }>([
    {
      name: "configured auth without a validated harness mode",
      resolution: routes,
      configuredAuthMode: "oauth",
      route: { authRequirement: "subscription" },
    },
    {
      name: "an authored single route without explicit native ownership",
      resolution: singleRoute(1),
    },
    {
      name: "a runtime owner incompatible with one candidate",
      resolution: withSubscription({ runtimePolicy: { compatibleIds: ["openclaw"] } }),
    },
    {
      name: "a deferred route without runtime compatibility",
      resolution: withSubscription({ runtimePolicy: undefined }),
    },
  ])("rejects $name", ({ resolution, configuredAuthMode, route }) => {
    expect(selectNative({ resolution, configuredAuthMode })).toMatchObject({
      kind: "rejected",
      reason: "configured-auth",
      ...(route ? { route } : {}),
    });
  });

  it("lets an explicit native owner authenticate its sole compatible route", () => {
    expect(
      selectNative({ resolution: singleRoute(1), allowNativeAuthOnSingleRoute: true }),
    ).toEqual({
      kind: "deferred",
      reason: "runtime-auth-owner",
      routeSupport: {
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });

  it("aggregates request overrides across every deferred route", () => {
    expect(
      selectNative({
        resolution: withSubscription({ requestTransportOverrides: "present" }),
        runtimeAuthOwner: { id: "openclaw" },
      }),
    ).toMatchObject({
      kind: "deferred",
      routeSupport: {
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });
  it.each([
    ["admits with no declarations", [], undefined, [{ kind: "direct" }]],
    [
      "blocks unavailable declarations",
      [profile("openai:chatgpt", "oauth", "unavailable")],
      undefined,
      [],
    ],
    ["blocks route-filtered declarations", [], 1, []],
  ] as const)("ambient: %s", (_name, profiles, declaredProfileCount, attempts) => {
    const decision = selectProviderModelAuthSources({
      provider: "openai",
      plan: buildProviderModelAuthSourcePlan({
        profiles,
        declaredProfileCount,
        fallback: direct("api-key", "ambient"),
      }),
    });
    expect(decision.kind === "selected" && decision.attempts).toMatchObject(attempts);
  });
});
