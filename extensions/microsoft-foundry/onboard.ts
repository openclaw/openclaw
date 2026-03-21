import type { ProviderAuthContext } from "openclaw/plugin-sdk/core";
import {
  azLoginDeviceCode,
  azLoginDeviceCodeWithOptions,
  execAz,
  getAccessTokenResult,
  getLoggedInAccount,
  listSubscriptions,
} from "./cli.js";
import {
  type AzAccount,
  type AzCognitiveAccount,
  type AzDeploymentSummary,
  type FoundryResourceOption,
  type FoundrySelection,
  buildFoundryProviderBaseUrl,
  normalizeEndpointOrigin,
  resolveConfiguredModelNameHint,
  resolveFoundryApi,
  DEFAULT_GPT5_API,
} from "./shared.js";

export { listSubscriptions } from "./cli.js";

export function listFoundryResources(subscriptionId?: string): FoundryResourceOption[] {
  try {
    const accounts = JSON.parse(
      execAz([
        "cognitiveservices",
        "account",
        "list",
        ...(subscriptionId ? ["--subscription", subscriptionId] : []),
        "--query",
        "[].{id:id,name:name,kind:kind,location:location,resourceGroup:resourceGroup,endpoint:properties.endpoint,customSubdomain:properties.customSubDomainName,projects:properties.associatedProjects}",
        "--output",
        "json",
      ]),
    ) as AzCognitiveAccount[];
    const resources: FoundryResourceOption[] = [];
    for (const account of accounts) {
      if (!account.resourceGroup) {
        continue;
      }
      if (account.kind === "OpenAI") {
        const endpoint = normalizeEndpointOrigin(account.endpoint);
        if (!endpoint) {
          continue;
        }
        resources.push({
          id: account.id,
          accountName: account.name,
          kind: "OpenAI",
          location: account.location,
          resourceGroup: account.resourceGroup,
          endpoint,
          projects: [],
        });
        continue;
      }
      if (account.kind !== "AIServices") {
        continue;
      }
      const endpoint = account.customSubdomain?.trim()
        ? `https://${account.customSubdomain.trim()}.services.ai.azure.com`
        : undefined;
      if (!endpoint) {
        continue;
      }
      resources.push({
        id: account.id,
        accountName: account.name,
        kind: "AIServices",
        location: account.location,
        resourceGroup: account.resourceGroup,
        endpoint,
        projects: Array.isArray(account.projects)
          ? account.projects.filter((project): project is string => typeof project === "string")
          : [],
      });
    }
    return resources;
  } catch {
    return [];
  }
}

export function listResourceDeployments(
  resource: FoundryResourceOption,
  subscriptionId?: string,
): AzDeploymentSummary[] {
  try {
    const deployments = JSON.parse(
      execAz([
        "cognitiveservices",
        "account",
        "deployment",
        "list",
        ...(subscriptionId ? ["--subscription", subscriptionId] : []),
        "-g",
        resource.resourceGroup,
        "-n",
        resource.accountName,
        "--query",
        "[].{name:name,modelName:properties.model.name,modelVersion:properties.model.version,state:properties.provisioningState,sku:sku.name}",
        "--output",
        "json",
      ]),
    ) as AzDeploymentSummary[];
    return deployments.filter((deployment) => deployment.state === "Succeeded");
  } catch {
    return [];
  }
}

export function buildCreateFoundryHint(selectedSub: AzAccount): string {
  return [
    `No Azure AI Foundry or Azure OpenAI resources were found in subscription ${selectedSub.name} (${selectedSub.id}).`,
    "Create one in Azure AI Foundry or Azure Portal, then rerun onboard.",
    "Azure AI Foundry: https://ai.azure.com",
    "Azure OpenAI docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource",
  ].join("\n");
}

export async function selectFoundryResource(
  ctx: ProviderAuthContext,
  selectedSub: AzAccount,
): Promise<FoundryResourceOption> {
  const resources = listFoundryResources(selectedSub.id);
  if (resources.length === 0) {
    throw new Error(buildCreateFoundryHint(selectedSub));
  }
  if (resources.length === 1) {
    const only = resources[0]!;
    await ctx.prompter.note(
      `Using ${only.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"} resource: ${only.accountName}`,
      "Foundry Resource",
    );
    return only;
  }
  const selectedResourceId = await ctx.prompter.select({
    message: "Select Azure AI Foundry / Azure OpenAI resource",
    options: resources.map((resource) => ({
      value: resource.id,
      label: `${resource.accountName} (${resource.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"}${resource.location ? `, ${resource.location}` : ""})`,
      hint: [
        `RG: ${resource.resourceGroup}`,
        resource.projects.length > 0 ? `${resource.projects.length} project(s)` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    })),
  });
  return resources.find((resource) => resource.id === selectedResourceId) ?? resources[0]!;
}

export async function selectFoundryDeployment(
  ctx: ProviderAuthContext,
  resource: FoundryResourceOption,
  subscriptionId?: string,
): Promise<AzDeploymentSummary> {
  const deployments = listResourceDeployments(resource, subscriptionId);
  if (deployments.length === 0) {
    throw new Error(
      [
        `No model deployments were found in ${resource.accountName}.`,
        "Deploy a model in Azure AI Foundry or Azure OpenAI, then rerun onboard.",
      ].join("\n"),
    );
  }
  if (deployments.length === 1) {
    const only = deployments[0]!;
    await ctx.prompter.note(`Using deployment: ${only.name}`, "Model Deployment");
    return only;
  }
  const selectedDeploymentName = await ctx.prompter.select({
    message: "Select model deployment",
    options: deployments.map((deployment) => ({
      value: deployment.name,
      label: deployment.name,
      hint: [deployment.modelName, deployment.modelVersion, deployment.sku].filter(Boolean).join(" | "),
    })),
  });
  return deployments.find((deployment) => deployment.name === selectedDeploymentName) ?? deployments[0]!;
}

export async function promptEndpointAndModelManually(
  ctx: ProviderAuthContext,
): Promise<FoundrySelection> {
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
  const modelNameHintInput = String(
    await ctx.prompter.text({
      message: "Underlying Azure model family (optional)",
      initialValue: modelId,
      placeholder: "gpt-5.4, gpt-4o, etc.",
    }),
  ).trim();
  return {
    endpoint,
    modelId,
    modelNameHint: modelNameHintInput || modelId,
  };
}

export async function promptApiKeyEndpointAndModel(ctx: ProviderAuthContext): Promise<FoundrySelection> {
  const endpoint = String(
    await ctx.prompter.text({
      message: "Microsoft Foundry endpoint URL",
      placeholder: "https://xxx.openai.azure.com or https://xxx.services.ai.azure.com",
      initialValue: process.env.AZURE_OPENAI_ENDPOINT,
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
  const modelId = String(
    await ctx.prompter.text({
      message: "Default model/deployment name",
      initialValue: "gpt-4o",
      validate: (v) => {
        const val = String(v ?? "").trim();
        if (!val) return "Model ID is required";
        return undefined;
      },
    }),
  ).trim();
  const modelNameHintInput = String(
    await ctx.prompter.text({
      message: "Underlying Azure model family (optional)",
      initialValue: modelId,
      placeholder: "gpt-5.4, gpt-4o, etc.",
    }),
  ).trim();
  return {
    endpoint,
    modelId,
    modelNameHint: modelNameHintInput || modelId,
  };
}

export function buildFoundryConnectionTest(params: {
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
}): { url: string; body: Record<string, unknown> } {
  const baseUrl = buildFoundryProviderBaseUrl(params.endpoint, params.modelId, params.modelNameHint);
  if (resolveFoundryApi(params.modelId, params.modelNameHint) === DEFAULT_GPT5_API) {
    return {
      url: `${baseUrl}/responses?api-version=2025-04-01-preview`,
      body: {
        model: params.modelId,
        input: "hi",
        max_output_tokens: 1,
      },
    };
  }
  return {
    url: `${baseUrl}/chat/completions?api-version=2024-12-01-preview`,
    body: {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    },
  };
}

export function extractTenantSuggestions(rawMessage: string): Array<{ id: string; label?: string }> {
  const suggestions: Array<{ id: string; label?: string }> = [];
  const seen = new Set<string>();
  const regex = /([0-9a-fA-F-]{36})(?:\s+'([^'\r\n]+)')?/g;
  for (const match of rawMessage.matchAll(regex)) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    suggestions.push({
      id,
      ...(match[2]?.trim() ? { label: match[2].trim() } : {}),
    });
  }
  return suggestions;
}

export function isValidTenantIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const isTenantUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    trimmed,
  );
  const isTenantDomain =
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
      trimmed,
    );
  return isTenantUuid || isTenantDomain;
}

export async function promptTenantId(
  ctx: ProviderAuthContext,
  params?: {
    suggestions?: Array<{ id: string; label?: string }>;
    required?: boolean;
    reason?: string;
  },
): Promise<string | undefined> {
  const suggestionLines =
    params?.suggestions && params.suggestions.length > 0
      ? params.suggestions.map((entry) => `- ${entry.id}${entry.label ? ` (${entry.label})` : ""}`)
      : [];
  if (params?.reason || suggestionLines.length > 0) {
    await ctx.prompter.note(
      [
        params?.reason,
        suggestionLines.length > 0 ? "Suggested tenants:" : undefined,
        ...suggestionLines,
      ]
        .filter(Boolean)
        .join("\n"),
      "Azure Tenant",
    );
  }
  const tenantId = String(
    await ctx.prompter.text({
      message: params?.required ? "Azure tenant ID" : "Azure tenant ID (optional)",
      placeholder: params?.suggestions?.[0]?.id ?? "00000000-0000-0000-0000-000000000000",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return params?.required ? "Tenant ID is required" : undefined;
        }
        return isValidTenantIdentifier(trimmed) ? undefined : "Enter a valid tenant ID or tenant domain";
      },
    }),
  ).trim();
  return tenantId || undefined;
}

export async function loginWithTenantFallback(
  ctx: ProviderAuthContext,
): Promise<{ account: AzAccount | null; tenantId?: string }> {
  try {
    await azLoginDeviceCode();
    return { account: getLoggedInAccount() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAzureTenantError =
      /AADSTS\d+/i.test(message) ||
      /no subscriptions found/i.test(message) ||
      /Please provide a valid tenant/i.test(message) ||
      /tenant.*not found/i.test(message);
    if (!isAzureTenantError) {
      throw error;
    }
    const tenantId = await promptTenantId(ctx, {
      suggestions: extractTenantSuggestions(message),
      required: true,
      reason:
        "Azure login needs a tenant-scoped retry. This often happens when your tenant requires MFA or your account has no Azure subscriptions.",
    });
    await azLoginDeviceCodeWithOptions({
      tenantId,
      allowNoSubscriptions: true,
    });
    return {
      account: getLoggedInAccount(),
      tenantId,
    };
  }
}

export async function testFoundryConnection(params: {
  ctx: ProviderAuthContext;
  endpoint: string;
  modelId: string;
  modelNameHint?: string;
  subscriptionId?: string;
  tenantId?: string;
}): Promise<void> {
  try {
    const { accessToken } = getAccessTokenResult({
      subscriptionId: params.subscriptionId,
      tenantId: params.tenantId,
    });
    const testRequest = buildFoundryConnectionTest({
      endpoint: params.endpoint,
      modelId: params.modelId,
      modelNameHint: params.modelNameHint,
    });
    const res = await fetch(testRequest.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testRequest.body),
    });
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      await params.ctx.prompter.note(
        `Endpoint is reachable but returned 400 Bad Request - check your deployment name and API version.\n${body.slice(0, 200)}`,
        "Connection Test",
      );
    } else if (!res.ok) {
      const body = await res.text().catch(() => "");
      await params.ctx.prompter.note(
        `Warning: test request returned ${res.status}. ${body.slice(0, 200)}\nProceeding anyway - you can fix the endpoint later.`,
        "Connection Test",
      );
    } else {
      await params.ctx.prompter.note("Connection test successful!", "✓");
    }
  } catch (err) {
    await params.ctx.prompter.note(
      `Warning: connection test failed: ${String(err)}\nProceeding anyway.`,
      "Connection Test",
    );
  }
}
