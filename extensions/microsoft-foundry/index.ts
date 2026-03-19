import { execSync, spawn } from "node:child_process";
import { definePluginEntry, type ProviderAuthContext } from "openclaw/plugin-sdk/core";
import {
  applyAuthProfileConfig,
  createProviderApiKeyAuthMethod,
  upsertAuthProfile,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";

const PROVIDER_ID = "microsoft-foundry";
const DEFAULT_API = "openai-completions";
const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function isAzCliInstalled(): boolean {
  try {
    // "az version" works on Windows, Linux, and macOS
    execCmd("az version --output none");
    return true;
  } catch {
    return false;
  }
}

interface AzAccount {
  name: string;
  id: string;
  user?: { name?: string };
  state?: string;
  isDefault?: boolean;
}

function getLoggedInAccount(): AzAccount | null {
  try {
    const raw = execCmd("az account show --output json");
    return JSON.parse(raw) as AzAccount;
  } catch {
    return null;
  }
}

function listSubscriptions(): AzAccount[] {
  const raw = execCmd("az account list --output json --all");
  const subs = JSON.parse(raw) as AzAccount[];
  return subs.filter((s) => s.state === "Enabled");
}

interface AzAccessToken {
  accessToken: string;
  expiresOn?: string;
}

function getAccessTokenResult(): AzAccessToken {
  const raw = execCmd(
    `az account get-access-token --resource ${COGNITIVE_SERVICES_RESOURCE} --output json`,
  );
  return JSON.parse(raw) as AzAccessToken;
}

function buildAzureBaseUrl(endpoint: string, modelId: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (base.includes("/openai/deployments/")) return base;
  return `${base}/openai/deployments/${modelId}`;
}

/**
 * Interactive az login using device-code flow.
 * Spawns az login so terminal output (device code URL) is visible to user.
 */
async function azLoginDeviceCode(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("az", ["login", "--use-device-code"], {
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`az login exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Entra ID auth method
// ---------------------------------------------------------------------------

const entraIdAuthMethod = {
  id: "entra-id",
  label: "Entra ID (az login)",
  hint: "Use your Azure login — no API key needed",
  kind: "custom" as const,
  wizard: {
    choiceId: "microsoft-foundry-entra",
    choiceLabel: "Microsoft Foundry (Entra ID / az login)",
    choiceHint: "Use your Azure login — no API key needed",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    // 1. Check az CLI
    if (!isAzCliInstalled()) {
      throw new Error(
        "Azure CLI (az) is not installed.\n" +
          "Install it from https://learn.microsoft.com/cli/azure/install-azure-cli",
      );
    }

    // 2. Check login status
    let account = getLoggedInAccount();
    if (account) {
      const useExisting = await ctx.prompter.confirm({
        message: `Already logged in as ${account.user?.name ?? "unknown"} (${account.name}). Use this account?`,
        initialValue: true,
      });
      if (!useExisting) {
        await azLoginDeviceCode();
        account = getLoggedInAccount();
        if (!account) throw new Error("Failed to get account after login.");
      }
    } else {
      await ctx.prompter.note(
        "You need to log in to Azure. A device code will be displayed — follow the instructions.",
        "Azure Login",
      );
      await azLoginDeviceCode();
      account = getLoggedInAccount();
      if (!account) throw new Error("Failed to get account after login.");
    }

    // 3. List and select subscription
    const subs = listSubscriptions();
    if (subs.length === 0) {
      throw new Error("No enabled Azure subscriptions found. Please check your Azure account.");
    }

    let selectedSub: AzAccount;
    if (subs.length === 1) {
      selectedSub = subs[0]!;
      await ctx.prompter.note(
        `Using subscription: ${selectedSub.name} (${selectedSub.id})`,
        "Subscription",
      );
    } else {
      const choices = subs.map((s) => ({
        value: s.id,
        label: `${s.name} (${s.id})`,
      }));
      const selectedId = await ctx.prompter.select({
        message: "Select Azure subscription",
        options: choices,
      });
      selectedSub = subs.find((s) => s.id === selectedId)!;
    }

    // 4. Set subscription
    execCmd(`az account set --subscription "${selectedSub.id}"`);

    // 5. Ask endpoint URL
    const endpoint = String(
      await ctx.prompter.text({
        message: "Microsoft Foundry endpoint URL",
        placeholder: "https://xxx.openai.azure.com or https://xxx.services.ai.azure.com",
        validate: (v) => {
          const val = String(v ?? "").trim();
          if (!val) return "Endpoint URL is required";
          try {
            new URL(val);
          } catch {
            return "Invalid URL";
          }
          return undefined;
        },
      }),
    ).trim();

    // 6. Ask model ID
    const modelId = String(
      await ctx.prompter.text({
        message: "Default model/deployment name",
        placeholder: "gpt-4o",
        validate: (v) => {
          const val = String(v ?? "").trim();
          if (!val) return "Model ID is required";
          return undefined;
        },
      }),
    ).trim();

    // 7. Test connection
    try {
      const { accessToken } = getAccessTokenResult();
      const testUrl = `${buildAzureBaseUrl(endpoint, modelId)}/chat/completions?api-version=2024-12-01-preview`;
      const res = await fetch(testUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      });
      if (!res.ok && res.status !== 400) {
        const body = await res.text().catch(() => "");
        await ctx.prompter.note(
          `Warning: test request returned ${res.status}. ${body.slice(0, 200)}\nProceeding anyway — you can fix the endpoint later.`,
          "Connection Test",
        );
      } else {
        await ctx.prompter.note("Connection test successful!", "✓");
      }
    } catch (err) {
      await ctx.prompter.note(
        `Warning: connection test failed: ${String(err)}\nProceeding anyway.`,
        "Connection Test",
      );
    }

    // 8. Build result — store a placeholder key; prepareRuntimeAuth will
    //    replace it with a fresh Entra ID token at request time.
    const profileId = `${PROVIDER_ID}:entra`;

    return {
      profiles: [
        {
          profileId,
          credential: {
            type: "api_key",
            provider: PROVIDER_ID,
            // Placeholder — prepareRuntimeAuth refreshes this dynamically.
            key: "__entra_id_dynamic__",
            metadata: {
              authMethod: "entra-id",
              subscriptionId: selectedSub.id,
              subscriptionName: selectedSub.name,
              endpoint,
            },
          },
        },
      ],
      configPatch: {
        models: {
          providers: {
            [PROVIDER_ID]: {
              baseUrl: buildAzureBaseUrl(endpoint, modelId),
              api: DEFAULT_API,
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_384,
                },
              ],
            },
          },
        },
      },
      defaultModel: `${PROVIDER_ID}/${modelId}`,
      notes: [
        `Subscription: ${selectedSub.name}`,
        `Endpoint: ${endpoint}`,
        `Model: ${modelId}`,
        "Token is refreshed automatically via az CLI — keep az login active.",
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// API Key auth method
// ---------------------------------------------------------------------------

const apiKeyAuthMethod = createProviderApiKeyAuthMethod({
  providerId: PROVIDER_ID,
  methodId: "api-key",
  label: "Azure OpenAI API key",
  hint: "Direct Azure OpenAI API key",
  optionKey: "azureOpenaiApiKey",
  flagName: "--azure-openai-api-key",
  envVar: "AZURE_OPENAI_API_KEY",
  promptMessage: "Enter Azure OpenAI API key",
  defaultModel: `${PROVIDER_ID}/gpt-4o`,
  expectedProviders: [PROVIDER_ID],
  wizard: {
    choiceId: "microsoft-foundry-apikey",
    choiceLabel: "Microsoft Foundry (API key)",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
});

// ---------------------------------------------------------------------------
// Token cache for prepareRuntimeAuth
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

function refreshEntraToken(): { apiKey: string; expiresAt: number } {
  const result = getAccessTokenResult();
  const expiresAt = result.expiresOn
    ? new Date(result.expiresOn).getTime()
    : Date.now() + 55 * 60 * 1000; // default ~55 min
  cachedToken = { token: result.accessToken, expiresAt };
  return { apiKey: result.accessToken, expiresAt };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Microsoft Foundry Provider",
  description: "Microsoft Foundry provider with Entra ID and API key auth",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Microsoft Foundry",
      docsPath: "/providers/azure",
      envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
      auth: [entraIdAuthMethod, apiKeyAuthMethod],
      capabilities: {
        providerFamily: "openai",
      },
      prepareRuntimeAuth: async (ctx) => {
        // Only intercept Entra ID auth (placeholder key).
        // API key users pass through unchanged.
        if (ctx.apiKey !== "__entra_id_dynamic__") {
          return null; // let default handling apply
        }

        // Return cached token if still valid
        if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
          return { apiKey: cachedToken.token, expiresAt: cachedToken.expiresAt };
        }

        // Refresh via az CLI
        try {
          return refreshEntraToken();
        } catch (err) {
          throw new Error(
            `Failed to refresh Azure Entra ID token via az CLI: ${String(err)}\n` +
              "Make sure you are logged in: az login --use-device-code",
          );
        }
      },
    });
  },
});
