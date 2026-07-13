/**
 * Memory embedding adapter for Amazon Bedrock. It exposes Bedrock embeddings to
 * the memory-core engine and verifies AWS credentials before auto-selection.
 */
import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createBedrockEmbeddingProvider,
  DEFAULT_BEDROCK_EMBEDDING_MODEL,
  hasAwsCredentials,
} from "./embedding-provider.js";

type ConfiguredModelProvider = NonNullable<
  NonNullable<MemoryEmbeddingProviderCreateOptions["config"]["models"]>["providers"]
>[string];

// Match OpenClaw's normalized provider-id lookup so alias keys like My-Bedrock
// still resolve when callers pass my-bedrock through memory provider routing.
function readConfiguredProviderEntry(
  providers: Record<string, ConfiguredModelProvider> | undefined,
  providerId: string,
): ConfiguredModelProvider | undefined {
  if (!providers) {
    return undefined;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [key, value] of Object.entries(providers)) {
    if (normalizeProviderId(key) === normalized) {
      return value;
    }
  }
  return undefined;
}

// A memory provider id resolves to Bedrock when it is the literal id "bedrock"
// or when it is a configured provider alias whose `api` adapter is the Bedrock
// runtime api ("bedrock-converse-stream", see ModelApi). Both shapes must allow
// the AWS SDK default credential chain, or an explicit alias setup loses
// IMDS/shared-config/SSO resolution that the literal id keeps.
function resolvesToBedrock(
  config: MemoryEmbeddingProviderCreateOptions["config"],
  providerId: unknown,
): boolean {
  if (typeof providerId !== "string" || providerId.trim() === "") {
    return false;
  }
  if (normalizeProviderId(providerId) === "bedrock") {
    return true;
  }
  return (
    readConfiguredProviderEntry(config.models?.providers, providerId)?.api ===
    "bedrock-converse-stream"
  );
}

function shouldAllowAwsImdsCredentialProbe(options: MemoryEmbeddingProviderCreateOptions): boolean {
  if (resolvesToBedrock(options.config, options.provider)) {
    return true;
  }
  if (resolvesToBedrock(options.config, options.config.agents?.defaults?.memorySearch?.provider)) {
    return true;
  }
  return (
    options.config.agents?.list?.some((agent) =>
      resolvesToBedrock(options.config, agent.memorySearch?.provider),
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
