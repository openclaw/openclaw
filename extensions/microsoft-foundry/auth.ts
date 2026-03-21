import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/core";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  ensureAuthProfileStore,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type SecretInput,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { getLoggedInAccount, isAzCliInstalled } from "./cli.js";
import {
  buildFoundryAuthResult,
  PROVIDER_ID,
  resolveConfiguredModelNameHint,
} from "./shared.js";
import {
  loginWithTenantFallback,
  promptApiKeyEndpointAndModel,
  promptEndpointAndModelManually,
  promptTenantId,
  selectFoundryDeployment,
  selectFoundryResource,
  listSubscriptions,
  testFoundryConnection,
} from "./onboard.js";

export const entraIdAuthMethod: ProviderAuthMethod = {
  id: "entra-id",
  label: "Entra ID (az login)",
  hint: "Use your Azure login - no API key needed",
  kind: "custom",
  wizard: {
    choiceId: "microsoft-foundry-entra",
    choiceLabel: "Microsoft Foundry (Entra ID / az login)",
    choiceHint: "Use your Azure login - no API key needed",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    if (!isAzCliInstalled()) {
      throw new Error(
        "Azure CLI (az) is not installed.\nInstall it from https://learn.microsoft.com/cli/azure/install-azure-cli",
      );
    }

    let account = getLoggedInAccount();
    let tenantId = account?.tenantId;
    if (account) {
      const useExisting = await ctx.prompter.confirm({
        message: `Already logged in as ${account.user?.name ?? "unknown"} (${account.name}). Use this account?`,
        initialValue: true,
      });
      if (!useExisting) {
        const loginResult = await loginWithTenantFallback(ctx);
        account = loginResult.account;
        tenantId = loginResult.tenantId ?? loginResult.account?.tenantId;
      }
    } else {
      await ctx.prompter.note(
        "You need to log in to Azure. A device code will be displayed - follow the instructions.",
        "Azure Login",
      );
      const loginResult = await loginWithTenantFallback(ctx);
      account = loginResult.account;
      tenantId = loginResult.tenantId ?? loginResult.account?.tenantId;
    }

    const subs = listSubscriptions();
    let selectedSub = null;
    if (subs.length === 0) {
      tenantId ??= await promptTenantId(ctx, {
        required: true,
        reason: "No enabled Azure subscriptions were found. Continue with tenant-scoped Entra ID auth instead.",
      });
      await ctx.prompter.note(`Continuing with tenant-scoped auth (${tenantId}).`, "Azure Tenant");
    } else if (subs.length === 1) {
      selectedSub = subs[0]!;
      tenantId ??= selectedSub.tenantId;
      await ctx.prompter.note(
        `Using subscription: ${selectedSub.name} (${selectedSub.id})`,
        "Subscription",
      );
    } else {
      const selectedId = await ctx.prompter.select({
        message: "Select Azure subscription",
        options: subs.map((sub) => ({
          value: sub.id,
          label: `${sub.name} (${sub.id})`,
        })),
      });
      selectedSub = subs.find((sub) => sub.id === selectedId)!;
      tenantId ??= selectedSub.tenantId;
    }

    let endpoint: string;
    let modelId: string;
    let modelNameHint: string | undefined;
    if (selectedSub) {
      const useDiscoveredResource = await ctx.prompter.confirm({
        message: "Discover Microsoft Foundry resources from this subscription?",
        initialValue: true,
      });
      if (useDiscoveredResource) {
        const selectedResource = await selectFoundryResource(ctx, selectedSub);
        const selectedDeployment = await selectFoundryDeployment(ctx, selectedResource, selectedSub.id);
        endpoint = selectedResource.endpoint;
        modelId = selectedDeployment.name;
        modelNameHint = resolveConfiguredModelNameHint(modelId, selectedDeployment.modelName);
        await ctx.prompter.note(
          [
            `Resource: ${selectedResource.accountName}`,
            `Endpoint: ${endpoint}`,
            `Deployment: ${modelId}`,
            selectedDeployment.modelName ? `Model: ${selectedDeployment.modelName}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          "Microsoft Foundry",
        );
      } else {
        ({ endpoint, modelId, modelNameHint } = await promptEndpointAndModelManually(ctx));
      }
    } else {
      ({ endpoint, modelId, modelNameHint } = await promptEndpointAndModelManually(ctx));
    }

    await testFoundryConnection({
      ctx,
      endpoint,
      modelId,
      modelNameHint,
      subscriptionId: selectedSub?.id,
      tenantId,
    });

    return buildFoundryAuthResult({
      profileId: `${PROVIDER_ID}:entra`,
      apiKey: "__entra_id_dynamic__",
      endpoint,
      modelId,
      modelNameHint,
      authMethod: "entra-id",
      ...(selectedSub?.id ? { subscriptionId: selectedSub.id } : {}),
      ...(selectedSub?.name ? { subscriptionName: selectedSub.name } : {}),
      ...(tenantId ? { tenantId } : {}),
      notes: [
        ...(selectedSub?.name ? [`Subscription: ${selectedSub.name}`] : []),
        ...(tenantId ? [`Tenant: ${tenantId}`] : []),
        `Endpoint: ${endpoint}`,
        `Model: ${modelId}`,
        "Token is refreshed automatically via az CLI - keep az login active.",
      ],
    });
  },
};

export const apiKeyAuthMethod: ProviderAuthMethod = {
  id: "api-key",
  label: "Azure OpenAI API key",
  hint: "Direct Azure OpenAI API key",
  kind: "api_key",
  wizard: {
    choiceId: "microsoft-foundry-apikey",
    choiceLabel: "Microsoft Foundry (API key)",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
  run: async (ctx) => {
    const authStore = ensureAuthProfileStore(ctx.agentDir, {
      allowKeychainPrompt: false,
    });
    const existing = authStore.profiles[`${PROVIDER_ID}:default`];
    const existingMetadata = existing?.type === "api_key" ? existing.metadata : undefined;
    let capturedSecretInput: SecretInput | undefined;
    let capturedCredential = false;
    let capturedMode: "plaintext" | "ref" | undefined;
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: normalizeOptionalSecretInput(ctx.opts?.azureOpenaiApiKey),
      tokenProvider: PROVIDER_ID,
      secretInputMode:
        ctx.allowSecretRefPrompt === false ? (ctx.secretInputMode ?? "plaintext") : ctx.secretInputMode,
      config: ctx.config,
      expectedProviders: [PROVIDER_ID],
      provider: PROVIDER_ID,
      envLabel: "AZURE_OPENAI_API_KEY",
      promptMessage: "Enter Azure OpenAI API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: ctx.prompter,
      setCredential: async (apiKey, mode) => {
        capturedSecretInput = apiKey;
        capturedCredential = true;
        capturedMode = mode;
      },
    });
    if (!capturedCredential) {
      throw new Error("Missing Azure OpenAI API key.");
    }
    const selection = await promptApiKeyEndpointAndModel(ctx);
    return buildFoundryAuthResult({
      profileId: `${PROVIDER_ID}:default`,
      apiKey: capturedSecretInput ?? "",
      ...(capturedMode ? { secretInputMode: capturedMode } : {}),
      endpoint: selection.endpoint,
      modelId: selection.modelId,
      modelNameHint:
        selection.modelNameHint ?? existingMetadata?.modelName ?? existingMetadata?.modelId,
      authMethod: "api-key",
      notes: [`Endpoint: ${selection.endpoint}`, `Model: ${selection.modelId}`],
    });
  },
};
