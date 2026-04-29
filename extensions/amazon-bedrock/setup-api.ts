import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type {
  BedrockAuthConfig,
  BedrockAuthenticationMode,
  LegacyBedrockOptions,
  ReasoningEffort,
} from './bedrock-auth-config.js';
import { migrateAmazonBedrockLegacyConfig } from './config-api.js';
import { resolveBedrockConfigApiKey } from './discovery-shared.js';

export type { BedrockAuthConfig, BedrockAuthenticationMode, LegacyBedrockOptions, ReasoningEffort };

/**
 * Alias for BedrockAuthConfig used by setup/onboarding surfaces that build a
 * Bedrock provider from declared config before the runtime resolver runs.
 */
export type BedrockSetupOptions = BedrockAuthConfig;

export default definePluginEntry({
  id: 'amazon-bedrock',
  name: 'Amazon Bedrock Setup',
  description: 'Lightweight Amazon Bedrock setup hooks',
  register(api) {
    api.registerProvider({
      id: 'amazon-bedrock',
      label: 'Amazon Bedrock',
      auth: [],
      resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
    });
    api.registerConfigMigration((config) => migrateAmazonBedrockLegacyConfig(config));
  },
});
