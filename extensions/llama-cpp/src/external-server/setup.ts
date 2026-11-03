import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromEnvOrPrompt,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { upsertAuthProfileWithLockOrThrow } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  removeAuthProfileConfig,
  removeProviderAuthProfilesWithLock,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  type ModelProviderConfig,
  selectPreferredLocalModelId,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyProviderDefaultModel } from "openclaw/plugin-sdk/provider-setup";
import { buildLlamaCppAuthProfileRemovalPatch } from "../auth-config.js";
import { hasLlamaServerAuthorizationHeader } from "./auth-policy.js";
import { resolveLlamaServerProviderHeaders, resolveLlamaServerRuntimeApiKey } from "./auth.js";
import { LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";
import { discoverLlamaServer, type LlamaServerDiscoveryResult } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

function selectSetupModelId(discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>) {
  const candidates = discovery.models.filter((model) => !model.failed);
  const ready = candidates.filter(
    (model) => model.status === "loaded" || model.status === "sleeping",
  );
  const ids = (ready.length > 0 ? ready : candidates).map((model) => model.config.id);
  return selectPreferredLocalModelId(ids) ?? ids[0];
}

function describeDiscoveryFailure(
  result: Exclude<LlamaServerDiscoveryResult, { kind: "success" }>,
  server: LlamaServerIdentity,
): string {
  const label = server.id === LLAMA_CPP_SERVER.id ? "llama-server" : server.label;
  switch (result.kind) {
    case "unreachable":
      return `${label} could not be reached at ${result.endpoint.origin}.`;
    case "http-error":
      return `${label} returned HTTP ${result.status} for ${result.path} at ${result.endpoint.origin}.`;
    case "invalid-response":
      return `${label} returned an invalid response from ${result.path} at ${result.endpoint.origin}.`;
    default:
      throw new Error("Unexpected llama-server discovery result");
  }
}

function stripAuthOverrides(
  provider: ModelProviderConfig | undefined,
  removeAuthorization: boolean,
): ModelProviderConfig | undefined {
  if (!provider) {
    return provider;
  }
  const headers = removeAuthorization
    ? stripAuthorizationHeader(provider.headers)
    : provider.headers;
  return {
    ...provider,
    auth: undefined,
    apiKey: undefined,
    ...(removeAuthorization ? { headers } : {}),
  };
}

function stripEndpointCredentials(
  provider: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  if (!provider) {
    return undefined;
  }
  const { localService: _localService, ...external } = provider;
  if (!provider.localService) {
    return { ...external, auth: undefined, apiKey: undefined, headers: undefined };
  }
  const {
    auth: _auth,
    apiKey: _apiKey,
    headers: _headers,
    localService: _managedService,
    models: _managedModels,
    params: managedParams,
    timeoutSeconds: _managedTimeout,
    ...externalProvider
  } = provider;
  const { modelCacheDir: _modelCacheDir, ...params } = managedParams ?? {};
  return {
    ...externalProvider,
    models: [],
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

function hasEndpointChanged(
  provider: ModelProviderConfig | undefined,
  baseUrl: string,
  server: LlamaServerIdentity,
): boolean {
  if (!provider) {
    return false;
  }
  const configuredBaseUrl = provider.baseUrl ?? server.defaultOrigin;
  return (
    resolveLlamaServerEndpoint(configuredBaseUrl, server).inferenceBaseUrl !==
    resolveLlamaServerEndpoint(baseUrl, server).inferenceBaseUrl
  );
}

function stripLlamaServerEndpointAuth(
  config: OpenClawConfig,
  server: LlamaServerIdentity,
): OpenClawConfig {
  const withoutProfile = removeAuthProfileConfig(config, `${server.id}:default`);
  const provider = withoutProfile.models?.providers?.[server.id];
  const endpointSafeProvider = stripEndpointCredentials(provider);
  if (!endpointSafeProvider) {
    return withoutProfile;
  }
  return {
    ...withoutProfile,
    models: {
      ...withoutProfile.models,
      providers: {
        ...withoutProfile.models?.providers,
        [server.id]: endpointSafeProvider,
      },
    },
  };
}

type AuthPersistence<T> =
  | { kind: "preserve" }
  | { kind: "upsert"; credential: T }
  | { kind: "remove" };

function stripAuthorizationHeader<T>(
  headers: Record<string, T> | undefined,
): Record<string, T> | undefined {
  const filtered = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildExistingProviderConfig(
  params: {
    config: OpenClawConfig;
    discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
    resetEndpoint: boolean;
    persistence: AuthPersistence<unknown>;
  },
  server: LlamaServerIdentity,
): ModelProviderConfig {
  const configured = params.config.models?.providers?.[server.id];
  const endpointSafe = params.resetEndpoint ? stripEndpointCredentials(configured) : configured;
  const existing =
    params.persistence.kind === "preserve"
      ? endpointSafe
      : stripAuthOverrides(endpointSafe, params.persistence.kind === "upsert");
  return buildLlamaServerProviderConfig({
    server,
    configured: {
      ...existing,
      baseUrl: params.discovery.endpoint.inferenceBaseUrl,
      models: existing?.models ?? [],
    },
    discoveredModels: params.discovery.models,
  });
}

function buildSetupResult(
  params: {
    config: OpenClawConfig;
    discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
    modelId: string;
    resetEndpoint: boolean;
    persistence: AuthPersistence<SecretInput>;
  },
  server: LlamaServerIdentity,
): ProviderAuthResult {
  return {
    profiles:
      params.persistence.kind === "upsert"
        ? [
            {
              profileId: `${server.id}:default`,
              credential: buildApiKeyCredential(
                server.id,
                params.persistence.credential,
                undefined,
                { config: params.config },
              ),
            },
          ]
        : [],
    defaultModel: `${server.id}/${params.modelId}`,
    configPatch: {
      ...(params.persistence.kind === "remove"
        ? buildLlamaCppAuthProfileRemovalPatch(params.config, `${server.id}:default`)
        : {}),
      models: {
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [server.id]: buildExistingProviderConfig(params, server),
        },
      },
    },
  };
}

async function removeDefaultAuthProfile(
  config: OpenClawConfig,
  agentDir: string | undefined,
  server: LlamaServerIdentity,
): Promise<void> {
  const updated = await removeProviderAuthProfilesWithLock({
    cfg: config,
    agentDir,
    provider: server.id,
    profileIds: [`${server.id}:default`],
  });
  if (!updated) {
    throw new Error(
      "Failed to remove the previous llama-server auth profile; wait a moment and retry.",
    );
  }
}

async function discoverForSetup(
  ctx: ProviderAppGuidedSetupContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<Extract<LlamaServerDiscoveryResult, { kind: "success" }> | null> {
  const provider = ctx.config.models?.providers?.[server.id];
  if (provider?.localService) {
    return null;
  }
  try {
    const headers = await resolveLlamaServerProviderHeaders({
      server,
      config: ctx.config,
      env: ctx.env,
      headers: provider?.headers,
    });
    const apiKey = !hasLlamaServerAuthorizationHeader(headers)
      ? await resolveLlamaServerRuntimeApiKey({
          server,
          config: ctx.config,
        })
      : undefined;
    const discovery = await discoverLlamaServer({
      server,
      baseUrl: provider?.baseUrl ?? server.defaultOrigin,
      apiKey,
      headers,
      allowPrivateNetwork: provider?.request?.allowPrivateNetwork,
      signal: ctx.signal,
      useRuntimeDefaults: false,
    });
    return discovery.kind === "success" ? discovery : null;
  } catch {
    return null;
  }
}

/** Read-only discovery for the guided local-provider setup ladder. */
export async function detectLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<{ modelRef: string; detail?: string } | null> {
  const discovery = await discoverForSetup(ctx, server);
  if (!discovery) {
    return null;
  }
  const modelId = selectSetupModelId(discovery);
  if (!modelId) {
    return null;
  }
  return {
    modelRef: `${server.id}/${modelId}`,
    detail: `${modelId} at ${discovery.endpoint.origin}`,
  };
}

/** Rechecks one guided candidate and returns the config needed for a live probe. */
export async function prepareLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<ProviderAuthResult | null> {
  const discovery = await discoverForSetup(ctx, server);
  if (!discovery) {
    return null;
  }
  const prefix = `${server.id}/`;
  const modelId = ctx.modelRef.startsWith(prefix) ? ctx.modelRef.slice(prefix.length) : "";
  if (!modelId || !discovery.models.some((model) => model.config.id === modelId)) {
    return null;
  }
  return buildSetupResult(
    {
      config: ctx.config,
      discovery,
      modelId,
      resetEndpoint: false,
      persistence: { kind: "preserve" },
    },
    server,
  );
}

export async function runLlamaServerSetup(
  ctx: ProviderAuthContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[server.id];
  const serverName = server.id === LLAMA_CPP_SERVER.id ? "llama-server" : `${server.label} server`;
  const baseUrl = await ctx.prompter.text({
    message: `${server.label} URL`,
    // Prefill only a saved URL: a prefilled default makes typed input append to it.
    initialValue: existing?.baseUrl
      ? resolveLlamaServerEndpoint(existing.baseUrl, server).origin
      : undefined,
    placeholder: server.defaultOrigin,
    validate: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      try {
        resolveLlamaServerEndpoint(value, server);
        return undefined;
      } catch {
        return "Enter a valid HTTP or HTTPS URL without embedded credentials (e.g. http://localhost:8080).";
      }
    },
  });
  const endpoint = resolveLlamaServerEndpoint(baseUrl.trim() || existing?.baseUrl, server);
  const endpointChanged =
    Boolean(existing?.localService) ||
    hasEndpointChanged(existing, endpoint.inferenceBaseUrl, server);
  const resolvedHeaders = endpointChanged
    ? undefined
    : await resolveLlamaServerProviderHeaders({
        server,
        config: ctx.config,
        env: ctx.env,
        headers: existing?.headers,
      });
  const usesApiKey = await ctx.prompter.confirm({
    message: `Does this ${serverName} require an API key?`,
    initialValue: false,
  });
  let apiKey: string | undefined;
  let headers = resolvedHeaders;
  let persistence: AuthPersistence<SecretInput>;
  if (!usesApiKey) {
    persistence = { kind: "remove" };
  } else {
    const hasConfiguredProfile = Boolean(ctx.config.auth?.profiles?.[`${server.id}:default`]);
    const profileApiKey =
      !endpointChanged &&
      !hasLlamaServerAuthorizationHeader(resolvedHeaders) &&
      hasConfiguredProfile
        ? await resolveLlamaServerRuntimeApiKey({
            server,
            config: ctx.config,
            agentDir: ctx.agentDir,
            profileId: `${server.id}:default`,
          })
        : undefined;
    if (profileApiKey) {
      apiKey = profileApiKey;
      persistence = { kind: "preserve" };
    } else {
      let credentialInput: SecretInput | undefined;
      apiKey = await ensureApiKeyFromEnvOrPrompt({
        config: endpointChanged ? stripLlamaServerEndpointAuth(ctx.config, server) : ctx.config,
        env: endpointChanged ? {} : ctx.env,
        provider: server.id,
        envLabel: server.apiKeyEnvVar,
        promptMessage: `Enter the ${serverName} API key`,
        normalize: (value) => value.trim(),
        validate: (value) => (value.trim() ? undefined : "Required"),
        prompter: ctx.prompter,
        secretInputMode: ctx.secretInputMode,
        setCredential: async (input) => {
          credentialInput = input;
        },
      });
      if (credentialInput === undefined) {
        throw new Error(`${serverName} API-key setup did not produce a credential`);
      }
      headers = stripAuthorizationHeader(resolvedHeaders);
      persistence = { kind: "upsert", credential: credentialInput };
    }
  }

  const discovery = await discoverLlamaServer({
    server,
    baseUrl: endpoint.inferenceBaseUrl,
    apiKey,
    headers,
    allowPrivateNetwork: existing?.request?.allowPrivateNetwork,
    signal: ctx.signal,
    useRuntimeDefaults: false,
  });
  if (discovery.kind !== "success") {
    throw new Error(describeDiscoveryFailure(discovery, server));
  }
  const modelId = selectSetupModelId(discovery);
  if (!modelId) {
    throw new Error(`No ${serverName} text models were found at ${discovery.endpoint.origin}.`);
  }
  if (persistence.kind === "remove") {
    await removeDefaultAuthProfile(ctx.config, ctx.agentDir, server);
  }
  return buildSetupResult(
    {
      config: ctx.config,
      discovery,
      modelId,
      resetEndpoint: endpointChanged,
      persistence,
    },
    server,
  );
}

async function validateNonInteractiveDiscovery(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<{
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  modelId: string;
  resetEndpoint: boolean;
  persistence: AuthPersistence<NonNullable<Awaited<ReturnType<typeof ctx.resolveApiKey>>>>;
}> {
  const configuredProvider = ctx.config.models?.providers?.[server.id];
  const baseUrl =
    normalizeOptionalSecretInput(ctx.opts.customBaseUrl) ??
    configuredProvider?.baseUrl ??
    server.defaultOrigin;
  const endpointChanged =
    Boolean(configuredProvider?.localService) ||
    hasEndpointChanged(configuredProvider, baseUrl, server);
  const providerApiKey =
    server.id === LLAMA_CPP_SERVER.id
      ? normalizeOptionalSecretInput(ctx.opts.llamaServerApiKey)
      : undefined;
  const customApiKey = normalizeOptionalSecretInput(ctx.opts.customApiKey);
  const authoredApiKey = providerApiKey ?? customApiKey;
  const hasAuthoredApiKey = authoredApiKey !== undefined;
  const resolvedApiKey = await ctx.resolveApiKey({
    provider: server.id,
    flagValue: authoredApiKey,
    flagName: providerApiKey === undefined ? "--custom-api-key" : "--llama-server-api-key",
    envVar: server.apiKeyEnvVar,
    envVarName: server.apiKeyEnvVar,
    required: false,
  });
  const resolvedHeaders = endpointChanged
    ? undefined
    : await resolveLlamaServerProviderHeaders({
        server,
        config: ctx.config,
        env: process.env,
        headers: configuredProvider?.headers,
      });
  let apiKey: string | undefined;
  let headers = resolvedHeaders;
  let persistence: AuthPersistence<NonNullable<typeof resolvedApiKey>>;
  if (hasAuthoredApiKey && resolvedApiKey) {
    apiKey = resolvedApiKey.key;
    headers = stripAuthorizationHeader(resolvedHeaders);
    persistence = { kind: "upsert", credential: resolvedApiKey };
  } else if (endpointChanged || hasLlamaServerAuthorizationHeader(resolvedHeaders)) {
    persistence = { kind: "remove" };
  } else if (resolvedApiKey?.source === "profile") {
    apiKey = resolvedApiKey.key;
    persistence = { kind: "preserve" };
  } else if (resolvedApiKey) {
    apiKey = resolvedApiKey.key;
    persistence = { kind: "upsert", credential: resolvedApiKey };
  } else {
    persistence = { kind: "remove" };
  }
  const discovery = await discoverLlamaServer({
    server,
    baseUrl,
    apiKey,
    headers,
    allowPrivateNetwork: configuredProvider?.request?.allowPrivateNetwork,
    useRuntimeDefaults: false,
  });
  if (discovery.kind !== "success") {
    throw new Error(describeDiscoveryFailure(discovery, server));
  }
  const requestedModelId = normalizeOptionalSecretInput(ctx.opts.customModelId);
  const modelId = requestedModelId ?? selectSetupModelId(discovery);
  if (!modelId || !discovery.models.some((model) => model.config.id === modelId)) {
    const available = discovery.models.map((model) => model.config.id).join(", ");
    throw new Error(
      requestedModelId
        ? `${server.id === LLAMA_CPP_SERVER.id ? "llama-server" : server.label} model ${requestedModelId} was not found. Available models: ${available}`
        : `No llama-server text models were found at ${discovery.endpoint.origin}.`,
    );
  }
  return {
    discovery,
    modelId,
    resetEndpoint: endpointChanged,
    persistence,
  };
}

export async function validateLlamaServerNonInteractive(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<boolean> {
  await validateNonInteractiveDiscovery(ctx, server);
  return true;
}

/** Non-interactive setup with optional API-key persistence. */
export async function configureLlamaServerNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  server: LlamaServerIdentity = LLAMA_CPP_SERVER,
): Promise<OpenClawConfig | null> {
  const validated = await validateNonInteractiveDiscovery(ctx, server);
  const providerConfig = buildExistingProviderConfig(
    {
      config: ctx.config,
      ...validated,
    },
    server,
  );
  let config: OpenClawConfig = {
    ...ctx.config,
    models: {
      ...ctx.config.models,
      mode: ctx.config.models?.mode ?? "merge",
      providers: {
        ...ctx.config.models?.providers,
        [server.id]: providerConfig,
      },
    },
  };

  if (validated.persistence.kind === "upsert") {
    const credential = ctx.toApiKeyCredential({
      provider: server.id,
      resolved: validated.persistence.credential,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLockOrThrow({
      profileId: `${server.id}:default`,
      credential,
      agentDir: ctx.agentDir,
    });
    config = applyAuthProfileConfig(config, {
      profileId: `${server.id}:default`,
      provider: server.id,
      mode: "api_key",
    });
  } else if (validated.persistence.kind === "remove") {
    await removeDefaultAuthProfile(ctx.config, ctx.agentDir, server);
    config = removeAuthProfileConfig(config, `${server.id}:default`);
  }

  ctx.runtime.log(`Default ${server.label} model: ${validated.modelId}`);
  return applyProviderDefaultModel(config, `${server.id}/${validated.modelId}`);
}
