import type { SecretContract } from "openclaw/plugin-sdk/secret-contract";

export const channelSecrets: SecretContract = {
  // Define secrets that need to be configured
  secrets: [
    {
      key: "apiKey",
      name: "API Key",
      description: "Your Agent P2P Portal API Key",
      required: true,
      sensitive: true,
    },
  ],
  
  // Validate secrets
  validateSecrets(secrets) {
    if (!secrets.apiKey) {
      return { valid: false, error: "API Key is required" };
    }
    return { valid: true };
  },
};
