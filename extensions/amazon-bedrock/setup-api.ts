/**
 * Lightweight Amazon Bedrock setup entry. It exposes auth detection and config
 * migration hooks without loading runtime streaming or AWS discovery code.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import { migrateAmazonBedrockLegacyConfig } from "./config-api.js";

export default definePluginEntry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock Setup",
  description: "Lightweight Amazon Bedrock setup hooks",
  register(api) {
    api.registerProvider({
      id: "amazon-bedrock",
      label: "Amazon Bedrock",
      auth: [],
      resolveConfigApiKey: ({ env }) => resolveAwsSdkEnvVarName(env),
    });
    api.registerConfigMigration((config) => migrateAmazonBedrockLegacyConfig(config));
  },
});
