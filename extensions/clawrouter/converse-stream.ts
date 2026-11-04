import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  readProviderBinaryResponse,
} from "openclaw/plugin-sdk/provider-http";
import { createConverseStreamFn } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchWithSsrFGuard, mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";
import { CONVERSE_MODEL, converseBaseUrl, selectConverseOffer } from "./converse-offer.js";
import { CLAWROUTER_ROUTE_METADATA_KEY } from "./provider-policy-api.js";

const MAX_BYTES = 2 * 1024 * 1024;

export function createClawRouterConverseStream(
  ctx: Parameters<NonNullable<ProviderPlugin["createStreamFn"]>>[0],
) {
  if (ctx.model.api !== "bedrock-converse-stream") {
    return undefined;
  }
  const route = asOptionalRecord(ctx.model.params?.[CLAWROUTER_ROUTE_METADATA_KEY]);
  return createConverseStreamFn(async (model, options) => {
    options.signal?.throwIfAborted();
    if (
      ctx.provider !== "clawrouter" ||
      model.provider !== "clawrouter" ||
      ctx.modelId !== "aws-bedrock/" + CONVERSE_MODEL ||
      model.id !== CONVERSE_MODEL ||
      route?.api !== model.api ||
      route.upstreamModel !== model.id ||
      route.baseUrl !== model.baseUrl
    ) {
      throw new Error("ClawRouter Converse requires its exact catalog-selected model and route");
    }
    const auth = ctx.requestAuth
      ? await ctx.requestAuth.resolve({ signal: options.signal })
      : { apiKey: options.apiKey?.trim() ?? "", assertCurrent() {} };
    if (!auth.apiKey || auth.apiKey === "CLAWROUTER_API_KEY") {
      throw new Error("ClawRouter Converse requires the selected proxy key");
    }
    auth.assertCurrent();
    const http = resolveClawRouterCapabilityHttpContext(ctx.config ?? {}, auth.apiKey, "llm");
    const remaining = createProviderOperationTimeoutResolver({
      deadline: createProviderOperationDeadline({
        timeoutMs: options.timeoutMs ?? 120_000,
        label: "ClawRouter Converse",
      }),
      defaultTimeoutMs: 120_000,
    });
    const offers = await fetchClawRouterCapabilityOffers({
      context: http,
      timeoutMs: remaining,
      signal: options.signal,
      requireFreshProxyCatalog: true,
    });
    const offer = selectConverseOffer(offers, ctx.modelId, model.id);
    if (!offer || converseBaseUrl(offer) !== model.baseUrl) {
      throw new Error("ClawRouter Converse has no current matching proxy-key offer");
    }
    const sdkPath =
      new URL(model.baseUrl).pathname.replace(/\/+$/u, "") +
      "/model/" +
      encodeURIComponent(model.id) +
      "/converse-stream";
    return {
      endpoint: model.baseUrl,
      apiKey: auth.apiKey,
      async send(request, signal) {
        // The native SDK's JsonCodec2 emits UTF-8 bytes, not necessarily a string.
        const serialized =
          typeof request.body === "string"
            ? Buffer.from(request.body, "utf8")
            : request.body instanceof Uint8Array
              ? request.body
              : undefined;
        if (
          request.method !== "POST" ||
          request.path !== sdkPath ||
          Object.keys(request.query).length ||
          !serialized ||
          serialized.byteLength > MAX_BYTES
        ) {
          throw new Error("ClawRouter Converse rejected the serialized SDK request");
        }
        const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(serialized);
        const payload: unknown = JSON.parse(json);
        const record = asOptionalRecord(payload);
        if (!record || "modelId" in record || "model" in record) {
          throw new Error("ClawRouter Converse model belongs to the selected path");
        }
        const body =
          offer.routeKind === "manifest"
            ? JSON.stringify({
                method: "POST",
                pathParams: { model: model.id },
                query: {},
                body: payload,
              })
            : json;
        if (Buffer.byteLength(body) > MAX_BYTES) {
          throw new Error("ClawRouter Converse envelope exceeds the request limit");
        }
        const headers = new Headers({
          Authorization: "Bearer " + auth.apiKey,
          "Content-Type": "application/json",
          Accept: "application/vnd.amazon.eventstream",
          "X-ClawRouter-Client": "openclaw",
        });
        for (const [name, value] of Object.entries({ ...model.headers, ...options.headers })) {
          if (
            /^x-clawrouter-(?:agent-id|session-id|request-id)$/iu.test(name) &&
            typeof value === "string"
          ) {
            headers.set(name, value);
          }
        }
        const { response, release, finalUrl } = await fetchWithSsrFGuard({
          url: offer.url,
          init: { method: "POST", headers, body, signal },
          timeoutMs: remaining(),
          maxRedirects: 0,
          policy: mergeSsrFPolicies(
            http.ssrfPolicy,
            http.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
          ),
          dispatcherPolicy: http.dispatcherPolicy,
          auditContext: "clawrouter.converse",
          beforeRequest: () => {
            signal?.throwIfAborted();
            auth.assertCurrent();
          },
        });
        try {
          if (
            response.status !== 200 ||
            finalUrl !== offer.url ||
            response.redirected ||
            response.headers.get("content-type")?.trim().toLowerCase() !==
              "application/vnd.amazon.eventstream" ||
            response.headers.has("content-range") ||
            ![null, "identity"].includes(response.headers.get("content-encoding"))
          ) {
            throw new Error("ClawRouter Converse did not return a complete EventStream response");
          }
          const bytes = await readProviderBinaryResponse(
            response,
            "ClawRouter Converse",
            "EventStream",
            {
              maxBytes: MAX_BYTES,
              timeoutMs: remaining,
            },
          );
          signal?.throwIfAborted();
          return {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
            body: bytes,
          };
        } finally {
          void response.body?.cancel().catch(() => undefined);
          await release();
        }
      },
    };
  });
}
