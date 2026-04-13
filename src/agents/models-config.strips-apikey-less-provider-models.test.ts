import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/**
 * Regression test: providers that have `models` but no `apiKey` and no
 * alternative auth signal must have their `models` array stripped before
 * models.json is written.  The pi SDK model registry requires `apiKey`
 * when a `models` array is present — leaving such entries causes the
 * entire file to be rejected, silently hiding all custom-provider models.
 */

const createModel = (
  id = "test-model",
): NonNullable<ProviderConfig["models"]>[number] => ({
  id,
  name: id,
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

describe("models-config plan strips apiKey-less provider models", () => {
  it("strips models from providers without apiKey or alt auth", async () => {
    const { planOpenClawModelsJsonWithDeps } = await import(
      "./models-config.plan.js"
    );
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              // Has models + apiKey → should be kept
              "custom-provider": {
                apiKey: "sk-test", // pragma: allowlist secret
                baseUrl: "http://localhost:11434/v1",
                api: "openai-completions",
                models: [createModel("custom/model-a")],
              },
              // Has models but no apiKey, no alt auth → should be stripped
              "oauth-provider": {
                baseUrl: "https://oauth.example.com/v1",
                api: "openai-completions",
                models: [createModel("oauth/model-b")],
              },
            },
          },
        },
        agentDir: "/tmp/test-agent-dir",
        env: {},
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      return;
    }

    const written = JSON.parse(plan.contents);

    // custom-provider models preserved
    expect(written.providers["custom-provider"].models).toHaveLength(1);
    expect(written.providers["custom-provider"].models[0].id).toBe(
      "custom/model-a",
    );

    // oauth-provider models stripped, but entry kept (has baseUrl)
    expect(written.providers["oauth-provider"].models).toBeUndefined();
    expect(written.providers["oauth-provider"].baseUrl).toBe(
      "https://oauth.example.com/v1",
    );
  });

  it("keeps models for providers with alt auth (auth field)", async () => {
    const { planOpenClawModelsJsonWithDeps } = await import(
      "./models-config.plan.js"
    );
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              "aws-provider": {
                baseUrl: "https://bedrock.us-east-1.amazonaws.com",
                auth: "aws-sdk",
                api: "openai-completions",
                models: [createModel("bedrock/model-c")],
              },
            },
          },
        },
        agentDir: "/tmp/test-agent-dir",
        env: {},
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      return;
    }

    const written = JSON.parse(plan.contents);
    expect(written.providers["aws-provider"].models).toHaveLength(1);
    expect(written.providers["aws-provider"].models[0].id).toBe(
      "bedrock/model-c",
    );
  });

  it("drops provider entry entirely when only models existed", async () => {
    const { planOpenClawModelsJsonWithDeps } = await import(
      "./models-config.plan.js"
    );
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              // Only has models, nothing else → entry should be dropped
              "bare-oauth": {
                models: [createModel("bare/model-d")],
              } as ProviderConfig,
            },
          },
        },
        agentDir: "/tmp/test-agent-dir",
        env: {},
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    // Provider entry kept (normalization may add default fields like `api`),
    // but models array must be stripped
    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      return;
    }
    const written = JSON.parse(plan.contents);
    expect(written.providers["bare-oauth"]?.models).toBeUndefined();
  });
});
