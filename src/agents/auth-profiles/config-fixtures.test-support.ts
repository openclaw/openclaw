import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createBedrockAwsSdkConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        "amazon-bedrock": {
          auth: "aws-sdk",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          models: [],
        },
      },
    },
    auth: {
      profiles: {
        "amazon-bedrock:default": {
          provider: "amazon-bedrock",
          mode: "aws-sdk",
        },
      },
    },
  };
}
