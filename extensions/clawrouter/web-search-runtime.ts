import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  externalContentStamp,
  nativeWebSearchCodecs,
  readPositiveIntegerParam,
  readStringParam,
  wrapWebContent,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolExecutionContext,
} from "openclaw/plugin-sdk/provider-web-search";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";

export async function searchClawRouter(
  ctx: Parameters<WebSearchProviderPlugin["createTool"]>[0],
  args: Record<string, unknown>,
  execution?: WebSearchProviderToolExecutionContext,
): Promise<Record<string, unknown>> {
  const query = readStringParam(args, "query", { required: true });
  if (!query.trim() || query.length > 4_000) {
    throw new Error("ClawRouter search requires 1-4000 query characters");
  }
  const count = readPositiveIntegerParam(args, "count", { max: 10 }) ?? 5;
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline: createProviderOperationDeadline({ timeoutMs: 30_000, label: "ClawRouter search" }),
    defaultTimeoutMs: 30_000,
  });
  execution?.signal?.throwIfAborted();
  execution?.assertCurrent?.();
  const cfg = ctx.config ?? {};
  const auth = await resolveApiKeyForProvider({
    provider: "clawrouter",
    cfg,
    agentDir: ctx.agentDir,
    signal: execution?.signal,
  });
  if (!auth.apiKey) {
    throw new Error("Configure a ClawRouter API key for web search");
  }
  const context = resolveClawRouterCapabilityHttpContext(cfg, auth.apiKey);
  const offers = await fetchClawRouterCapabilityOffers({
    context,
    timeoutMs,
    signal: execution?.signal,
  });
  const offer = offers.find((candidate) => {
    const codec = searchCodec(candidate.requestFormat);
    return (
      codec &&
      candidate.responseFormat === candidate.requestFormat &&
      candidate.methods.includes(codec.method) &&
      (candidate.routeKind === "native" || candidate.routeKind === "manifest") &&
      (!candidate.model ||
        (Array.isArray(candidate.model.capabilities) &&
          candidate.model.capabilities.includes("web.search")))
    );
  });
  const codec = offer && searchCodec(offer.requestFormat);
  if (!offer || !codec) {
    throw new Error("ClawRouter has no eligible search offer with a supported wire format");
  }
  if (offer.requestFormat === "parallel.search" && query.length > 200) {
    throw new Error("ClawRouter Parallel search accepts at most 200 query characters");
  }
  const request = codec.request(offer.url, query, count);
  execution?.signal?.throwIfAborted();
  execution?.assertCurrent?.();
  const headers = new Headers(context.headers);
  headers.set("Accept", "application/json");
  if ("body" in request) {
    headers.set("Content-Type", "application/json");
  }
  const { response, release } = await fetchWithTimeoutGuarded(
    request.url,
    {
      method: codec.method,
      headers,
      body:
        "body" in request
          ? JSON.stringify(offer.routeKind === "manifest" ? { body: request.body } : request.body)
          : undefined,
      signal: execution?.signal,
    },
    timeoutMs(),
    fetch,
    {
      ssrfPolicy: mergeSsrFPolicies(
        context.ssrfPolicy,
        context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: context.dispatcherPolicy,
      auditContext: "clawrouter.web-search",
    },
  );
  try {
    if (!response.ok) {
      throw new Error(`ClawRouter search failed (HTTP ${response.status})`);
    }
    const payload = asOptionalRecord(
      await readProviderJsonResponse(response, "clawrouter.web-search", {
        maxBytes: 1024 * 1024,
        timeoutMs,
      }),
    );
    timeoutMs();
    execution?.signal?.throwIfAborted();
    execution?.assertCurrent?.();
    const envelope =
      offer.requestFormat === "brave.search" ? asOptionalRecord(payload?.web) : payload;
    if (!Array.isArray(envelope?.results)) {
      throw new Error("ClawRouter search returned a malformed result");
    }
    const results = codec.results(payload, count).flatMap((row) => {
      let url: URL;
      try {
        url = new URL(row.url);
      } catch {
        return [];
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return [];
      }
      return [{ ...row, url: url.href }];
    });
    return {
      query,
      provider: "clawrouter",
      count: results.length,
      results,
      externalContent: externalContentStamp("clawrouter"),
    };
  } finally {
    void response.body?.cancel().catch(() => undefined);
    await release();
  }
}

function searchCodec(format: string) {
  if (Object.hasOwn(nativeWebSearchCodecs, format)) {
    // SAFETY: The own-property check restricts the wire format to a declared codec key.
    return nativeWebSearchCodecs[format as keyof typeof nativeWebSearchCodecs];
  }
  return format === "tavily.search" ? tavilySearchCodec : undefined;
}

const tavilySearchCodec = {
  method: "POST",
  request(url: string, query: string, count: number) {
    return { url, body: { query, max_results: count } };
  },
  results(payload: unknown, count: number) {
    const results = asOptionalRecord(payload)?.results;
    return (Array.isArray(results) ? results : []).slice(0, count).flatMap((value: unknown) => {
      const row = asOptionalRecord(value);
      if (typeof row?.url !== "string") {
        return [];
      }
      return [
        {
          url: row.url,
          title: wrapWebContent(
            typeof row.title === "string" ? truncateUtf16Safe(row.title, 500) : "",
            "web_search",
          ),
          snippet: wrapWebContent(
            typeof row.content === "string" ? truncateUtf16Safe(row.content, 4_000) : "",
            "web_search",
          ),
        },
      ];
    });
  },
};
