import { afterEach, expect, it } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  routeResolverFactory,
  mockRouteResolverFactory,
} from "./model-auth-availability.test-support.js";
import { providerConfig as configuredProvider } from "./model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

const catalogRef = { source: "store", provider: "default", id: "CATALOG_KEY" } as const;
afterEach(clearRuntimeConfigSnapshot);

function readiness(cfg: OpenClawConfig, store = authStore()) {
  return createModelAuthAvailabilityResolver({ cfg, authStore: store, env: {} });
}

it.each([
  { name: "resolved profile collision", key: "bound", available: true },
  { name: "resolved malformed syntax", key: "$not-a-template", available: true },
  { name: "pending env provenance", key: "ollama-local", pending: true, available: true },
  { name: "literal profile binding", key: "bound", literal: true, available: false },
  { name: "literal local marker", key: "ollama-local", literal: true, available: undefined },
  { name: "literal env marker", key: "OPENAI_API_KEY", literal: true, available: false },
  { name: "literal malformed syntax", key: "$not-a-template", literal: true, available: false },
  { name: "missing snapshot", key: "ollama-local", snapshot: "absent", available: undefined },
  { name: "unresolved snapshot", snapshot: "unresolved", available: undefined },
  { name: "empty snapshot material", key: "", available: undefined },
  { name: "foreign source", key: "ollama-local", snapshot: "foreign", available: undefined },
  { name: "replaced source", key: "ollama-local", snapshot: "replaced", available: undefined },
  { name: "empty profile order", key: "ollama-local", order: true, available: true },
  { name: "explicit lock", key: "ollama-local", locked: true, available: false },
])(
  "preserves source ownership for $name",
  ({ key, literal, pending, snapshot, order, locked, available }) => {
    const sourceConfig = {
      ...configuredProvider("acme", {
        baseUrl: "https://acme.example/v1",
        apiKey: literal ? key : pending ? "${PENDING_KEY}" : catalogRef,
      }),
      ...(order ? { auth: { order: { acme: [] } } } : {}),
    };
    if (pending) {
      setConfigResolutionFacts(
        sourceConfig,
        createConfigResolutionFacts([], new Map([["models.providers.acme.apiKey", "PENDING_KEY"]])),
      );
    }
    const runtimeConfig = structuredClone(sourceConfig);
    if (snapshot !== "unresolved") {
      runtimeConfig.models.providers.acme!.apiKey = key;
    }
    const store = authStore({
      bound: { type: "api_key", provider: "other", key: "profile-key" },
    });
    if (snapshot !== "absent") {
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    }
    const cfg =
      snapshot === "absent" || snapshot === "foreign" || snapshot === "replaced"
        ? structuredClone(sourceConfig)
        : runtimeConfig;
    if (snapshot === "foreign") {
      cfg.models.providers.acme!.baseUrl = "https://foreign.example/v1";
    }
    if (snapshot === "replaced") {
      const replacement = structuredClone(sourceConfig);
      replacement.models.providers.acme!.apiKey = { ...catalogRef, id: "REPLACEMENT_KEY" };
      setRuntimeConfigSnapshot(runtimeConfig, replacement);
    }
    const result = readiness(cfg, store).evaluateModelAuth(
      "acme",
      locked ? { pinnedProfileId: "bound" } : {},
    );
    expect(result.availability).toBe(available);
    if (available === true) {
      expect(result.evidence).toBe("runtime");
      expect(result.selectedProfileId).toBeUndefined();
      const prepared = prepareAgentRuntimeAuth({
        provider: "acme",
        modelId: "discovered",
        config: cfg,
        authProfileStore: store,
        env: {},
      });
      expect(prepared.attempts[0]).toMatchObject({
        kind: "direct",
        allowAuthProfileFallback: false,
        plan: { credentialSource: { kind: "direct", authorization: "declared" } },
      });
    }
  },
);
it.each(["openai", "anthropic"])(
  "distinguishes missing, failed, unknown, and ready credentials for %s",
  (provider) => {
    const ref = (source: "file" | "env", owner: string, id: string): AuthProfileCredential => ({
      type: "api_key",
      provider,
      keyRef: { source, provider: owner, id },
    });
    const cases: [string, AuthProfileCredential | undefined, string | undefined][] = [
      ["no evidence", undefined, "missing-auth"],
      ["expired", { type: "token", provider, token: "expired-token", expires: 1 }, "auth-failed"],
      ["invalid reference", ref("file", "absent", "key"), "auth-failed"],
      ["unread reference", ref("env", "default", "UNREAD_KEY"), undefined],
      ["ready", createApiKeyCredential(provider, "test-key"), undefined],
    ];
    for (const [label, profile, reason] of cases) {
      mockRouteResolverFactory(routeResolverFactory(dualRoutes));
      const result = createModelAuthAvailabilityResolver({
        cfg: {},
        authStore: authStore(profile ? { test: profile } : {}),
        env: {},
      }).evaluateModelAuth(provider);
      expect.soft(result.unavailableReason, label).toBe(reason);
      expect.soft(result.unavailableUntil, label).toBeUndefined();
    }
  },
);

it("reports the earliest retry among viable cooling profiles, excluding invalid or permanently rejected profiles", () => {
  const until = Date.now() + 60_000;
  const store = authStore({
    first: createApiKeyCredential("openai", "first-key"),
    second: createApiKeyCredential("openai", "second-key"),
    invalid: { type: "token", provider: "openai", token: "expired-token", expires: 1 },
    rejected: createApiKeyCredential("openai", "rejected-key"),
  });
  store.usageStats = {
    first: { cooldownUntil: until + 60_000 },
    second: { cooldownUntil: until },
    invalid: { cooldownUntil: until - 30_000 },
    rejected: { disabledUntil: until - 45_000, disabledReason: "auth_permanent" },
  };
  expect(evaluate({ store, ref: { preferredProfileId: "first" } })).toMatchObject({
    availability: false,
    unavailableReason: "cooldown",
    unavailableUntil: until,
  });
  expect(evaluate({ store, ref: { pinnedProfileId: "invalid" } })).toMatchObject({
    availability: false,
    unavailableReason: "auth-failed",
  });
});

it("hides a cooling inline key while preserving a healthy profile fallback", () => {
  const store = authStore();
  const provider = "anthropic-local";
  const cfg = configuredProvider(provider, {
    apiKey: "demo-key",
    baseUrl: "http://127.0.0.1:8000/v1",
  });
  const availability = () =>
    readiness(cfg, store).evaluateModelAuth(provider, { modelId: "demo-model" }).availability;

  expect(availability()).toBe(true);
  store.usageStats = {
    "inline-api-key:anthropic-local": {
      disabledUntil: Date.now() + 60_000,
      disabledReason: "billing",
    },
  };
  expect(availability()).toBe(false);
  store.profiles["test-profile"] = createApiKeyCredential("anthropic-local", "profile-key");
  expect(availability()).toBe(true);
});

it.each(["profile", "inline", "hydrated-inline"] as const)(
  "distinguishes %s permanent auth rejection from active retry windows",
  (source) => {
    const until = Date.now() + 60_000;
    const cases = [
      [{ cooldownUntil: until }, "cooldown", until],
      [{ disabledUntil: until, disabledReason: "auth_permanent" }, "auth-failed", undefined],
      [
        { disabledUntil: 1, disabledReason: "auth_permanent", cooldownUntil: until },
        "cooldown",
        until,
      ],
      [{ disabledUntil: until, disabledReason: "billing" }, "cooldown", until],
    ] as const;
    for (const [stats, reason, retryAt] of cases) {
      clearRuntimeConfigSnapshot();
      const store = authStore({
        bound: createApiKeyCredential("anthropic", "test-key"),
      });
      store.usageStats = {
        [source === "profile" ? "bound" : "inline-api-key:anthropic"]: stats,
      };
      const cfg = configuredProvider("anthropic", {
        auth: "api-key",
        apiKey: source === "profile" ? "bound" : "inline-key",
        baseUrl: "https://api.anthropic.com",
      });
      if (source === "hydrated-inline") {
        const sourceConfig = configuredProvider("anthropic", {
          ...cfg.models.providers.anthropic,
          apiKey: catalogRef,
        });
        cfg.models.providers.anthropic!.apiKey = "ollama-local";
        setRuntimeConfigSnapshot(cfg, sourceConfig);
      }
      const result = readiness(cfg, store).evaluateModelAuth("anthropic");
      expect.soft(result, JSON.stringify(stats)).toMatchObject({
        availability: false,
        unavailableReason: reason,
      });
      expect.soft(result.unavailableUntil, JSON.stringify(stats)).toBe(retryAt);
    }
  },
);
