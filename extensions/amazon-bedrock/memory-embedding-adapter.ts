/**
 * Memory embedding adapter for Amazon Bedrock. It exposes Bedrock embeddings to
 * the memory-core engine and verifies AWS credentials before auto-selection.
 */
import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createBedrockEmbeddingProvider,
  DEFAULT_BEDROCK_EMBEDDING_MODEL,
  hasAwsCredentials,
} from "./embedding-provider.js";

function isBedrockProviderId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "bedrock";
}

function shouldAllowAwsImdsCredentialProbe(options: MemoryEmbeddingProviderCreateOptions): boolean {
  if (isBedrockProviderId(options.provider)) {
    return true;
  }
  if (isBedrockProviderId(options.config.agents?.defaults?.memorySearch?.provider)) {
    return true;
  }
  return (
    options.config.agents?.list?.some((agent) =>
      isBedrockProviderId(agent.memorySearch?.provider),
    ) ?? false
  );
}

/** Memory-core adapter descriptor for Bedrock embeddings. */
export const bedrockMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "bedrock",
  defaultModel: DEFAULT_BEDROCK_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "amazon-bedrock",
  autoSelectPriority: 60,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    if (
      !(await hasAwsCredentials(process.env, undefined, {
        allowImds: shouldAllowAwsImdsCredentialProbe(options),
      }))
    ) {
      throw new Error(
        'No API key found for provider "bedrock". ' +
          "AWS credentials are not available. " +
          "Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK, " +
          "configure an EC2/ECS/EKS role, " +
          "or set agents.defaults.memorySearch.provider to another provider.",
      );
    }
    const { provider, client } = await createBedrockEmbeddingProvider({
      ...options,
      provider: "bedrock",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "bedrock",
        cacheKeyData: {
          provider: "bedrock",
          region: client.region,
          model: client.model,
          dimensions: client.dimensions,
        },
      },
    };
  },
};
