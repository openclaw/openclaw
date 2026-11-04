// Amazon Bedrock tests cover config compat plugin behavior.
import { describe, expect, it } from "vitest";
import { migrateAmazonBedrockLegacyConfig } from "./config-compat.js";

describe("amazon-bedrock config migration", () => {
  it("moves legacy models.bedrockDiscovery into plugin-owned discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        mode: "merge",
        bedrockDiscovery: {
          enabled: true,
          region: "us-east-1",
          refreshInterval: 3600,
        },
      },
    });

    expect(result.config).toEqual({
      models: {
        mode: "merge",
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                region: "us-east-1",
                refreshInterval: 3600,
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery.",
    ]);
  });

  it("merges missing fields into existing plugin discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        bedrockDiscovery: {
          enabled: true,
          region: "us-east-1",
          providerFilter: ["anthropic"],
        },
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                region: "us-west-2",
              },
            },
          },
        },
      },
    });

    expect(result.config).toEqual({
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                region: "us-west-2",
                providerFilter: ["anthropic"],
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Merged models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("declares the aws-sdk auth profile for a legacy provider auth override", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: { providers: { "amazon-bedrock": { auth: "aws-sdk" } } },
    });

    expect(result.config).toEqual({
      models: { providers: { "amazon-bedrock": { auth: "aws-sdk" } } },
      auth: {
        profiles: {
          "amazon-bedrock:aws-sdk": { provider: "amazon-bedrock", mode: "aws-sdk" },
        },
      },
    });
    expect(result.changes).toEqual([
      'Declared auth.profiles.amazon-bedrock:aws-sdk for models.providers.amazon-bedrock.auth="aws-sdk" (AWS SDK default credential chain; no credential is stored).',
    ]);
  });

  it("keeps an already declared aws-sdk profile and other auth modes unchanged", () => {
    const declared = {
      models: { providers: { "amazon-bedrock": { auth: "aws-sdk" } } },
      auth: { profiles: { "bedrock-prod": { provider: "amazon-bedrock", mode: "aws-sdk" } } },
    };
    expect(migrateAmazonBedrockLegacyConfig(declared)).toEqual({
      config: declared,
      changes: [],
    });

    const apiKey = { models: { providers: { "amazon-bedrock": { apiKey: "env:KEY" } } } };
    expect(migrateAmazonBedrockLegacyConfig(apiKey)).toEqual({ config: apiKey, changes: [] });
  });
});
