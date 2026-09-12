import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import type { CodexInferenceProxy } from "./inference-proxy.js";
import { isJsonObject, type CodexConfigReadResponse, type JsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

type Owner = {
  closed: boolean;
  routes: Map<string, Promise<CodexInferenceProxy>>;
  threads: Map<string, CodexInferenceProxy>;
  handles: Set<CodexInferenceProxy>;
  authRoute?: "apiKey" | "chatgpt";
};
// Shared clients survive duplicate module loads; their inference ownership must too.
const owners = defineCodexBuildState(
  "openclaw.codexAppServerInferenceOwners",
  () => new WeakMap<CodexAppServerClient, Owner>(),
)();
const MAX_ROUTES = 8;
const MAX_THREADS = 256;
const NATIVE_OPENAI_UPSTREAMS = new Set([
  "https://api.openai.com/v1",
  "https://chatgpt.com/backend-api/codex",
]);

/** Only managed native stdio startup calls this; locality or metadata cannot opt a client in. */
export function ownCodexInferenceClient(client: CodexAppServerClient): void {
  if (owners.has(client)) {
    return;
  }
  const owner: Owner = { closed: false, routes: new Map(), threads: new Map(), handles: new Set() };
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

async function prepareCodexInferenceRoute(params: {
  client: CodexAppServerClient;
  cwd: string;
  effectiveConfig?: CodexConfigReadResponse;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<CodexInferenceProxy | undefined> {
  const owner = owners.get(params.client);
  if (!owner) {
    return undefined;
  }
  const assertClient = () => {
    if (owner.closed || owners.get(params.client) !== owner) {
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
  if (snapshot.config.model_provider != null && snapshot.config.model_provider !== "openai") {
    return undefined;
  }
  // Native system-proxy routing owns its transport, including loopback bypass.
  // Leave that profile intact instead of proxying its private inference IPC.
  if (
    isJsonObject(snapshot.config.features) &&
    snapshot.config.features.respect_system_proxy === true
  ) {
    return undefined;
  }
  const configured = snapshot.config.openai_base_url;
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex inference upstream configuration is invalid");
  }
  // Preserve explicitly configured compatible providers unchanged. The temporary
  // relay supports only the native OpenAI endpoints, not arbitrary upstream routing.
  if (configured) {
    let target: URL;
    try {
      target = new URL(configured);
    } catch {
      return undefined;
    }
    if (!NATIVE_OPENAI_UPSTREAMS.has(target.href.replace(/\/$/, ""))) {
      return undefined;
    }
  }
  const origin = snapshot.origins?.openai_base_url;
  if (origin && !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(origin.name.type)) {
    return undefined;
  }
  const account = await params.client.request(
    "account/read",
    { refreshToken: false },
    {
      signal: params.signal,
      assertCurrent,
    },
  );
  assertCurrent();
  const type = isJsonObject(account.account) ? account.account.type : undefined;
  if (type !== "apiKey" && type !== "chatgpt") {
    return undefined;
  }
  if (owner.authRoute && owner.authRoute !== type) {
    throw new Error("Codex native account route changed; reconnect before retrying");
  }
  owner.authRoute = type;
  // Pinned native ModelProviderInfo::to_api_provider uses these defaults only without an override.
  // chatgpt_base_url owns other native services; it is not the model-provider base URL.
  const target = new URL(
    configured ||
      (type === "apiKey" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex"),
  );
  const key = target.toString();
  let pending = owner.routes.get(key);
  if (!pending) {
    if (owner.routes.size >= MAX_ROUTES) {
      throw new Error("Codex inference route limit reached");
    }
    pending = import("./inference-proxy.js").then(({ createCodexInferenceProxy }) => {
      assertClient();
      return createCodexInferenceProxy({ upstream: target, assertCurrent: assertClient });
    });
    // Keep a failed route failed for this physical client; never fall back to unmodified inference.
    owner.routes.set(key, pending);
  }
  const route = await pending;
  assertCurrent();
  route.assertCurrent();
  params.client.protectPrivateTransportSecret(new URL(route.baseUrl).pathname.split("/")[1] ?? "");
  owner.handles.add(route);
  return route;
}

/** Prepare a managed thread without changing an attached or unsupported native profile. */
export async function prepareCodexInferenceThreadConfig(params: {
  client: CodexAppServerClient;
  binding: CodexAppServerThreadBinding | undefined;
  clientId: string;
  cwd: string;
  config?: JsonObject;
  effectiveConfig?: CodexConfigReadResponse;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ route: CodexInferenceProxy; config: JsonObject } | undefined> {
  const { binding } = params;
  if (binding?.connectionScope === "supervision" || binding?.preserveNativeModel === true) {
    return undefined;
  }
  const route = await prepareCodexInferenceRoute(params);
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
  if (
    params.config?.openai_base_url !== undefined &&
    params.config.openai_base_url !== route.upstream
  ) {
    throw new Error("Codex thread configuration conflicts with its trusted inference upstream");
  }
  return { route, config: { ...params.config, openai_base_url: route.baseUrl } };
}

/** Validate the exact private handle and unchanged upstream, not a localhost string exception. */
export function assertCodexInferenceRouteConfig(
  client: CodexAppServerClient,
  route: CodexInferenceProxy | undefined,
  config: JsonObject | undefined,
): void {
  if (!route) {
    return;
  }
  const owner = owners.get(client);
  if (
    !owner ||
    owner.closed ||
    !owner.handles.has(route) ||
    config?.openai_base_url !== route.baseUrl
  ) {
    throw new Error("Codex parent-local inference route was overridden; no turn was sent");
  }
  route.assertCurrent();
}

export function bindCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
  route: CodexInferenceProxy | undefined,
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
  if (!owner.threads.has(threadId) && owner.threads.size >= MAX_THREADS) {
    throw new Error("Codex inference thread limit reached; reconnect before retrying");
  }
  owner.threads.set(threadId, route);
}

export function getCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
): CodexInferenceProxy | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.threads.get(threadId);
}
