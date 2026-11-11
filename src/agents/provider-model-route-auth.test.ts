import { expect, it } from "vitest";
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

const support = {
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} as const;
const routes = {
  kind: "routes",
  routes: [
    {
      ...support,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    },
    {
      ...support,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
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
  authorization: ProviderModelAuthDirectSource["authorization"] = "declared",
): ProviderModelAuthDirectSource => ({
  kind: "direct",
  mode: "api-key",
  readiness: "ready",
  evidence: "provider-config",
  authorization,
});
type RouteOptions = Partial<Parameters<typeof selectProviderModelRouteAuth>[0]>;
type Plan = Partial<Parameters<typeof buildProviderModelAuthSourcePlan>[0]>;
function selectRoute(plan: Plan, options: RouteOptions = {}) {
  return selectProviderModelRouteAuth({
    provider: "openai",
    resolution: routes,
    sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [], ...plan }),
    ...options,
  });
}
const api = profile("openai:platform", "api_key");
const subscription = profile("openai:chatgpt", "oauth");
const shared = {
  ...profile("openai:shared", "oauth"),
  authFlow: "chatgpt-token-sharing",
  authRequirement: "api-key",
} as const;
const selected = (profileId: string, authRequirement: string) => ({
  kind: "selected",
  selection: { source: { kind: "profile", profileId }, route: { authRequirement } },
});
const singleRoute = (index: 0 | 1) => ({ ...routes, routes: [routes.routes[index]] }) as const;
const withSubscription = (patch: Partial<ProviderModelRouteCandidate>) =>
  ({ ...routes, routes: [routes.routes[0], { ...routes.routes[1], ...patch }] }) as const;

it.each<[string, Plan, RouteOptions, object]>([
  [
    "renewable OAuth API route",
    { profiles: [shared] },
    {},
    {
      ...selected("openai:shared", "api-key"),
      selection: { source: shared, route: { api: "openai-responses", authRequirement: "api-key" } },
      attempts: [{ kind: "profile", source: shared, sameRouteProfileIds: ["openai:shared"] }],
    },
  ],
  [
    "pinned identity without inference",
    {
      ownership: { reason: "runtime-binding", source: { ...subscription, authRequirement: null } },
    },
    {},
    { kind: "rejected", reason: "required-profile" },
  ],
  [
    "separate profile and direct attempts",
    {
      profiles: [profile("openai:platform", "api_key", "unknown")],
      fallback: direct(),
    },
    { configuredAuthMode: "api-key" },
    {
      kind: "selected",
      attempts: [
        {
          kind: "profile",
          source: { profileId: "openai:platform" },
          sameRouteProfileIds: ["openai:platform"],
        },
        { kind: "direct", allowAuthProfileFallback: false },
      ],
    },
  ],
  [
    "wrong-route profile cannot hide cooldown",
    {
      profiles: [subscription, profile("openai:platform", "api_key", "ready", "active")],
      fallback: direct(),
    },
    { resolution: singleRoute(0) },
    {
      kind: "rejected",
      reason: "all-cooldown",
      source: { profileId: "openai:platform" },
    },
  ],
  [
    "required profile overrides configured auth",
    {
      ownership: {
        reason: "provider-binding",
        source: profile("openai:bound", "token", "unknown"),
      },
    },
    { configuredAuthMode: "api-key" },
    selected("openai:bound", "subscription"),
  ],
  [
    "OAuth cannot serve configured API-key route",
    {
      profiles: [profile("openai:wrong-route", "oauth")],
    },
    { configuredAuthMode: "api-key" },
    {
      kind: "rejected",
      reason: "configured-auth",
      source: { profileId: "openai:wrong-route" },
      route: { authRequirement: "api-key" },
    },
  ],
])("%s", (_name, plan, options, expected) => {
  expect(selectRoute(plan, options)).toMatchObject(expected);
});

it.each(["remembered", "explicit-order", "profile-priority"])(
  "honors provider preference unless %s selection is explicit",
  (selection) => {
    const decision = selectRoute(
      {
        profiles: [api, subscription],
        preferredProfileId: "openai:platform",
        explicitOrder: selection === "explicit-order",
        preserveProfilePriority: selection === "profile-priority",
      },
      { resolution: { ...routes, preferredAuthRequirement: "subscription" } },
    );
    expect(decision).toMatchObject(
      selection === "remembered"
        ? selected("openai:chatgpt", "subscription")
        : selected("openai:platform", "api-key"),
    );
  },
);

it.each([
  ["api-key", "api-key", "api_key"],
  ["aws-sdk", "api-key", "aws-sdk"],
  [undefined, "api-key", "api_key"],
  [undefined, "subscription", "oauth"],
] as const)("materializes %s for %s as %s", (mode, requirement, expected) => {
  expect(resolveProviderModelRouteMaterializationAuthMode({ mode, requirement })).toBe(expected);
});

it.each<RouteOptions>([{ resolution: singleRoute(1) }, { configuredAuthMode: "oauth" }])(
  "omits direct API fallback for subscription route: %j",
  (options) => {
    expect(selectRoute({ profiles: [subscription], fallback: direct() }, options)).toMatchObject({
      ...selected("openai:chatgpt", "subscription"),
      attempts: [{ kind: "profile", source: { profileId: "openai:chatgpt" } }],
    });
  },
);

it.each([
  ["empty", []],
  ["unavailable", [profile("openai:invalid", "api_key", "unavailable")]],
] as const)("rejects %s explicit order before direct fallback", (_name, profiles) => {
  expect(selectRoute({ profiles, explicitOrder: true, fallback: direct() })).toMatchObject({
    kind: "rejected",
    reason: "explicit-order",
  });
});

it.each<[string, RouteOptions, object]>([
  [
    "configured auth",
    { configuredAuthMode: "oauth" },
    { route: { authRequirement: "subscription" } },
  ],
  ["single route without explicit ownership", { resolution: singleRoute(1) }, {}],
  [
    "incompatible candidate",
    {
      resolution: withSubscription({ runtimePolicy: { compatibleIds: ["openclaw"] } }),
    },
    {},
  ],
  [
    "candidate without runtime compatibility",
    {
      resolution: withSubscription({ runtimePolicy: undefined }),
    },
    {},
  ],
])("rejects native deferral: %s", (_name, options, expected) => {
  expect(selectRoute({}, { runtimeAuthOwner: { id: "codex" }, ...options })).toMatchObject({
    kind: "rejected",
    reason: "configured-auth",
    ...expected,
  });
});

it.each<[string, RouteOptions, "none" | "present"]>([
  [
    "explicit sole-route owner",
    {
      resolution: singleRoute(1),
      allowNativeAuthOnSingleRoute: true,
    },
    "none",
  ],
  [
    "all-route request overrides",
    {
      resolution: withSubscription({ requestTransportOverrides: "present" }),
      runtimeAuthOwner: { id: "openclaw" },
    },
    "present",
  ],
])("defers to native owner: %s", (_name, options, requestTransportOverrides) => {
  expect(selectRoute({}, { runtimeAuthOwner: { id: "codex" }, ...options })).toEqual({
    kind: "deferred",
    reason: "runtime-auth-owner",
    routeSupport: { ...support, requestTransportOverrides },
  });
});

it.each([
  ["no declarations", [], undefined, [{ kind: "direct" }]],
  ["unavailable declarations", [profile("openai:chatgpt", "oauth", "unavailable")], undefined, []],
  ["route-filtered declarations", [], 1, []],
] as const)("ambient fallback with %s", (_name, profiles, declaredProfileCount, attempts) => {
  const decision = selectProviderModelAuthSources({
    provider: "openai",
    plan: buildProviderModelAuthSourcePlan({
      profiles,
      declaredProfileCount,
      fallback: direct("ambient"),
    }),
  });
  expect(decision.kind === "selected" && decision.attempts).toMatchObject(attempts);
});
