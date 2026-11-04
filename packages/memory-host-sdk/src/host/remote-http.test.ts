import { describe, expect, it, vi } from "vitest";
import { formatErrorMessageForDisplay } from "../../../../src/infra/error-diagnostics.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { createProviderHttpError, type fetchWithSsrFGuard } from "./openclaw-runtime-network.js";
import { withRemoteHttpResponse, type RemoteEmbeddingRequestAuth } from "./remote-http.js";

describe("package withRemoteHttpResponse", () => {
  it.each([
    { auth: true, code: "token_expired", crossOrigin: false, roundTrip: false, retries: 1 },
    { auth: true, code: "invalid_api_key", crossOrigin: false, roundTrip: false, retries: 0 },
    {
      auth: true,
      code: "invalid_authentication",
      crossOrigin: false,
      roundTrip: false,
      retries: 0,
    },
    { auth: false, code: "token_expired", crossOrigin: false, roundTrip: false, retries: 0 },
    { auth: true, code: "token_expired", crossOrigin: true, roundTrip: false, retries: 0 },
    { auth: true, code: "invalid_authentication", crossOrigin: false, roundTrip: true, retries: 0 },
  ])(
    "retries expired OAuth once (auth=$auth, code=$code, crossOrigin=$crossOrigin, roundTrip=$roundTrip)",
    async ({ auth, code, crossOrigin, roundTrip, retries }) => {
      const events: string[] = [];
      const resolveRequestHeaders = vi.fn<RemoteEmbeddingRequestAuth>(
        async ({ forceRefresh, onAuthResolved }) => {
          events.push(forceRefresh ? "refresh" : "resolve");
          onAuthResolved?.(
            forceRefresh
              ? { mode: "api-key", source: "environment" }
              : { mode: "oauth", source: "stored-profile" },
          );
          return { Authorization: forceRefresh ? "Bearer fixture-new" : "Bearer fixture-old" };
        },
      );
      const fetchWithSsrFGuardImpl = vi.fn(
        async (params: Parameters<typeof fetchWithSsrFGuard>[0]) => {
          events.push(new Headers(params.init?.headers).get("Authorization") ?? "missing");
          if (crossOrigin || roundTrip) {
            params.onResponse?.(307);
          }
          if (roundTrip) {
            params.onResponse?.(307);
          }
          params.onResponse?.(401);
          return {
            response: Response.json(
              { error: { code, message: "rejected fixture-new" } },
              { status: 401 },
            ),
            finalUrl: crossOrigin ? "https://redirect.example/embeddings" : params.url,
            release: async () => {
              events.push("release");
            },
          };
        },
      );
      const result = withRemoteHttpResponse({
        url: "https://memory.example/v1/embeddings",
        init: { headers: { Authorization: "Bearer fixture-static" } },
        resolveRequestHeaders: auth ? resolveRequestHeaders : undefined,
        resolveRequestAuthDiagnostic: () => ({
          mode: "configured-bearer",
          source: "memory-config",
        }),
        publicDiagnosticEndpoint: "https://api.openai.com/v1/embeddings",
        fetchWithSsrFGuardImpl,
        shouldUseEnvHttpProxyForUrlImpl: () => false,
        onResponse: async (response, requestHeaders) => {
          throw await createProviderHttpError(response, "embedding request failed", {
            requestHeaders,
          });
        },
      });
      await expect(result).rejects.toMatchObject({ status: 401, code });
      expect(fetchWithSsrFGuardImpl).toHaveBeenCalledTimes(1 + retries);
      expect(events).toEqual([
        ...(auth ? ["resolve", "Bearer fixture-old"] : ["Bearer fixture-static"]),
        "release",
        ...(retries ? ["refresh", "Bearer fixture-new", "release"] : []),
      ]);
      if (retries) {
        await expect(result).rejects.not.toThrow("fixture-new");
      }
      const diagnostic = formatErrorMessageForDisplay(
        await result.catch((error: unknown) => error),
      );
      expect(diagnostic).toContain(
        crossOrigin || roundTrip
          ? "auth_mode=unknown, credential_source=unknown"
          : retries
            ? "auth_mode=api-key, credential_source=environment"
            : auth
              ? "auth_mode=oauth, credential_source=stored-profile"
              : "auth_mode=configured-bearer, credential_source=memory-config",
      );
      expect(diagnostic).toContain(
        `endpoint=custom (redacted); HTTP 401; force_refresh_requested=${Boolean(retries)}`,
      );
      expect(diagnostic.includes("Redirect observed")).toBe(crossOrigin || roundTrip);
      expect(diagnostic).not.toContain("memory.example");
    },
  );

  it("keeps per-dispatch facts isolated when concurrent auth selections finish out of order", async ({
    signal,
  }) => {
    const firstDispatched = createDeferred();
    const completeFirst = createDeferred();
    let selections = 0;
    const resolveRequestHeaders: RemoteEmbeddingRequestAuth = async ({ onAuthResolved }) => {
      selections += 1;
      onAuthResolved?.(
        selections === 1
          ? { mode: "oauth", source: "stored-profile" }
          : { mode: "api-key", source: "environment" },
      );
      return { Authorization: `Bearer fixture-${selections}` };
    };
    const perform = () =>
      withRemoteHttpResponse({
        url: "https://api.openai.com/v1/embeddings",
        publicDiagnosticEndpoint: "https://api.openai.com/v1/embeddings",
        resolveRequestHeaders,
        shouldUseEnvHttpProxyForUrlImpl: () => false,
        fetchWithSsrFGuardImpl: async (params) => {
          if (new Headers(params.init?.headers).get("authorization") === "Bearer fixture-1") {
            firstDispatched.resolve();
            await completeFirst.promise;
          }
          return {
            response: Response.json({ error: { code: "invalid_authentication" } }, { status: 401 }),
            finalUrl: params.url,
            release: async () => {},
          };
        },
        onResponse: async (response, requestHeaders) => {
          throw await createProviderHttpError(response, "embedding request failed", {
            requestHeaders,
          });
        },
      }).catch((error: unknown) => error);
    const first = perform();
    try {
      await withinTest(
        awaitGateBeforeSettlement(firstDispatched.promise, first, "first request did not dispatch"),
        signal,
      );
      const secondError = await withinTest(perform(), signal);
      expect(formatErrorMessageForDisplay(secondError)).toContain(
        "auth_mode=api-key, credential_source=environment",
      );
      completeFirst.resolve();
      const firstError = await withinTest(first, signal);
      expect(formatErrorMessageForDisplay(firstError)).toContain(
        "auth_mode=oauth, credential_source=stored-profile; endpoint=https://api.openai.com/v1/embeddings",
      );
      expect(selections).toBe(2);
    } finally {
      completeFirst.resolve();
      await first;
    }
  });

  it("preserves a frozen rejection and masks untrusted auth facts and custom URLs", async () => {
    const cause = new Error("fixture cause");
    const error = Object.assign(new Error("embedding rejected"), {
      status: 401,
      code: "invalid_authentication",
      cause,
    });
    Object.freeze(error);
    const result = withRemoteHttpResponse({
      url: "https://private-endpoint.example/embeddings?token=private-query-marker",
      publicDiagnosticEndpoint: "https://api.openai.com/v1/embeddings",
      resolveRequestHeaders: async ({ onAuthResolved }) => {
        onAuthResolved?.({
          // @ts-expect-error Runtime plugin input can violate the diagnostic contract.
          mode: "untrusted-mode-marker",
          // @ts-expect-error Runtime plugin input can violate the diagnostic contract.
          source: "untrusted-source-marker",
        });
        return { Authorization: "Bearer private-credential-marker" };
      },
      fetchWithSsrFGuardImpl: async (params) => ({
        response: new Response("denied", { status: 401 }),
        finalUrl: params.url,
        release: async () => {},
      }),
      shouldUseEnvHttpProxyForUrlImpl: () => false,
      onResponse: async () => {
        throw error;
      },
    });
    await expect(result).rejects.toBe(error);
    expect(error).toMatchObject({
      message: "embedding rejected",
      code: "invalid_authentication",
      cause,
    });
    expect(formatErrorMessageForDisplay(error)).toBe(
      "embedding rejected | fixture cause\nEmbedding client request: auth_mode=unknown, credential_source=unknown; endpoint=custom (redacted); HTTP 401; force_refresh_requested=false.",
    );
  });

  it.each([true, false])("forwards signal and selects env proxy mode: %s", async (useEnvProxy) => {
    const signal = new AbortController().signal;
    const url = "https://memory.example/v1/embeddings";
    const fetchWithSsrFGuardImpl = vi.fn(
      async (_params: Parameters<typeof fetchWithSsrFGuard>[0]) => ({
        response: new Response("ok"),
        finalUrl: url,
        release: async () => {},
      }),
    );
    await withRemoteHttpResponse({
      url,
      signal,
      fetchWithSsrFGuardImpl,
      shouldUseEnvHttpProxyForUrlImpl: () => useEnvProxy,
      onResponse: async () => undefined,
    });
    expect(fetchWithSsrFGuardImpl).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url, signal }),
    );
    const call = fetchWithSsrFGuardImpl.mock.calls[0]?.[0];
    if (useEnvProxy) {
      expect(call).toHaveProperty("mode", "trusted_env_proxy");
    } else {
      expect(call).not.toHaveProperty("mode");
    }
  });
});
