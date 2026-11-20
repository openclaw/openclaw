import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ModelRequestHeaders } from "openclaw/plugin-sdk/llm";
import type {
  ProviderResolveTransportTurnStateContext,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  mapAssistantMessageStream,
  transformProviderStreamMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";
import { CLAWROUTER_ROUTE_METADATA_KEY } from "./provider-policy-api.js";

const NATIVE_SESSION = "x-opencode-session";
const ROUTER_SESSION = "x-clawrouter-session-id";
const SESSION_HEADERS = new Set([
  NATIVE_SESSION,
  ROUTER_SESSION,
  "x-claude-code-session-id",
  "session-id",
]);

const OPEN_CODE_TRANSPORTS = [
  {
    api: "openai-responses",
    capability: "llm.responses",
    format: "openai.responses",
    suffix: "/responses",
  },
  {
    api: "openai-completions",
    capability: "llm.chat",
    format: "openai.chat_completions",
    suffix: "/chat/completions",
  },
  {
    api: "anthropic-messages",
    capability: "llm.messages",
    format: "anthropic.messages",
    suffix: "/v1/messages",
  },
] as const;

/** Select only offers already validated against this credential's catalog origin. */
export function selectOpenCodeProxyOffer(
  providerId: string,
  modelId: string,
  upstream: string,
  capabilities: readonly string[],
  offers: readonly ClawRouterCapabilityOffer[],
) {
  if (
    (providerId !== "opencode" && providerId !== "opencode-go") ||
    modelId !== `${providerId}/${upstream}`
  ) {
    return undefined;
  }
  for (const transport of OPEN_CODE_TRANSPORTS) {
    if (!capabilities.includes(transport.capability)) {
      continue;
    }
    const eligible = offers.filter(
      (offer) =>
        offer.providerId === providerId &&
        offer.model?.id === modelId &&
        offer.model.upstream === upstream &&
        offer.methods.includes("POST") &&
        offer.requestFormat === transport.format &&
        offer.responseFormat === transport.format &&
        offer.url.endsWith(transport.suffix) &&
        (offer.routeKind === "native" || offer.routeKind === "unified"),
    );
    const native = eligible.filter((offer) => offer.routeKind === "native");
    const selected = native.length > 0 ? native : eligible;
    // Multiple distinct endpoint declarations are not ordered routing policy.
    if (selected.length !== 1) {
      if (selected.length > 1) {
        return undefined;
      }
      continue;
    }
    const offer = selected[0]!;
    return {
      providerId,
      modelId,
      upstream,
      api: transport.api,
      endpoint: offer.endpoint,
      url: offer.url,
      routeKind: offer.routeKind,
      baseUrl: offer.url.slice(0, -transport.suffix.length),
    };
  }
  return undefined;
}

function selectedOpenCode(model: ProviderRuntimeModel, sourceApi = model.api) {
  if (model.provider !== "clawrouter") {
    return undefined;
  }
  const provider = model.id.startsWith("opencode/")
    ? "opencode"
    : model.id.startsWith("opencode-go/")
      ? "opencode-go"
      : undefined;
  if (!provider) {
    return undefined;
  }
  const route = asOptionalRecord(model.params?.[CLAWROUTER_ROUTE_METADATA_KEY]);
  const selected = asOptionalRecord(route?.openCode);
  const transport = OPEN_CODE_TRANSPORTS.find((entry) => entry.api === sourceApi);
  if (
    !transport ||
    !route ||
    route.api !== sourceApi ||
    route.baseUrl !== model.baseUrl ||
    !selected ||
    selected.api !== sourceApi ||
    selected.baseUrl !== model.baseUrl ||
    selected.providerId !== provider ||
    selected.modelId !== model.id ||
    selected.upstream !== model.id.slice(provider.length + 1) ||
    selected.url !== model.baseUrl + transport.suffix ||
    (selected.routeKind !== "native" && selected.routeKind !== "unified") ||
    (selected.routeKind === "native"
      ? route.upstreamModel !== selected.upstream
      : route.upstreamModel !== undefined)
  ) {
    throw new Error(
      "ClawRouter OpenCode session binding requires a qualified Chat, Responses or Messages route",
    );
  }
  return provider;
}

// Resolve from catalog authority before dispatch strips metadata or rewrites IDs.
function resolveOpenCodeProxyStreamFamily(model: ProviderRuntimeModel, sourceApi = model.api) {
  const provider = selectedOpenCode(model, sourceApi);
  if (provider === "opencode" && sourceApi === "openai-responses") {
    return "opencode-responses";
  }
  if (
    provider === "opencode-go" &&
    sourceApi === "openai-completions" &&
    model.id === "opencode-go/deepseek-v4-pro"
  ) {
    return "deepseek-v4-pro-thinking";
  }
  return undefined;
}

export function wrapOpenCodeProxyStream(
  ctx: ProviderWrapStreamFnContext,
  model: ProviderRuntimeModel,
  underlying: StreamFn,
): StreamFn {
  const family = resolveOpenCodeProxyStreamFamily(model, ctx.sourceApi);
  return family
    ? (buildProviderStreamFamilyHooks(family).wrapStreamFn!({ ...ctx, streamFn: underlying }) ??
        underlying)
    : underlying;
}

export function restoreClawRouterResponseModel(
  response: ReturnType<StreamFn>,
  model: ProviderRuntimeModel,
): ReturnType<StreamFn> {
  // Upstream IDs belong on the wire; session state needs the resolvable catalog ID.
  // Keep responseModel intact so genuine upstream reroutes remain observable.
  return mapAssistantMessageStream(response, (output) =>
    transformProviderStreamMessages(
      output,
      (message) => {
        message.model = model.id;
      },
      { includeError: model.id.startsWith("opencode/") && model.api === "openai-responses" },
    ),
  );
}

function explicitSession(...carriers: Array<ModelRequestHeaders | undefined>) {
  const values = carriers.flatMap((headers) =>
    Object.entries(headers ?? {})
      .filter(([name]) => name.toLowerCase() === NATIVE_SESSION)
      .map(([, value]) => value),
  );
  if (values.length === 0) {
    return undefined;
  }
  if (values.some((value) => value !== values[0])) {
    throw new Error("Conflicting case-insensitive OpenCode session headers");
  }
  return { value: validateSession(values[0]) };
}

function validateSession(value: string | null | undefined): string {
  if (!value || value.length > 256 || !/^[A-Za-z0-9._~:/+@=-]+$/u.test(value)) {
    throw new Error(
      "OpenCode session identity must match the ClawRouter ASCII attribution format (1-256 characters)",
    );
  }
  return value;
}

function conversationSession(value: string): string {
  if (!value.trim() || containsAsciiControlCharacter(value)) {
    throw new Error("OpenCode conversation identity must not be empty or contain controls");
  }
  if (value.length <= 256 && /^[A-Za-z0-9._~:/+@=-]+$/u.test(value) && !value.startsWith("oc~")) {
    return value;
  }
  // Lossless UTF-16 hashing also keeps lone surrogates distinct. Reserve the
  // encoded namespace so an automatic literal cannot alias an encoded identity.
  return "oc~" + createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex");
}

function removeSessionHeaders(headers: ModelRequestHeaders) {
  for (const name of Object.keys(headers)) {
    if (SESSION_HEADERS.has(name.toLowerCase())) {
      delete headers[name];
    }
  }
}

/** Translate identity only; the Worker binds the original principal, provider and grant. */
export function bridgeOpenCodeProxySession(params: {
  model: ProviderRuntimeModel;
  sourceApi?: string;
  headers: ModelRequestHeaders;
  options: Parameters<StreamFn>[2];
}): Parameters<StreamFn>[2] {
  const { model, headers, options } = params;
  if (!selectedOpenCode(model, params.sourceApi)) {
    return options;
  }
  const explicit = explicitSession(options?.headers, model.headers);
  const session =
    explicit?.value ??
    (options?.sessionId === undefined ? undefined : conversationSession(options.sessionId));
  for (const carrier of [model.headers, options?.headers]) {
    for (const [name, value] of Object.entries(carrier ?? {})) {
      if (
        SESSION_HEADERS.has(name.toLowerCase()) &&
        name.toLowerCase() !== NATIVE_SESSION &&
        value !== session
      ) {
        throw new Error("Conflicting OpenCode and ClawRouter session headers");
      }
    }
  }
  const callerHeaders = { ...options?.headers };
  // Remove native/static/legacy overrides from both SDK carriers. Absence stays absent,
  // allowing the Worker to isolate standalone ingress requests with its own nonce.
  removeSessionHeaders(headers);
  removeSessionHeaders(callerHeaders);
  if (session !== undefined) {
    headers[ROUTER_SESSION] = session;
  }
  return { ...options, headers: callerHeaders };
}

export function resolveOpenCodeProxyTurnState(ctx: ProviderResolveTransportTurnStateContext) {
  if (!ctx.model || ctx.transport !== "stream") {
    return undefined;
  }
  const provider = selectedOpenCode(ctx.model);
  if (!provider || explicitSession(ctx.model.headers)) {
    return undefined;
  }
  const identity = ctx.sessionId ?? (provider === "opencode-go" ? ctx.turnId : undefined);
  if (identity === undefined) {
    return undefined;
  }
  // Reuse the native Go hook's host-provided turn fallback. The stream bridge consumes
  // this internal header and removes it before the actual SDK request.
  return { headers: { [NATIVE_SESSION]: conversationSession(identity) } };
}
