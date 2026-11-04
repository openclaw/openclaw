// Amazon Bedrock tests cover the AWS SDK auth choice.
import { expect, it, vi } from "vitest";

const upsertProfileMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-auth-api-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-api-key")>()),
  upsertAuthProfileWithLockOrThrow: upsertProfileMock,
}));

const { awsSdkAuthMethod, buildBedrockAwsSdkAuthResult } = await import("./aws-sdk-auth.js");

const MARKER_CREDENTIAL = {
  type: "api_key",
  provider: "amazon-bedrock",
  key: "aws-sdk-credentials",
};

it("saves a marker account and routes the provider through the AWS SDK chain", () => {
  const result = buildBedrockAwsSdkAuthResult({});

  expect(result.profiles).toEqual([
    { profileId: "amazon-bedrock:aws-sdk", credential: MARKER_CREDENTIAL },
  ]);
  expect(result.configPatch).toEqual({
    models: { providers: { "amazon-bedrock": { auth: "aws-sdk" } } },
  });
  // Discovery follows an accepted region only.
  expect(buildBedrockAwsSdkAuthResult({ region: " US-West-2 " }).configPatch?.plugins).toEqual({
    entries: {
      "amazon-bedrock": { config: { discovery: { enabled: true, region: "us-west-2" } } },
    },
  });
  expect(
    buildBedrockAwsSdkAuthResult({ region: "not a region" }).configPatch?.plugins,
  ).toBeUndefined();
});

it("persists the same account non-interactively, defaulting the region from the environment", async () => {
  const previous = process.env.AWS_REGION;
  process.env.AWS_REGION = "eu-central-1";
  try {
    const config = await awsSdkAuthMethod.runNonInteractive?.({
      authChoice: "amazon-bedrock-aws-sdk",
      config: {
        auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
      },
      baseConfig: {},
      opts: {},
      agentDir: "/tmp/openclaw-bedrock-test-agent",
      runtime: { log: () => {}, error: () => {}, exit: () => undefined as never },
      resolveApiKey: async () => null,
      toApiKeyCredential: () => null,
    });

    expect(upsertProfileMock).toHaveBeenCalledWith({
      profileId: "amazon-bedrock:aws-sdk",
      credential: MARKER_CREDENTIAL,
      agentDir: "/tmp/openclaw-bedrock-test-agent",
    });
    expect(config?.auth?.profiles).toEqual({
      "openai:platform": { provider: "openai", mode: "api_key" },
      "amazon-bedrock:aws-sdk": { provider: "amazon-bedrock", mode: "api_key" },
    });
    expect(config?.models?.providers?.["amazon-bedrock"]?.auth).toBe("aws-sdk");
    expect(config?.plugins?.entries?.["amazon-bedrock"]?.config).toEqual({
      discovery: { enabled: true, region: "eu-central-1" },
    });
    expect(JSON.stringify(config)).not.toContain("SecretAccessKey");
  } finally {
    process.env.AWS_REGION = previous;
  }
});
