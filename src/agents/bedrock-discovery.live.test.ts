import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } from "./bedrock-discovery.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const HAS_AWS_CREDS =
  Boolean(process.env.AWS_ACCESS_KEY_ID) ||
  Boolean(process.env.AWS_PROFILE) ||
  Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK);

const describeLive = LIVE && HAS_AWS_CREDS ? describe : describe.skip;

describeLive("bedrock discovery (live)", () => {
  it("discovers foundation models from AWS Bedrock", async () => {
    resetBedrockDiscoveryCacheForTest();

    const models = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        includeInferenceProfiles: false,
      },
    });

    expect(models.length).toBeGreaterThan(0);

    // Check that we got standard foundation models
    const hasStandardModels = models.some((m) => m.id.includes(".") && !m.id.includes("us."));
    expect(hasStandardModels).toBe(true);

    // Verify model structure
    const firstModel = models[0];
    expect(firstModel).toHaveProperty("id");
    expect(firstModel).toHaveProperty("name");
    expect(firstModel).toHaveProperty("reasoning");
    expect(firstModel).toHaveProperty("input");
    expect(firstModel).toHaveProperty("cost");
    expect(firstModel).toHaveProperty("contextWindow");
    expect(firstModel).toHaveProperty("maxTokens");

    console.log(`✓ Discovered ${models.length} foundation models`);
    console.log(`  Sample: ${firstModel.id} - ${firstModel.name}`);
  });

  it("discovers cross-region inference profiles from AWS Bedrock", async () => {
    resetBedrockDiscoveryCacheForTest();

    const models = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        includeInferenceProfiles: true,
      },
    });

    expect(models.length).toBeGreaterThan(0);

    // Check that we got inference profiles
    const hasInferenceProfiles = models.some(
      (m) => m.id.startsWith("us.") || m.id.startsWith("eu.") || m.id.startsWith("global."),
    );
    expect(hasInferenceProfiles).toBe(true);

    // Find some specific inference profiles
    const usProfiles = models.filter((m) => m.id.startsWith("us."));
    const globalProfiles = models.filter((m) => m.id.startsWith("global."));

    console.log(`✓ Discovered ${models.length} total models`);
    console.log(`  US inference profiles: ${usProfiles.length}`);
    console.log(`  Global inference profiles: ${globalProfiles.length}`);

    if (usProfiles.length > 0) {
      console.log(`  Sample US profile: ${usProfiles[0].id} - ${usProfiles[0].name}`);
    }
    if (globalProfiles.length > 0) {
      console.log(`  Sample global profile: ${globalProfiles[0].id} - ${globalProfiles[0].name}`);
    }
  });

  it("filters models by provider (anthropic)", async () => {
    resetBedrockDiscoveryCacheForTest();

    const models = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        providerFilter: ["anthropic"],
        includeInferenceProfiles: true,
      },
    });

    expect(models.length).toBeGreaterThan(0);

    // All models should be from Anthropic
    const allAnthropicModels = models.every(
      (m) => m.id.includes("anthropic") || m.id.includes("claude"),
    );
    expect(allAnthropicModels).toBe(true);

    // Should have both standard and inference profile models
    const hasStandardModels = models.some((m) => m.id.startsWith("anthropic."));
    const hasInferenceProfiles = models.some(
      (m) => m.id.includes(".anthropic.") || m.id.startsWith("global.anthropic"),
    );

    console.log(`✓ Discovered ${models.length} Anthropic models`);
    console.log(`  Standard models: ${hasStandardModels ? "Yes" : "No"}`);
    console.log(`  Inference profiles: ${hasInferenceProfiles ? "Yes" : "No"}`);

    if (models.length > 0) {
      console.log(`  Sample: ${models[0].id} - ${models[0].name}`);
    }
  });

  it("respects includeInferenceProfiles=false", async () => {
    resetBedrockDiscoveryCacheForTest();

    const modelsWithProfiles = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        includeInferenceProfiles: true,
      },
    });

    const modelsWithoutProfiles = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        includeInferenceProfiles: false,
      },
    });

    // Should have more models when including inference profiles
    expect(modelsWithProfiles.length).toBeGreaterThan(modelsWithoutProfiles.length);

    // Models without profiles should not have inference profile IDs
    const hasInferenceProfiles = modelsWithoutProfiles.some(
      (m) => m.id.startsWith("us.") || m.id.startsWith("eu.") || m.id.startsWith("global."),
    );
    expect(hasInferenceProfiles).toBe(false);

    console.log(`✓ With inference profiles: ${modelsWithProfiles.length} models`);
    console.log(`✓ Without inference profiles: ${modelsWithoutProfiles.length} models`);
    console.log(
      `  Difference: ${modelsWithProfiles.length - modelsWithoutProfiles.length} inference profiles`,
    );
  });

  it("discovers Anthropic Claude models with correct metadata", async () => {
    resetBedrockDiscoveryCacheForTest();

    const models = await discoverBedrockModels({
      region: AWS_REGION,
      config: {
        refreshInterval: 0,
        providerFilter: ["anthropic"],
        includeInferenceProfiles: true,
      },
    });

    // Find a Claude model
    const claudeModel = models.find((m) => m.id.includes("claude"));
    expect(claudeModel).toBeDefined();

    if (claudeModel) {
      // Verify it has reasonable defaults
      expect(claudeModel.contextWindow).toBeGreaterThan(0);
      expect(claudeModel.maxTokens).toBeGreaterThan(0);
      expect(claudeModel.input).toContain("text");
      expect(claudeModel.cost).toBeDefined();

      console.log(`✓ Found Claude model: ${claudeModel.id}`);
      console.log(`  Name: ${claudeModel.name}`);
      console.log(`  Context window: ${claudeModel.contextWindow}`);
      console.log(`  Max tokens: ${claudeModel.maxTokens}`);
      console.log(`  Input modalities: ${claudeModel.input.join(", ")}`);
      console.log(`  Reasoning support: ${claudeModel.reasoning}`);
    }
  });
});
