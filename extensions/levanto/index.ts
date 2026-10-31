import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  ProviderHttpError,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  decodeSageDecisionResult,
  encodeSageDecisionInput,
  encodeSageDecisionRequest,
} from "./decision-codec.js";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageImage,
  type SageImageProbe,
} from "./sage-validation.js";

class SageRequestError extends Error {
  constructor() {
    super("Invalid Sage request");
  }
}
class SageResponseError extends Error {
  constructor() {
    super("Sage: invalid or oversized response");
  }
}

export default definePluginEntry({
  id: "levanto",
  name: "Levanto Sage",
  description: "Native typed decisions with explicit abstention.",
  register(api) {
    const probeImage: SageImageProbe = (bytes) => api.runtime.media.getImageMetadata(bytes);
    const provider: DecisionProviderV2 = {
      id: "levanto",
      contractVersion: 2,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        if (
          context.model.provider !== "levanto" ||
          context.model.id !== "levanto-sage" ||
          context.model.api !== undefined
        ) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (!context.auth.apiKey) {
          // Effective headers never provide a second credential-discovery route.
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        let encoded: ReturnType<typeof encodeSageDecisionInput>;
        try {
          encoded = encodeSageDecisionInput(batch);
        } catch {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (!encoded) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        const { nativeContent, questions } = encoded;
        const remainingBudgetMs = context.deadlineMonotonicMs - performance.now();
        if (remainingBudgetMs <= 0) {
          return { status: "unavailable", reason: "transport" };
        }
        const request = encodeSageDecisionRequest(nativeContent, questions, context.reasoning);
        if (!request) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        let admissionError: { error: unknown } | undefined;
        try {
          const configuredRequest = resolveMergedModelProviderConfig(
            context.config,
            "levanto",
          )?.request;
          // The host has already resolved header/SecretRef precedence and explicit auth.
          // Only network policy is read here; never resolve or replay configured credentials.
          const networkRequest = sanitizeConfiguredModelProviderRequest({
            proxy: configuredRequest?.proxy,
            tls: configuredRequest?.tls,
            allowPrivateNetwork: configuredRequest?.allowPrivateNetwork,
          });
          const route = resolveProviderHttpRequestConfig({
            provider: "levanto",
            baseUrl: context.model.baseUrl,
            defaultBaseUrl: "https://sage.levanto.ai",
            api: context.model.api,
            capability: "other",
            transport: "http",
            headers: context.model.headers,
            defaultHeaders:
              configuredRequest?.auth?.mode === "header" ||
              configuredRequest?.auth?.mode === "authorization-bearer"
                ? undefined
                : { Authorization: `Bearer ${context.auth.apiKey}` },
            request: networkRequest,
          });
          const budget = context.deadlineMonotonicMs - performance.now();
          if (budget <= 0) {
            return { status: "unavailable", reason: "transport" };
          }
          const deadline = createProviderOperationDeadline({
            label: "Sage decision",
            timeoutMs: budget,
          });
          const beforeRequest = () => {
            let admitted: boolean;
            try {
              admitted = context.isAdmissible();
            } catch (error) {
              // Host authority failures must not become a retryable provider failure.
              admissionError = { error };
              throw error;
            }
            if (!admitted) {
              throw new Error("Sage evaluation is no longer admitted.");
            }
          };
          const response = await (async () => {
            // A finite deadline is mandatory. Never silently substitute the SDK's 60-second timeout.
            if (!Number.isFinite(deadline.deadlineAtMs)) {
              throw new Error("Sage requires a finite operation deadline");
            }
            const remaining = createProviderOperationTimeoutResolver({
              deadline,
              defaultTimeoutMs: 2_147_483_647,
            });
            context.signal?.throwIfAborted();
            remaining();
            if (typeof nativeContent !== "string" && nativeContent.kind === "image") {
              const media = nativeContent.media;
              const validation = buildTimeoutAbortSignal({
                signal: context.signal,
                timeoutMs: remaining(),
                operation: "Sage input validation",
              });
              const signal = validation.signal;
              try {
                // The probe may await native media work; cancellation must prevent a later POST.
                await racePromiseWithAbortSignal(
                  () => validateSageImage(media, probeImage),
                  signal,
                );
                signal?.throwIfAborted();
              } catch {
                context.signal?.throwIfAborted();
                signal?.throwIfAborted();
                remaining();
                throw new SageRequestError();
              } finally {
                validation.cleanup();
              }
            }
            context.signal?.throwIfAborted();
            remaining();
            const base = new URL(route.baseUrl);
            if (
              !["https:", "http:"].includes(base.protocol) ||
              base.username ||
              base.password ||
              base.search ||
              base.hash
            ) {
              throw new Error("Invalid Sage base URL");
            }
            // Append to a configured prefix; an absolute /decide would silently escape it.
            base.pathname =
              base.pathname.replace(/\/+$/, "") +
              ("requests" in request ? "/decide/batch" : "/decide");
            const headers = new Headers(route.headers);
            headers.set("content-type", "application/json");
            const guardedRequest = {
              url: base.href,
              init: { method: "POST", headers, body: JSON.stringify(request) },
              timeoutMs: remaining(),
              signal: context.signal,
              fetchImpl: globalThis.fetch,
              dispatcherPolicy: route.dispatcherPolicy,
              policy: route.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
              auditContext: "levanto-sage",
              // Recheck the owner after image validation and DNS, before each HTTP effect.
              beforeRequest,
            };
            // Preserve the provider HTTP helper's implicit proxy policy without retrying a billable POST.
            const result = await fetchWithSsrFGuard(
              !route.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(base.href)
                ? withTrustedEnvProxyGuardedFetchMode(guardedRequest)
                : guardedRequest,
            );
            try {
              await assertOkOrThrowProviderError(result.response, "Sage request failed", {
                signal: context.signal,
                bodyTimeoutMs: remaining,
                requestHeaders: headers,
              });
              try {
                const payload = await readProviderJsonResponse<unknown>(result.response, "Sage", {
                  signal: context.signal,
                  timeoutMs: remaining,
                  requestHeaders: headers,
                });
                const parsed =
                  "requests" in request
                    ? parseSageBatchResponse(payload, request)
                    : parseSageResponse(payload, request.question, request.content);
                // Include decode and validation in the caller's total budget, not just response headers.
                context.signal?.throwIfAborted();
                remaining();
                return parsed;
              } catch {
                context.signal?.throwIfAborted();
                remaining();
                throw new SageResponseError();
              }
            } finally {
              await result.release();
            }
          })();
          context.signal.throwIfAborted();
          if (performance.now() >= context.deadlineMonotonicMs) {
            return { status: "unavailable", reason: "transport" };
          }
          return decodeSageDecisionResult(
            batch,
            questions,
            response,
            context.model.id,
            context.model.inference?.decision,
          );
        } catch (error) {
          if (admissionError) {
            throw admissionError.error;
          }
          context.signal.throwIfAborted();
          if (error instanceof ProviderHttpError) {
            const reason =
              error.status === 401 || error.status === 403
                ? "authentication"
                : error.status === 429
                  ? "rate-limited"
                  : error.status === 400 || error.status === 413 || error.status === 422
                    ? "unsupported-input"
                    : "transport";
            return {
              status: "unavailable",
              reason,
              ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            };
          }
          return {
            status: "unavailable",
            reason:
              error instanceof SageRequestError
                ? "unsupported-input"
                : error instanceof SageResponseError
                  ? "invalid-response"
                  : "transport",
          };
        }
      },
    };

    api.registerDecisionProvider({
      ...provider,
      provider: {
        label: "Levanto Sage",
        docsPath: "/providers/levanto",
        authScope: "agent",
        envVars: ["LEVANTO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "levanto",
            methodId: "api-key",
            label: "Levanto API key",
            optionKey: "levantoApiKey",
            flagName: "--levanto-api-key",
            envVar: "LEVANTO_API_KEY",
            promptMessage: "Enter your Levanto API key",
            // Connecting credentials never changes a conversational or decision model selection.
            wizard: {
              choiceId: "levanto-api-key",
              choiceLabel: "Levanto API key",
              groupId: "levanto",
              groupLabel: "Levanto Sage",
              modelTarget: "utility",
            },
          }),
        ],
      },
    });
  },
});
