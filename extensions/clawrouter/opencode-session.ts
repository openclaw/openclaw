import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ModelRequestHeaders } from "openclaw/plugin-sdk/llm";
import type {
  ProviderResolveTransportTurnStateContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAWROUTER_ROUTE_METADATA_KEY } from "./provider-policy-api.js";

const NATIVE_SESSION = "x-opencode-session";
const ROUTER_SESSION = "x-clawrouter-session-id";
const SESSION_HEADERS = new Set([
  NATIVE_SESSION,
  ROUTER_SESSION,
  "x-claude-code-session-id",
  "session-id",
]);

function selectedOpenCode(model: ProviderRuntimeModel, sourceApi = model.api) {
  if (model.provider !== "clawrouter") return undefined;
  const provider = model.id.startsWith("opencode/")
    ? "opencode"
    : model.id.startsWith("opencode-go/")
      ? "opencode-go"
      : undefined;
  if (!provider) return undefined;
  const route = asOptionalRecord(model.params?.[CLAWROUTER_ROUTE_METADATA_KEY]);
  const upstream = model.id.slice(provider.length + 1);
  if (
    !upstream ||
    !route ||
    route.api !== sourceApi ||
    route.baseUrl !== model.baseUrl ||
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(sourceApi)
  ) {
    throw new Error(
      "ClawRouter OpenCode session binding requires a qualified Chat, Responses or Messages route",
    );
  }
  const url = new URL(model.baseUrl);
  const native = `/v1/native/${provider}`;
  const nativeBase = sourceApi === "openai-responses" ? native + "/v1" : native;
  const unified =
    sourceApi !== "anthropic-messages" &&
    url.pathname.endsWith("/v1") &&
    !url.pathname.includes("/v1/native/") &&
    route.upstreamModel === undefined;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (!unified && (!url.pathname.endsWith(nativeBase) || route.upstreamModel !== upstream))
  ) {
    throw new Error("ClawRouter OpenCode session binding does not match the selected proxy route");
  }
  return provider;
}

function explicitSession(headers: ModelRequestHeaders | undefined) {
  const entries = Object.entries(headers ?? {}).filter(
    ([name]) => name.toLowerCase() === NATIVE_SESSION,
  );
  if (entries.length === 0) return undefined;
  const value = entries[0]![1];
  if (entries.some(([, candidate]) => candidate !== value)) {
    throw new Error("Conflicting case-insensitive OpenCode session headers");
  }
  return { value };
}

function validateSession(value: string): string {
  const normalized = value.trim();
  // Match the existing router attribution grammar; never hash malformed input into an alias.
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._~:/+@=-]+$/u.test(normalized)) {
    throw new Error(
      "OpenCode session identity must match the ClawRouter ASCII attribution format (1-256 characters)",
    );
  }
  return normalized;
}

function removeSessionHeaders(headers: ModelRequestHeaders) {
  for (const name of Object.keys(headers)) {
    if (SESSION_HEADERS.has(name.toLowerCase())) delete headers[name];
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
  if (!selectedOpenCode(model, params.sourceApi)) return options;
  const explicit = explicitSession(options?.headers) ?? explicitSession(model.headers);
  const identity = explicit ? explicit.value : options?.sessionId;
  const session = identity == null ? undefined : validateSession(identity);
  const callerHeaders = { ...options?.headers };
  // Remove native/static/legacy overrides from both SDK carriers. Absence stays absent,
  // allowing the Worker to isolate standalone ingress requests with its own nonce.
  removeSessionHeaders(headers);
  removeSessionHeaders(callerHeaders);
  if (session !== undefined) headers[ROUTER_SESSION] = session;
  return { ...options, headers: callerHeaders };
}

export function resolveOpenCodeProxyTurnState(ctx: ProviderResolveTransportTurnStateContext) {
  if (!ctx.model || ctx.transport !== "stream") return undefined;
  const provider = selectedOpenCode(ctx.model);
  if (!provider || explicitSession(ctx.model.headers)) return undefined;
  const identity =
    ctx.sessionId?.trim() || (provider === "opencode-go" ? ctx.turnId.trim() : undefined);
  if (!identity) return undefined;
  // Reuse the native Go hook's host-provided turn fallback. The stream bridge consumes
  // this internal header and removes it before the actual SDK request.
  return { headers: { [NATIVE_SESSION]: validateSession(identity) } };
}
