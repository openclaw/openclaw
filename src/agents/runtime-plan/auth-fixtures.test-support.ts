import { expect } from "vitest";
import type { Model } from "../../llm/types.js";
import { createNativeOpenAIResponsesModel } from "../../plugin-sdk/test-helpers/agents/schema-normalization-runtime-contract.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { providerConfig } from "../model-auth.fixtures.test-support.js";
import type { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

export const authProvider = { providerForAuth: "openai", authProfileProviderForAuth: "openai" };
export const platformRoute = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;
export const subscriptionRoute = {
  ...platformRoute,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
} as const;
export const platformModel: Model = {
  ...createNativeOpenAIResponsesModel(),
  id: "gpt-5.5",
  name: "gpt-5.5",
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 8_000,
};
export const subscriptionModel: Model = {
  ...platformModel,
  api: subscriptionRoute.api,
  baseUrl: subscriptionRoute.baseUrl,
};
export const platform = {
  provider: "openai",
  modelId: "gpt-5.5",
  env: {},
  modelApi: platformRoute.api,
  modelBaseUrl: platformRoute.baseUrl,
} as const;
export const subscription = {
  ...platform,
  modelApi: subscriptionRoute.api,
  modelBaseUrl: subscriptionRoute.baseUrl,
};
export const codexHarness = { harnessId: "codex", harnessRuntime: "codex" } as const;
export const nativeCodex = { provider: "codex", modelId: "gpt-5.4", ...codexHarness } as const;
export const userPin = (sessionAuthProfileId: string) => ({
  sessionAuthProfileId,
  sessionAuthProfileSource: "user" as const,
});
export const apiKey = (key = "platform-key") => createApiKeyCredential("openai", key);
export const oauth = createOAuthRefreshCredential;
export const openAIConfig = providerConfig.bind(null, "openai");
export const apiRoute = { api: "openai-responses", authRequirement: "api-key" } as const;

export function authStore(
  profiles: AuthProfileStore["profiles"],
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return { version: 1, profiles, ...(order ? { order } : {}) };
}
export function oneProfile(id: string, credential: AuthProfileStore["profiles"][string]) {
  return { [id]: credential };
}
export function token(value = "subscription-token", expires?: number) {
  return {
    type: "token" as const,
    provider: "openai",
    token: value,
    ...(expires === undefined ? {} : { expires }),
  };
}
export function setProfileCooldown(
  store: AuthProfileStore,
  profileId: string,
  details: Omit<NonNullable<AuthProfileStore["usageStats"]>[string], "cooldownUntil"> = {},
) {
  store.usageStats = { [profileId]: { cooldownUntil: Date.now() + 60_000, ...details } };
}
type FixtureParams = Partial<Parameters<typeof prepareAgentRuntimeAuth>[0]> & {
  profiles?: AuthProfileStore["profiles"];
  order?: AuthProfileStore["order"];
};
export function createPreparationFixture(
  prepareAuthFixture: typeof import("./prepare-auth.test-support.js").prepareAuthFixture,
) {
  const prepare = ({ profiles = {}, order, ...params }: FixtureParams) =>
    prepareAuthFixture({
      provider: "openai",
      modelId: "gpt-5.5",
      env: {},
      authProfileStore: authStore(profiles, order),
      ...params,
    });
  return {
    prepare,
    preparePlan: (params: FixtureParams) => prepare(params).plan,
    expectAuthError: (params: FixtureParams) => expect(() => prepare(params)),
  };
}
export function authModel(plan: AgentRuntimeAuthPlan): Model {
  const { api = platformRoute.api, baseUrl = platformRoute.baseUrl } = plan.modelRoute ?? {};
  return { ...platformModel, api, baseUrl };
}
