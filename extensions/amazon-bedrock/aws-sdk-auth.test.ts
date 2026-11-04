// Amazon Bedrock tests cover the AWS SDK auth choice.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { awsSdkAuthMethod, buildBedrockAwsSdkAuthResult } from "./aws-sdk-auth.js";

describe("amazon-bedrock aws-sdk auth", () => {
  it("declares the profile and provider route without storing a credential", () => {
    const result = buildBedrockAwsSdkAuthResult({ config: {} });

    expect(result.profiles).toEqual([]);
    expect(result.configPatch).toEqual({
      auth: {
        profiles: {
          "amazon-bedrock:aws-sdk": { provider: "amazon-bedrock", mode: "aws-sdk" },
        },
      },
      models: { providers: { "amazon-bedrock": { auth: "aws-sdk" } } },
    });
  });

  it("enables discovery for an accepted region and ignores an invalid one", () => {
    expect(
      buildBedrockAwsSdkAuthResult({ config: {}, region: " US-West-2 " }).configPatch?.plugins,
    ).toEqual({
      entries: {
        "amazon-bedrock": { config: { discovery: { enabled: true, region: "us-west-2" } } },
      },
    });
    expect(
      buildBedrockAwsSdkAuthResult({ config: {}, region: "not a region" }).configPatch?.plugins,
    ).toBeUndefined();
  });

  it("keeps existing auth profiles when declaring the account", () => {
    const config: OpenClawConfig = {
      auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
    };

    expect(buildBedrockAwsSdkAuthResult({ config }).configPatch?.auth?.profiles).toEqual({
      "openai:platform": { provider: "openai", mode: "api_key" },
      "amazon-bedrock:aws-sdk": { provider: "amazon-bedrock", mode: "aws-sdk" },
    });
  });

  it("writes the same declaration non-interactively, defaulting the region from the environment", async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-central-1";
    try {
      const config = await awsSdkAuthMethod.runNonInteractive?.({
        authChoice: "amazon-bedrock-aws-sdk",
        config: {},
        baseConfig: {},
        opts: {},
        runtime: { log: () => {}, error: () => {}, exit: () => undefined as never },
        resolveApiKey: async () => null,
        toApiKeyCredential: () => null,
      });

      expect(config?.auth?.profiles?.["amazon-bedrock:aws-sdk"]).toEqual({
        provider: "amazon-bedrock",
        mode: "aws-sdk",
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
});
