import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfigWithOriginTrust,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { mergeSsrFPolicies, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";

export type ClawRouterCapabilityOffer = {
  providerId: string;
  endpoint: string;
  path: string;
  url: string;
  routeKind: "native" | "manifest" | "unified";
  methods: string[];
  requestFormat: string;
  responseFormat: string;
  model?: Record<string, unknown>;
};

// A declared format only enables routes whose wire contract the consumer implements.
const UNIFIED_ROUTES: Record<string, string> = {
  "openai.responses": "/v1/responses",
  "openai.embeddings": "/v1/embeddings",
  "openai.images_generations": "/v1/images/generations",
  "openai.audio_speech": "/v1/audio/speech",
};

export function resolveClawRouterCapabilityHttpContext(
  cfg: OpenClawConfig,
  apiKey: string,
  capability: Parameters<
    typeof resolveProviderHttpRequestConfigWithOriginTrust
  >[0]["capability"] = "other",
) {
  const provider = cfg.models?.providers?.clawrouter;
  const baseUrl = normalizeClawRouterApiBaseUrl(provider?.baseUrl);
  const context = resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "clawrouter",
    capability,
    transport: "http",
    baseUrl,
    defaultBaseUrl: baseUrl,
    request: sanitizeConfiguredModelProviderRequest(provider?.request),
  });
  const configuredHeaders = sanitizeConfiguredModelProviderRequest({
    headers: provider?.headers,
  })?.headers;
  const headers = new Headers(omitNullRequestHeaders(configuredHeaders));
  context.headers.forEach((value, name) => headers.set(name, value));
  headers.set("Authorization", "Bearer " + apiKey);
  headers.set("X-ClawRouter-Client", "openclaw");
  headers.set("Accept", "application/json");
  return {
    ...context,
    headers,
    ssrfPolicy: context.trustConfiguredBaseUrlOrigin
      ? { allowedOrigins: [new URL(baseUrl).origin] }
      : undefined,
  };
}

export function readClawRouterCapabilityOffers(
  payload: unknown,
  baseUrl: string,
): ClawRouterCapabilityOffer[] {
  const catalog = asOptionalRecord(payload);
  if (catalog?.version !== "clawrouter.client-catalog.v1" || !Array.isArray(catalog.providers)) {
    throw new Error("ClawRouter capability catalog is malformed; refresh or update ClawRouter.");
  }
  const root = baseUrl.replace(/\/v1\/?$/u, "");
  const result: ClawRouterCapabilityOffer[] = [];
  const seen = new Set<string>();
  for (const value of catalog.providers) {
    const provider = asOptionalRecord(value);
    const providerId = normalizeOptionalString(provider?.id);
    if (
      !providerId ||
      !/^[a-z0-9][a-z0-9_-]*$/u.test(providerId) ||
      provider?.allowed !== true ||
      provider.executable !== true ||
      !Array.isArray(provider.routes) ||
      !Array.isArray(provider.offers)
    ) {
      continue;
    }
    for (const offerValue of provider.offers) {
      const offer = asOptionalRecord(offerValue);
      if (
        offer?.eligible !== true ||
        offer.transport !== "http" ||
        (offer.affordability !== "exact-covered" && offer.affordability !== "request-dependent")
      ) {
        continue;
      }
      const endpoint = normalizeOptionalString(offer.endpoint);
      const route = provider.routes.map(asOptionalRecord).find((row) => row?.endpoint === endpoint);
      const requestFormat = normalizeOptionalString(route?.requestFormat);
      const responseFormat = normalizeOptionalString(route?.responseFormat);
      const path = normalizeOptionalString(route?.path);
      if (
        !endpoint ||
        !/^[a-z0-9][a-z0-9_-]*$/u.test(endpoint) ||
        !path ||
        !requestFormat ||
        !responseFormat ||
        !Array.isArray(route?.methods) ||
        !path.startsWith("/") ||
        /[\\?#]/u.test(path) ||
        path.includes("..")
      ) {
        continue;
      }
      const model =
        offer.modelId === null
          ? undefined
          : (Array.isArray(provider.models) ? provider.models : [])
              .map(asOptionalRecord)
              .find((row) => row?.id === offer.modelId);
      if (
        offer.modelId !== null &&
        (typeof offer.modelId !== "string" || !offer.modelId || !model)
      ) {
        continue;
      }
      const routeKind = offer.routeKind;
      if (routeKind !== "native" && routeKind !== "manifest" && routeKind !== "unified") {
        continue;
      }
      const expected =
        routeKind === "native" && provider.nativeBaseUrl === `/v1/native/${providerId}`
          ? `${provider.nativeBaseUrl}${path}`
          : routeKind === "manifest"
            ? `/v1/proxy/${providerId}/${endpoint}`
            : routeKind === "unified"
              ? UNIFIED_ROUTES[requestFormat]
              : undefined;
      if (!expected || offer.route !== expected) {
        continue;
      }
      const upstream = normalizeOptionalString(model?.upstream);
      if (expected.includes("${model}") && (!upstream || upstream === "." || upstream === "..")) {
        continue;
      }
      const resolved = expected.replaceAll("${model}", encodeURIComponent(upstream ?? ""));
      if (resolved.includes("${")) {
        continue;
      }
      const url = root + resolved;
      const key = JSON.stringify([providerId, endpoint, offer.modelId, routeKind]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({
        providerId,
        endpoint,
        path,
        url,
        routeKind,
        methods: route.methods.filter((method): method is string => typeof method === "string"),
        requestFormat,
        responseFormat,
        ...(model ? { model } : {}),
      });
    }
  }
  return result;
}

export async function fetchClawRouterCapabilityOffers(params: {
  context: ReturnType<typeof resolveClawRouterCapabilityHttpContext>;
  timeoutMs: () => number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  /** Require a recent proxy-key observation for consumers without model-scoped grants. */
  requireFreshProxyCatalog?: boolean | ((offers: readonly ClawRouterCapabilityOffer[]) => boolean);
}): Promise<ClawRouterCapabilityOffer[]> {
  params.signal?.throwIfAborted();
  const remaining = createProviderOperationTimeoutResolver({
    deadline: createProviderOperationDeadline({
      timeoutMs: Math.min(5_000, params.timeoutMs()),
      label: "ClawRouter capability discovery",
    }),
    defaultTimeoutMs: 5_000,
  });
  const { context } = params;
  const { response, release, finalUrl } = await fetchWithTimeoutGuarded(
    context.baseUrl.replace(/\/+$/u, "") + "/catalog",
    { method: "GET", headers: context.headers, signal: params.signal },
    remaining(),
    fetch,
    {
      ssrfPolicy: mergeSsrFPolicies(
        params.ssrfPolicy,
        context.ssrfPolicy,
        context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: context.dispatcherPolicy,
      auditContext: "clawrouter.capability-catalog",
    },
  );
  try {
    if (!response.ok) {
      throw new Error(
        `ClawRouter capability catalog failed (HTTP ${response.status}). Check the ClawRouter key, grants and budget.`,
      );
    }
    const body = await readProviderJsonResponse(response, "clawrouter.capability-catalog", {
      maxBytes: 1024 * 1024,
      timeoutMs: remaining,
    });
    const offers = readClawRouterCapabilityOffers(body, context.baseUrl);
    const requireFresh =
      typeof params.requireFreshProxyCatalog === "function"
        ? params.requireFreshProxyCatalog(offers)
        : params.requireFreshProxyCatalog;
    if (requireFresh) {
      const catalog = asOptionalRecord(body);
      const scope = asOptionalRecord(catalog?.scope);
      const observedAt =
        typeof catalog?.observedAt === "string" ? Date.parse(catalog.observedAt) : Number.NaN;
      const age = Date.now() - observedAt;
      if (
        !Number.isFinite(age) ||
        age < -5_000 ||
        age > 60_000 ||
        scope?.authType !== "proxy_key" ||
        !normalizeOptionalString(scope.credentialId) ||
        finalUrl !== context.baseUrl.replace(/\/+$/u, "") + "/catalog"
      ) {
        throw new Error("ClawRouter capability catalog has a stale or invalid proxy-key scope");
      }
    }
    remaining();
    params.signal?.throwIfAborted();
    return offers;
  } finally {
    void response.body?.cancel().catch(() => undefined);
    await release();
  }
}
