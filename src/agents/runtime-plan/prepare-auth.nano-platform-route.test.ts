import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { prepareAgentRuntimeAuthPlan } from "./prepare-auth.test-support.js";

// This suite owns the Platform-route requirement for a first-party id that has no
// static route contract, so provider hooks stay out of the planner fixture.
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

function authStore(
  profiles: AuthProfileStore["profiles"],
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return { version: 1, profiles, ...(order ? { order } : {}) };
}

function codexNanoFixture(modelId = "gpt-5.4-nano") {
  return {
    provider: "openai",
    modelId,
    env: {},
    harnessId: "codex",
    harnessRuntime: "codex",
  } as const;
}

function subscriptionToken() {
  return {
    type: "token" as const,
    provider: "openai",
    token: "subscription-token",
    expires: Date.now() + 60_000,
  };
}

// #148559: before the fix this plan threw "Configured openai authentication is
// not compatible with the selected model route." for every API key.
it("accepts an API key for a contract-less first-party id on the Platform route", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore(
      { "openai:platform": createApiKeyCredential("openai", "platform-key") },
      { openai: ["openai:platform"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    selectedAuthMode: "api_key",
    modelRoute: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    },
  });
});

function chatGPTOAuth() {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "***",
    refresh: "***",
    expires: Date.now() + 60_000,
  };
}

// OpenAI rejects nano on a ChatGPT account ("not supported when using Codex with a
// ChatGPT account"), so an unauthored ChatGPT login is refused before any request
// rather than sent to a route that can never answer.
it("refuses an OAuth-only unauthored nano before any request", () => {
  expect(() =>
    prepareAgentRuntimeAuthPlan({
      ...codexNanoFixture(),
      authProfileStore: authStore({ "openai:chatgpt": chatGPTOAuth() }),
    }),
  ).toThrow("No route-compatible authentication source is configured for openai.");
});

// The runtime model for nano carries the manifest catalog's Platform row, so the
// planner sees an observed Platform transport even with nothing authored.
it("refuses an OAuth-only nano when a Platform row is observed", () => {
  expect(() =>
    prepareAgentRuntimeAuthPlan({
      ...codexNanoFixture(),
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      authProfileStore: authStore({ "openai:chatgpt": chatGPTOAuth() }),
    }),
  ).toThrow("No route-compatible authentication source is configured for openai.");
});

it("routes an API-key-only unauthored nano to the Platform API", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore({
      "openai:platform": createApiKeyCredential("openai", "platform-key"),
    }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    modelRoute: { api: "openai-responses", authRequirement: "api-key" },
  });
});

// The subscription preference applies only where both routes can serve the model;
// nano has no ChatGPT route, so a mixed setup uses its API key.
it("uses the API key for nano when both credentials are available", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore({
      "openai:chatgpt": chatGPTOAuth(),
      "openai:platform": createApiKeyCredential("openai", "platform-key"),
    }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    modelRoute: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    },
  });
});

it("keeps an authored ChatGPT adapter for nano on the subscription route", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    config: {
      models: { providers: { openai: { api: "openai-chatgpt-responses", models: [] } } },
    } as unknown as OpenClawConfig,
    authProfileStore: authStore(
      { "openai:chatgpt": subscriptionToken() },
      { openai: ["openai:chatgpt"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: { api: "openai-chatgpt-responses", authRequirement: "subscription" },
  });
});

it("keeps the dual-route sibling on the subscription route for a ChatGPT-only store", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture("gpt-5.4-mini"),
    authProfileStore: authStore(
      { "openai:chatgpt": subscriptionToken() },
      { openai: ["openai:chatgpt"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    },
  });
});

it("requires a Platform-compatible source for a contract-less first-party id", () => {
  expect(() =>
    prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore({}),
    }),
  ).toThrow("No route-compatible authentication source is configured for openai.");
});
