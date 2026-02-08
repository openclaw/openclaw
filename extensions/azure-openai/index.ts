import { DefaultAzureCredential } from "@azure/identity";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const PROVIDER_ID = "azure-openai";
const PROVIDER_LABEL = "Azure OpenAI";
const ENV_VARS = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
];

// Common Azure OpenAI model configurations
const AZURE_OPENAI_MODELS = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"] as const,
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
      cacheWrite: 2.5,
    },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    reasoning: false,
    input: ["text", "image"] as const,
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.075,
      cacheWrite: 0.15,
    },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    reasoning: false,
    input: ["text", "image"] as const,
    cost: {
      input: 10,
      output: 30,
      cacheRead: 5,
      cacheWrite: 10,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: "gpt-4",
    name: "GPT-4",
    reasoning: false,
    input: ["text"] as const,
    cost: {
      input: 30,
      output: 60,
      cacheRead: 15,
      cacheWrite: 30,
    },
    contextWindow: 8192,
    maxTokens: 4096,
  },
  {
    id: "gpt-35-turbo",
    name: "GPT-3.5 Turbo",
    reasoning: false,
    input: ["text"] as const,
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0.25,
      cacheWrite: 0.5,
    },
    contextWindow: 16385,
    maxTokens: 4096,
  },
  {
    id: "o1-preview",
    name: "o1 Preview",
    reasoning: true,
    input: ["text"] as const,
    cost: {
      input: 15,
      output: 60,
      cacheRead: 7.5,
      cacheWrite: 15,
    },
    contextWindow: 128000,
    maxTokens: 32768,
  },
  {
    id: "o1-mini",
    name: "o1 Mini",
    reasoning: true,
    input: ["text"] as const,
    cost: {
      input: 3,
      output: 12,
      cacheRead: 1.5,
      cacheWrite: 3,
    },
    contextWindow: 128000,
    maxTokens: 65536,
  },
];

async function getAzureAccessToken(_params: {
  endpoint: string;
  deploymentName?: string;
}): Promise<{ token: string; expires: number }> {
  const credential = new DefaultAzureCredential();

  // Azure OpenAI uses the cognitive services scope
  const scope = "https://cognitiveservices.azure.com/.default";

  const tokenResponse = await credential.getToken(scope);
  if (!tokenResponse) {
    throw new Error("No Azure access token returned (DefaultAzureCredential unavailable)");
  }

  return {
    token: tokenResponse.token,
    expires: tokenResponse.expiresOnTimestamp,
  };
}

const azureOpenAiPlugin = {
  id: "azure-openai",
  name: "Azure OpenAI",
  description: "Azure OpenAI provider with API key and keyless authentication",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["azure"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Use Azure OpenAI API key from environment or paste manually",
          kind: "api_key",
          run: async (ctx) => {
            const endpoint = await ctx.prompter.text({
              message: "Azure OpenAI endpoint URL",
              placeholder: "https://your-resource-name.openai.azure.com",
              validate: (value) => {
                const val = String(value ?? "").trim();
                if (!val) {
                  return "Endpoint URL is required";
                }
                try {
                  new URL(val);
                  return undefined;
                } catch {
                  return "Invalid URL format";
                }
              },
            });

            const deploymentName = await ctx.prompter.text({
              message: "Deployment name (optional, can be configured per model)",
              placeholder: "gpt-4o",
            });

            const apiKey = await ctx.prompter.text({
              message: "Paste Azure OpenAI API key",
              validate: (value) => {
                const val = String(value ?? "").trim();
                return val ? undefined : "API key is required";
              },
            });

            const endpointUrl = String(endpoint).trim();
            const apiKeyStr = String(apiKey).trim();
            const deploymentNameStr = String(deploymentName ?? "").trim();

            const profileId = `azure-openai:${new URL(endpointUrl).hostname}`;

            // Build base URL with deployment if provided
            let baseUrl = endpointUrl;
            if (deploymentNameStr) {
              baseUrl = `${endpointUrl}/openai/deployments/${deploymentNameStr}`;
            }

            return {
              profiles: [
                {
                  profileId,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: apiKeyStr,
                    metadata: {
                      endpoint: endpointUrl,
                      deploymentName: deploymentNameStr || undefined,
                    },
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      api: "openai-completions" as const,
                      apiKey: `profile:${profileId}`,
                      headers: {
                        "api-key": `profile:${profileId}`,
                      },
                      models: AZURE_OPENAI_MODELS,
                    },
                  },
                },
              },
              defaultModel: `${PROVIDER_ID}/gpt-4o`,
              notes: [
                "Azure OpenAI requires a deployment for each model.",
                "Configure deployment names in your models.json if needed.",
                "API version is managed automatically by the OpenAI SDK.",
              ],
            };
          },
        },
        {
          id: "keyless",
          label: "Keyless (DefaultAzureCredential)",
          hint: "Use Azure managed identity or service principal",
          kind: "custom",
          run: async (ctx) => {
            const endpoint = await ctx.prompter.text({
              message: "Azure OpenAI endpoint URL",
              placeholder: "https://your-resource-name.openai.azure.com",
              validate: (value) => {
                const val = String(value ?? "").trim();
                if (!val) {
                  return "Endpoint URL is required";
                }
                try {
                  new URL(val);
                  return undefined;
                } catch {
                  return "Invalid URL format";
                }
              },
            });

            const deploymentName = await ctx.prompter.text({
              message: "Deployment name (optional, can be configured per model)",
              placeholder: "gpt-4o",
            });

            const endpointUrl = String(endpoint).trim();
            const deploymentNameStr = String(deploymentName ?? "").trim();

            const spin = ctx.prompter.progress("Acquiring Azure credentials…");
            try {
              // Test the credentials by getting a token
              const result = await getAzureAccessToken({
                endpoint: endpointUrl,
                deploymentName: deploymentNameStr,
              });

              spin.stop("Azure credentials acquired successfully");

              const profileId = `azure-openai:${new URL(endpointUrl).hostname}`;

              // Build base URL with deployment if provided
              let baseUrl = endpointUrl;
              if (deploymentNameStr) {
                baseUrl = `${endpointUrl}/openai/deployments/${deploymentNameStr}`;
              }

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: result.token,
                      refresh: "", // Refresh handled by DefaultAzureCredential
                      expires: result.expires,
                      metadata: {
                        endpoint: endpointUrl,
                        deploymentName: deploymentNameStr || undefined,
                        useKeyless: true,
                      },
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        api: "openai-completions" as const,
                        auth: "token" as const,
                        models: AZURE_OPENAI_MODELS,
                      },
                    },
                  },
                },
                defaultModel: `${PROVIDER_ID}/gpt-4o`,
                notes: [
                  "Keyless authentication uses DefaultAzureCredential.",
                  "Supports managed identity, service principal, and Azure CLI credentials.",
                  "Tokens are refreshed automatically.",
                  "Ensure your Azure identity has 'Cognitive Services OpenAI User' role.",
                ],
              };
            } catch (err) {
              spin.stop("Failed to acquire Azure credentials");
              const errorMessage = [
                `Azure authentication failed: ${String(err)}`,
                "",
                "Ensure you have:",
                "1. Azure CLI installed and logged in (az login), OR",
                "2. Service principal credentials set (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID), OR",
                "3. Managed identity configured on your Azure resource",
              ].join("\n");
              throw new Error(errorMessage, { cause: err });
            }
          },
        },
      ],
      refreshOAuth: async (cred) => {
        // Only refresh if using keyless authentication
        if (cred.metadata?.useKeyless) {
          const endpoint = String(cred.metadata?.endpoint ?? "");
          const deploymentName = cred.metadata?.deploymentName
            ? String(cred.metadata.deploymentName)
            : undefined;

          const result = await getAzureAccessToken({ endpoint, deploymentName });

          return {
            ...cred,
            access: result.token,
            expires: result.expires,
          };
        }
        return cred;
      },
    });
  },
};

export default azureOpenAiPlugin;
