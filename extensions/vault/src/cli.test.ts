import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testing } from "./cli.js";

describe("vault CLI setup plan", () => {
  it("generates plugin-managed provider config and model api key targets", () => {
    const providerConfig = testing.buildProviderConfig();
    const providerSecrets = testing.collectProviderSecrets({
      openaiId: "providers/openai/apiKey",
      anthropicId: "providers/anthropic/apiKey",
      providerKey: ["local-openai=providers/local-openai/apiKey"],
    });
    const plan = testing.buildPlan({
      providerAlias: "vault",
      providerConfig,
      providerSecrets,
    });

    expect(plan.providerUpserts).toEqual({
      vault: {
        source: "exec",
        pluginIntegration: {
          pluginId: "vault",
          integrationId: "vault",
        },
      },
    });
    expect(plan.targets).toEqual([
      {
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        pathSegments: ["models", "providers", "openai", "apiKey"],
        providerId: "openai",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/openai/apiKey",
        },
      },
      {
        type: "models.providers.apiKey",
        path: "models.providers.anthropic.apiKey",
        pathSegments: ["models", "providers", "anthropic", "apiKey"],
        providerId: "anthropic",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/anthropic/apiKey",
        },
      },
      {
        type: "models.providers.apiKey",
        path: "models.providers.local-openai.apiKey",
        pathSegments: ["models", "providers", "local-openai", "apiKey"],
        providerId: "local-openai",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/local-openai/apiKey",
        },
      },
    ]);
  });

  it("rejects duplicate model provider targets", () => {
    expect(() =>
      testing.collectProviderSecrets({
        openaiId: "providers/openai/apiKey",
        providerKey: ["OpenAI=providers/openai/other"],
      }),
    ).toThrow("Duplicate model provider id in Vault setup: OpenAI");
  });

  it("rejects traversal segments in Vault secret ids", () => {
    expect(() => testing.parseProviderKeyMappings(["openai=providers/../openai/apiKey"])).toThrow(
      "Invalid --provider-key openai Vault secret id",
    );
  });

  it("reports the packaged resolver path when the CLI is bundled", async () => {
    const baseUrl = pathToFileURL("/app/dist/index.js").href;
    const [, bundledPath] = testing.resolverScriptPathCandidates(baseUrl);

    await expect(
      testing.resolveResolverScriptPath(baseUrl, async (filePath) => filePath === bundledPath),
    ).resolves.toBe(bundledPath);
  });
});
