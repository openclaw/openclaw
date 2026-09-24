import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import type { CodexInferenceProxy } from "./inference-proxy.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import { isJsonObject, type CodexConfigReadResponse, type JsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

export type CodexInferenceProviderRoutes = ReadonlyMap<string, CodexInferenceProxy>;
export type { CodexInferenceThreadQualification } from "./inference-qualification.js";
type ThreadRoutes = {
  route: CodexInferenceProxy;
  providers: CodexInferenceProviderRoutes;
  qualification?: CodexInferenceThreadQualification;
};
type ProviderKind = "openai" | "azure" | "other";

type Owner = {
  closed: boolean;
  memoryConfigured: boolean;
  routes: Map<string, Promise<CodexInferenceProxy>>;
  threads: Map<string, ThreadRoutes>;
  handles: Map<
    CodexInferenceProxy,
    { provider: string; kind: ProviderKind; modelPolicyEnforced: boolean }
  >;
  authRoute?: "apiKey" | "chatgpt";
};
// Shared clients survive duplicate module loads; their inference ownership must too.
const owners = defineCodexBuildState(
  "openclaw.codexAppServerInferenceOwners",
  () => new WeakMap<CodexAppServerClient, Owner>(),
)();
const MAX_ROUTES = 8;
const MAX_THREADS = 256;

/** Only managed native stdio startup calls this; locality or metadata cannot opt a client in. */
export function ownCodexInferenceClient(
  client: CodexAppServerClient,
  startOptions: Pick<CodexAppServerStartOptions, "env" | "clearEnv"> = {},
): void {
  if (owners.has(client)) {
    return;
  }
  // The native transport owns custom trust roots and per-process proxy choices.
  // Leave those profiles native until the relay can preserve the same transport.
  if (!supportsInferenceEnvironment(resolveCodexAppServerSpawnEnv(startOptions))) {
    return;
  }
  const owner: Owner = {
    closed: false,
    memoryConfigured: false,
    routes: new Map(),
    threads: new Map(),
    handles: new Map(),
  };
  owners.set(client, owner);
  const close = () => {
    owner.closed = true;
    owner.threads.clear();
    owner.handles.clear();
    for (const pending of owner.routes.values()) {
      void pending.then(
        (route) => route.close(),
        () => {},
      );
    }
    owner.routes.clear();
  };
  client.addCloseHandler(close);
  client.addNotificationHandler((notification) => {
    if (
      notification.method === "thread/closed" &&
      isJsonObject(notification.params) &&
      typeof notification.params.threadId === "string"
    ) {
      owner.threads.delete(notification.params.threadId);
    }
    if (notification.method !== "account/updated" || !owner.authRoute) {
      return;
    }
    const mode = isJsonObject(notification.params) ? notification.params.authMode : undefined;
    const route =
      mode === "apiKey"
        ? "apiKey"
        : mode === "chatgpt" || mode === "chatgptAuthTokens"
          ? "chatgpt"
          : undefined;
    // Token rotation on the same native route is transparent. Account-mode changes are not.
    if (route !== owner.authRoute) {
      close();
    }
  });
}

function supportsInferenceEnvironment(native: NodeJS.ProcessEnv): boolean {
  if (native.CODEX_CA_CERTIFICATE?.trim() || native.SSL_CERT_FILE?.trim()) {
    return false;
  }
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  for (const upper of names) {
    const lower = upper.toLowerCase();
    if (
      native[upper] !== process.env[upper] ||
      native[lower] !== process.env[lower] ||
      (native[upper] !== undefined &&
        native[lower] !== undefined &&
        native[upper] !== native[lower])
    ) {
      return false;
    }
  }
  const value = (name: string) => (native[name] ?? native[name.toLowerCase()])?.trim() || undefined;
  const http = value("HTTP_PROXY");
  const https = value("HTTPS_PROXY");
  const all = value("ALL_PROXY");
  if (!http && !https && !all) {
    return true;
  }
  const noProxy = native.NO_PROXY ?? native.no_proxy ?? "";
  if (noProxy === "*") {
    return true;
  }
  if (
    native.REQUEST_METHOD !== undefined ||
    names.slice(0, 3).some((name) => {
      const raw = native[name] ?? native[name.toLowerCase()];
      return raw !== undefined && raw !== raw.trim();
    })
  ) {
    return false;
  }
  // Reqwest prefers uppercase and has no HTTP_PROXY fallback for HTTPS. Only
  // equivalent proxy selection and literal loopback bypasses are qualified here.
  if ((https ?? all) !== (https ?? http ?? all)) {
    return false;
  }
  const bypasses = noProxy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (bypasses.some((entry) => !["127.0.0.1", "localhost", "::1", "[::1]"].includes(entry))) {
    return false;
  }
  if ((http || all) && !bypasses.includes("127.0.0.1")) {
    return false;
  }
  return /^https?:\/\//.test(https ?? all ?? "");
}

async function prepareCodexInferenceRoute(params: {
  client: CodexAppServerClient;
  cwd: string;
  modelProvider?: string;
  config?: JsonObject;
  effectiveConfig?: CodexConfigReadResponse;
  modelPolicyEnforced?: boolean;
  optionalProjection?: true;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<CodexInferenceProxy | undefined> {
  const client = params.client;
  const owner = owners.get(client);
  if (!owner) {
    return undefined;
  }
  const assertClient = () => {
    if (owner.closed || owners.get(client) !== owner) {
      throw new Error("Codex inference route ownership changed; reconnect before retrying");
    }
  };
  const assertCurrent = () => {
    assertClient();
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const snapshot =
    params.effectiveConfig ??
    (await readCodexEffectiveConfig(params.client, params.cwd, { signal: params.signal }));
  assertCurrent();
  const provider =
    params.modelProvider ??
    params.config?.model_provider ??
    snapshot.config.model_provider ??
    "openai";
  if (typeof provider !== "string" || !provider.trim()) {
    return undefined;
  }
  const customProvider = provider !== "openai";
  const providerField = (field: string) =>
    readProviderField(params.config, provider, field) ??
    readProviderField(snapshot.config, provider, field);
  const nativeProviderName = customProvider ? providerField("name") : "OpenAI";
  const kind = providerKind(nativeProviderName);
  const wireApi = customProvider ? providerField("wire_api") : "responses";
  if (
    !kind ||
    (customProvider &&
      (["amazon-bedrock", "amazon-bedrock-runtime", "ollama", "lmstudio"].includes(provider) ||
        hasProviderAws(params.config, provider) ||
        hasProviderAws(snapshot.config, provider) ||
        (wireApi != null && wireApi !== "responses")))
  ) {
    // Native built-ins ignore ordinary provider overrides; SigV4 also signs the URL/body.
    return undefined;
  }
  // Native system-proxy routing owns its transport, including loopback bypass.
  // Leave that profile intact instead of proxying its private inference IPC.
  const systemProxy =
    params.config?.["features.respect_system_proxy"] ??
    (isJsonObject(params.config?.features)
      ? params.config.features.respect_system_proxy
      : undefined) ??
    (isJsonObject(snapshot.config.features)
      ? snapshot.config.features.respect_system_proxy
      : undefined);
  if (systemProxy === true) {
    return undefined;
  }
  // Pinned native merges built-ins first: model_providers.openai never replaces OpenAI.
  const configured = customProvider
    ? providerField("base_url")
    : (params.config?.openai_base_url ?? snapshot.config.openai_base_url);
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex inference upstream configuration is invalid");
  }
  if (
    typeof configured === "string" &&
    (!configured.trim() || configured.includes("?") || configured.includes("#"))
  ) {
    return undefined;
  }
  // The relay preserves the selected Responses provider, including its auth and query fields.
  if (configured) {
    let target: URL;
    try {
      target = new URL(configured);
    } catch {
      return undefined;
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.hash ||
      target.search
    ) {
      return undefined;
    }
  }
  if (customProvider && !configured) {
    return undefined;
  }
  const configKey = customProvider ? `model_providers.${provider}.base_url` : "openai_base_url";
  const origins = Object.entries(snapshot.origins ?? {}).filter(([key]) =>
    customProvider
      ? key === "model_providers" || key === `model_providers.${provider}` || key === configKey
      : key === configKey,
  );
  if (
    origins.some(
      ([, origin]) => !origin || !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(origin.name.type),
    )
  ) {
    return undefined;
  }
  const account = customProvider
    ? undefined
    : await params.client.request(
        "account/read",
        { refreshToken: false },
        {
          signal: params.signal,
          assertCurrent,
        },
      );
  assertCurrent();
  const type = account?.account?.type;
  if (!customProvider && type !== "apiKey" && type !== "chatgpt") {
    return undefined;
  }
  if (!customProvider && owner.authRoute && owner.authRoute !== type) {
    throw new Error("Codex native account route changed; reconnect before retrying");
  }
  if (type === "apiKey" || type === "chatgpt") {
    owner.authRoute = type;
  }
  // Pinned native ModelProviderInfo::to_api_provider uses these defaults only without an override.
  // chatgpt_base_url owns other native services; it is not the model-provider base URL.
  const target = new URL(
    configured ||
      (type === "apiKey" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex"),
  );
  const { isBlockedHostnameOrIp } = await import("openclaw/plugin-sdk/ssrf-runtime");
  assertCurrent();
  if (isBlockedHostnameOrIp(target.hostname)) {
    return undefined;
  }
  // Native 0.154 also recognizes Azure by URL substrings; loopback must preserve that fact.
  const nativeBaseUrl = typeof configured === "string" ? configured.toLowerCase() : target.href;
  const preserveAzureUrlFeatures =
    (typeof nativeProviderName === "string" && nativeProviderName.toLowerCase() === "azure") ||
    [
      "openai.azure.",
      "cognitiveservices.azure.",
      "aoai.azure.",
      "azure-api.",
      "azurefd.",
      "windows.net/openai",
    ].some((marker) => nativeBaseUrl.includes(marker));
  const preserveCodexBackendRoutes =
    nativeProviderName === "OpenAI" &&
    (configured == null || configured.replace(/\/+$/, "").endsWith("/backend-api/codex"));
  const memoryFeature =
    params.config?.["features.memories"] ??
    (isJsonObject(params.config?.features) ? params.config.features.memories : undefined) ??
    (isJsonObject(snapshot.config.features) ? snapshot.config.features.memories : undefined);
  // A configured native startup service may outlive the foreground that created its thread.
  // generate_memories controls new thread recording, not processing of eligible prior history.
  owner.memoryConfigured ||= memoryFeature === true;
  const modelPolicyEnforced = params.modelPolicyEnforced !== false;
  const key = JSON.stringify([
    provider,
    target.toString(),
    kind,
    preserveAzureUrlFeatures,
    preserveCodexBackendRoutes,
    modelPolicyEnforced,
  ]);
  let pending = owner.routes.get(key);
  if (!pending) {
    if (owner.routes.size >= MAX_ROUTES) {
      if (params.optionalProjection) {
        return undefined;
      }
      throw new Error(
        "Codex inference route limit reached; start a fresh managed native connection before retrying.",
      );
    }
    pending = Promise.all([
      import("./inference-proxy.js"),
      import("./native-subagent-monitor.js"),
      import("./inference-dispatch.js"),
    ]).then(([{ createCodexInferenceProxy }, native, { createCodexInferenceModelBinding }]) => {
      assertClient();
      return createCodexInferenceProxy({
        upstream: target,
        assertCurrent: assertClient,
        preserveAzureUrlFeatures,
        preserveCodexBackendRoutes,
        bindModelExecution: createCodexInferenceModelBinding({
          client,
          provider,
          modelPolicyEnforced,
          assertCurrent: assertClient,
          memoryConfigured: () => owner.memoryConfigured,
          captureModelSource: native.codexNativeSubagentMonitorRuntime.captureModelSource,
          resolveModelThreadId: native.codexNativeSubagentMonitorRuntime.resolveModelThreadId,
        }),
      });
    });
    // Keep a failed route failed for this physical client; never fall back to unmodified inference.
    owner.routes.set(key, pending);
  }
  const route = await pending;
  assertCurrent();
  route.assertCurrent();
  params.client.protectPrivateTransportSecret(new URL(route.baseUrl).pathname.split("/")[1] ?? "");
  owner.handles.set(route, { provider, kind, modelPolicyEnforced });
  return route;
}

/** Prepare a managed thread without changing an attached or unsupported native profile. */
export async function prepareCodexInferenceThreadConfig(params: {
  client: CodexAppServerClient;
  binding: CodexAppServerThreadBinding | undefined;
  clientId: string;
  cwd: string;
  config?: JsonObject;
  modelProvider?: string;
  effectiveConfig?: CodexConfigReadResponse;
  /** Captured from the issuing host, never from native request metadata. */
  operatorBacked?: boolean;
  /** Parent context still uses this transport when optional native model hooks are unavailable. */
  modelPolicyEnforced?: boolean;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<
  | { route: CodexInferenceProxy; config: JsonObject; providers?: CodexInferenceProviderRoutes }
  | undefined
> {
  const { binding } = params;
  const owner = owners.get(params.client);
  if (!owner) {
    return undefined;
  }
  if (owner.closed) {
    throw new Error("Codex inference route ownership changed; reconnect before retrying");
  }
  const preserved =
    binding?.connectionScope === "supervision" || binding?.preserveNativeModel === true;
  let retained =
    preserved && binding?.clientId === params.clientId
      ? owner.threads.get(binding.threadId)
      : undefined;
  if (preserved) {
    // An attachment cannot confer ownership; an already-owned route can remain in use.
    if (!retained) {
      return undefined;
    }
    retained.route.assertCurrent();
    if (
      owner.handles.get(retained.route)?.modelPolicyEnforced !==
      (params.modelPolicyEnforced !== false)
    ) {
      retained = undefined;
    } else if (!params.operatorBacked) {
      return {
        route: retained.route,
        providers: retained.providers,
        config: projectProviderRoutes(params.config, retained.providers),
      };
    }
  }
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const effectiveConfig =
    params.effectiveConfig ??
    (await readCodexEffectiveConfig(params.client, params.cwd, { signal: params.signal }));
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const route =
    retained?.route ?? (await prepareCodexInferenceRoute({ ...params, effectiveConfig }));
  if (!route) {
    return undefined;
  }
  if (
    binding?.clientId === params.clientId &&
    !getCodexInferenceThread(params.client, binding.threadId)
  ) {
    const { thread } = await params.client.request(
      "thread/read",
      { threadId: binding.threadId, includeTurns: false },
      { signal: params.signal, assertCurrent: params.assertCurrent },
    );
    params.assertCurrent();
    if (thread.id !== binding.threadId || thread.status?.type !== "notLoaded") {
      throw new Error(
        "Codex loaded thread has no owned inference route; reconnect before retrying",
      );
    }
  }
  const provider = owner.handles.get(route)?.provider;
  if (!provider) {
    throw new Error("Codex inference provider ownership changed");
  }
  if (!params.operatorBacked) {
    return { route, config: withProviderBaseUrl(params.config, provider, route.baseUrl) };
  }
  const providers = new Map(retained?.providers ?? [[provider, route]]);
  // Restoring native work can select any stored provider from this parent configuration.
  // Reuse one config/account view; only URLs are projected, never credentials or query fields.
  for (const candidate of configuredProviders(effectiveConfig.config, params.config)) {
    if (providers.has(candidate)) {
      continue;
    }
    const sibling = await prepareCodexInferenceRoute({
      ...params,
      effectiveConfig,
      modelProvider: candidate,
      optionalProjection: true,
    });
    if (sibling) {
      providers.set(candidate, sibling);
    }
  }
  return { route, config: projectProviderRoutes(params.config, providers), providers };
}

/** Validate the exact private handle and unchanged upstream, not a localhost string exception. */
export function assertCodexInferenceRouteConfig(
  client: CodexAppServerClient,
  route: CodexInferenceProxy | undefined,
  config: JsonObject | undefined,
  modelProvider?: string,
  providers?: CodexInferenceProviderRoutes,
): void {
  if (!route) {
    return;
  }
  const owner = owners.get(client);
  const definition = owner?.handles.get(route);
  const provider = definition?.provider;
  const selectedProvider = modelProvider ?? config?.model_provider ?? provider;
  const systemProxy =
    config?.["features.respect_system_proxy"] ??
    (isJsonObject(config?.features) ? config.features.respect_system_proxy : undefined);
  if (
    !owner ||
    owner.closed ||
    !provider ||
    selectedProvider !== provider ||
    systemProxy === true ||
    readProviderBaseUrl(config, provider) !== route.baseUrl
  ) {
    throw new Error("Codex parent-local inference route was overridden; no turn was sent");
  }
  route.assertCurrent();
  for (const [candidate, sibling] of providers ?? [[provider, route] as const]) {
    const siblingDefinition = owner.handles.get(sibling);
    const name = readProviderField(config, candidate, "name");
    const wireApi = readProviderField(config, candidate, "wire_api");
    if (
      siblingDefinition?.provider !== candidate ||
      readProviderBaseUrl(config, candidate) !== sibling.baseUrl ||
      (candidate !== "openai" &&
        ((name !== undefined && providerKind(name) !== siblingDefinition.kind) ||
          (wireApi !== undefined && wireApi !== "responses") ||
          hasProviderAws(config, candidate)))
    ) {
      throw new Error("Codex native provider inference route was overridden; no turn was sent");
    }
    sibling.assertCurrent();
  }
}

function providerKind(name: unknown): ProviderKind | undefined {
  if (name === "Amazon Bedrock" || name === "Amazon Bedrock Runtime") {
    return undefined;
  }
  return name === "OpenAI"
    ? "openai"
    : typeof name === "string" && name.toLowerCase() === "azure"
      ? "azure"
      : "other";
}

function hasProviderAws(config: JsonObject | undefined, provider: string): boolean {
  return (
    readProviderField(config, provider, "aws") != null ||
    Object.keys(config ?? {}).some((key) => key.startsWith(`model_providers.${provider}.aws.`))
  );
}

function configuredProviders(...configs: (JsonObject | undefined)[]): Set<string> {
  const providers = new Set(["openai"]);
  for (const config of configs) {
    for (const provider of Object.keys(
      isJsonObject(config?.model_providers) ? config.model_providers : {},
    )) {
      providers.add(provider);
    }
    for (const key of Object.keys(config ?? {})) {
      const provider = /^model_providers\.([^.]+)(?:\.|$)/.exec(key)?.[1];
      if (provider) {
        providers.add(provider);
      }
    }
  }
  return providers;
}

function projectProviderRoutes(
  config: JsonObject | undefined,
  providers: CodexInferenceProviderRoutes,
): JsonObject {
  let projected = config ?? {};
  for (const [provider, route] of providers) {
    projected = withProviderBaseUrl(projected, provider, route.baseUrl);
  }
  return projected;
}

function readProviderBaseUrl(config: JsonObject | undefined, provider: string): unknown {
  if (provider === "openai") {
    return config?.openai_base_url;
  }
  return readProviderField(config, provider, "base_url");
}

function readProviderField(
  config: JsonObject | undefined,
  provider: string,
  field: string,
): unknown {
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : undefined;
  const selected = providers?.[provider];
  const flat = config?.[`model_providers.${provider}`];
  return (
    config?.[`model_providers.${provider}.${field}`] ??
    (isJsonObject(flat) ? flat[field] : undefined) ??
    (isJsonObject(selected) ? selected[field] : undefined)
  );
}

function withProviderBaseUrl(
  config: JsonObject | undefined,
  provider: string,
  baseUrl: string,
): JsonObject {
  if (provider === "openai") {
    return { ...config, openai_base_url: baseUrl };
  }
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : {};
  const selected = providers[provider];
  const providerKey = `model_providers.${provider}`;
  const baseUrlKey = `${providerKey}.base_url`;
  const flat = config?.[providerKey];
  // A sparse native table overlay changes only this URL; native still owns auth and headers.
  return {
    ...config,
    model_providers: {
      ...providers,
      [provider]: { ...(isJsonObject(selected) ? selected : {}), base_url: baseUrl },
    },
    ...(isJsonObject(flat) ? { [providerKey]: { ...flat, base_url: baseUrl } } : {}),
    ...(config?.[baseUrlKey] !== undefined ? { [baseUrlKey]: baseUrl } : {}),
  };
}

export function bindCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
  route: CodexInferenceProxy | undefined,
  providers?: CodexInferenceProviderRoutes,
): void {
  const owner = owners.get(client);
  if (!owner && !route) {
    return;
  }
  if (!owner || owner.closed) {
    throw new Error("Codex inference client is closed");
  }
  if (!route) {
    owner.threads.delete(threadId);
    return;
  }
  route.assertCurrent();
  const provider = owner.handles.get(route)?.provider;
  if (!provider) {
    throw new Error("Codex inference provider ownership changed");
  }
  if (!owner.threads.has(threadId) && owner.threads.size >= MAX_THREADS) {
    throw new Error("Codex inference thread limit reached; reconnect before retrying");
  }
  const projected = new Map(providers ?? [[provider, route]]);
  if (projected.get(provider) !== route) {
    throw new Error("Codex inference provider ownership changed");
  }
  const assertCurrent = () => {
    if (owner.closed || owners.get(client) !== owner) {
      throw new Error("Codex inference client is closed");
    }
    for (const [candidate, routed] of projected) {
      if (owner.handles.get(routed)?.provider !== candidate) {
        throw new Error("Codex inference provider ownership changed");
      }
      routed.assertCurrent();
    }
  };
  assertCurrent();
  // Older native children retain their configuration snapshot even if the parent later changes.
  const qualification = owner.handles.get(route)?.modelPolicyEnforced
    ? Object.freeze({
        assertCurrent,
        hasProvider: (candidate: string) => {
          assertCurrent();
          const projectedRoute = projected.get(candidate);
          return (
            projectedRoute !== undefined &&
            owner.handles.get(projectedRoute)?.modelPolicyEnforced === true
          );
        },
      })
    : undefined;
  owner.threads.set(threadId, { route, providers: projected, qualification });
}

export function getCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
): CodexInferenceProxy | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.threads.get(threadId)?.route;
}

/** Configuration provenance for native restore admission, independent of the input's source. */
export function getCodexInferenceThreadQualification(
  client: CodexAppServerClient,
  threadId: string,
): CodexInferenceThreadQualification | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.threads.get(threadId)?.qualification;
}
