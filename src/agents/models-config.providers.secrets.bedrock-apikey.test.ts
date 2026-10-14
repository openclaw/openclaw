import { expect, it } from "vitest";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import { resolveMissingProviderApiKey } from "./models-config.providers.secret-helpers.js";

const provider: ProviderConfig = {
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  api: "bedrock-converse-stream",
  auth: "aws-sdk",
  models: [
    {
      id: "model",
      name: "Model",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    },
  ],
};

it.each<{
  env: NodeJS.ProcessEnv;
  resolved?: string;
  expected?: string;
}>([
  { env: {} },
  {
    env: { AWS_ACCESS_KEY_ID: "fixture-id", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    expected: "AWS_ACCESS_KEY_ID",
  },
  { env: { AWS_PROFILE: "my-profile" }, expected: "AWS_PROFILE" },
  { env: { AWS_BEARER_TOKEN_BEDROCK: "fixture-token" }, expected: "AWS_BEARER_TOKEN_BEDROCK" },
  { env: {}, resolved: "AWS_ACCESS_KEY_ID", expected: "AWS_ACCESS_KEY_ID" },
])("infers AWS SDK auth from $env and plugin marker $resolved", ({ env, resolved, expected }) => {
  const result = resolveMissingProviderApiKey({
    providerKey: "amazon-bedrock",
    provider,
    env,
    profileApiKey: undefined,
    providerApiKeyResolver: () => resolved,
  });
  expect(result.apiKey).toBe(expected);
  if (!expected) {
    // EC2/ECS instance-role auth must not acquire a fabricated AWS_PROFILE marker (#61194).
    expect(result).toBe(provider);
  }
});

it.each(["provider", "model"] as const)("routes custom Google %s APIs to their policy", (level) => {
  expect(
    resolveProviderPluginLookupKey("custom-google", {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: level === "provider" ? "google-generative-ai" : undefined,
      models:
        level === "model"
          ? provider.models.map((model) =>
              Object.assign({}, model, { api: "google-generative-ai" as const }),
            )
          : [],
    }),
  ).toBe("google");
});
