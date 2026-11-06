import { isGatewayClientRequestError } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ResearchRequest, ResearchResult } from "./contract.js";
import type { ResearchExecution } from "./execution.js";
import type {
  ResearchAdapterReply,
  ResearchAdapterRequest,
  ResearchAdapterSnapshot,
} from "./managed-contract.js";

export function assertManagedRequest(request: ResearchRequest) {
  if (
    request.model ||
    request.requiredAuthMode ||
    request.sources ||
    Object.keys(request.budget ?? {}).length > 0
  ) {
    throw new Error(
      "Google managed research does not support local model/auth overrides, supplied sources/domain policy, or local duration/call/token budgets. Use the portable engine for these constraints.",
    );
  }
}

/** These structured router refusals occur before this write-route handler. The
 * provider reports endpoint outcomes inside successful RPC envelopes instead.
 * Transport failures, timeouts and unclassified protocol errors remain ambiguous. */
function refusedBeforeProviderDispatch(error: unknown) {
  if (!isGatewayClientRequestError(error) || !error.details || typeof error.details !== "object") {
    return false;
  }
  const code = "code" in error.details ? error.details.code : undefined;
  if (
    error.gatewayCode === "FORBIDDEN" &&
    (code === "SESSION_ACCESS_CHANGED" || code === "SESSION_RESOURCE_TOOL_POLICY")
  ) {
    return true;
  }
  return (
    error.gatewayCode === "UNAVAILABLE" &&
    error.retryable &&
    (code === "SESSION_ACCESS_REFRESHING" ||
      code === "PAIRING_CHANGED" ||
      ("reason" in error.details && error.details.reason === "startup-sidecars"))
  );
}

export function managedClient(
  api: OpenClawPluginApi,
  context: ResearchExecution,
  startCustody?: {
    dispatched: () => void;
    retainOutcome: (handle?: ResearchAdapterSnapshot["handle"]) => Promise<void>;
  },
) {
  return async (
    request: ResearchAdapterRequest,
    signal: AbortSignal,
  ): Promise<ResearchAdapterReply> => {
    signal.throwIfAborted();
    context.assertInvocationCurrent();
    let response: ResearchAdapterReply;
    try {
      if (request.action === "start") {
        startCustody?.dispatched();
      }
      response = await api.runtime.gateway.request<ResearchAdapterReply>(
        "google.research.v1",
        { sessionKey: context.sessionKey, agentId: context.agentId, request },
        { signal },
      );
    } catch (error) {
      if (refusedBeforeProviderDispatch(error) && isGatewayClientRequestError(error)) {
        const retryAfterMs = error.retryable ? 5000 : undefined;
        if (request.action === "start" || request.action === "describe") {
          response = {
            version: 1,
            ok: false,
            state: "blocked",
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            reason:
              "Gateway refused this request before provider dispatch; fresh authority is required.",
          };
        } else if ((request.action === "poll" || request.action === "cancel") && error.retryable) {
          response = {
            version: 1,
            ok: false,
            state: "indeterminate",
            handle: request.handle,
            retryAfterMs,
            reason:
              "Gateway preparation is temporarily unavailable; reconciliation will retry with fresh authority.",
          };
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (request.action === "start") {
      const handle =
        response.ok && "state" in response.value
          ? response.value.handle
          : !response.ok
            ? response.handle
            : undefined;
      // A receipt or definitive refusal is a local custody fact, not permission
      // to continue. Record it before delivery fences can discard the outcome.
      if (handle || (!response.ok && response.state === "blocked")) {
        await startCustody?.retainOutcome(handle);
      }
    }
    signal.throwIfAborted();
    context.assertInvocationCurrent();
    return response;
  };
}

/** Cancellation is a request, not a terminal observation. A rejected cancellation
 * must not prevent retrieving a report that finished in the meantime. */
export async function reconcileManaged(
  client: ReturnType<typeof managedClient>,
  handle: ResearchAdapterSnapshot["handle"],
  cancelRequested: boolean,
  signal: AbortSignal,
) {
  if (!cancelRequested) {
    return client({ version: 1, action: "poll", handle }, signal);
  }
  try {
    const response = await client({ version: 1, action: "cancel", handle }, signal);
    if (response.ok) {
      return response;
    }
  } catch {
    // The next client invocation revalidates signal and authority before any effect.
  }
  return client({ version: 1, action: "poll", handle }, signal);
}

export function managedResult(snapshot: ResearchAdapterSnapshot): ResearchResult {
  return {
    version: 1,
    engine: "managed",
    status:
      snapshot.state === "completed"
        ? "completed"
        : snapshot.state === "cancelled"
          ? "cancelled"
          : "partial",
    report: snapshot.report ?? "No provider report is available.",
    findings: [],
    sources: [],
    providerCitations: snapshot.citations,
    gaps: snapshot.reason ? [snapshot.reason] : [],
    limitations: [
      "Citations are provider-attributed generated text, not locally fetched or independently verified source passages.",
      "Google stores this research interaction. API-key billing/storage apply; no consumer OAuth or hard per-job token/search/cost cap is implied.",
    ],
    usage: {
      modelCalls: 0,
      searches: 0,
      fetches: 0,
      reportedTokens: snapshot.usageTokens ?? 0,
      tokensComplete: snapshot.usageTokens !== undefined,
    },
    route: { model: "google/managed-research", runtime: "managed-service" },
  };
}
