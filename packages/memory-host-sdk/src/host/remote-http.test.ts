import { describe, expect, it, vi } from "vitest";
import { createProviderHttpError, type fetchWithSsrFGuard } from "./openclaw-runtime-network.js";
import { withRemoteHttpResponse } from "./remote-http.js";

describe("package withRemoteHttpResponse", () => {
  it.each([
    { auth: true, code: "token_expired", crossOrigin: false, retries: 1 },
    { auth: true, code: "invalid_api_key", crossOrigin: false, retries: 0 },
    { auth: false, code: "token_expired", crossOrigin: false, retries: 0 },
    { auth: true, code: "token_expired", crossOrigin: true, retries: 0 },
  ])(
    "retries expired OAuth once (auth=$auth, code=$code, crossOrigin=$crossOrigin)",
    async ({ auth, code, crossOrigin, retries }) => {
      const events: string[] = [];
      const resolveRequestHeaders = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => {
        events.push(forceRefresh ? "refresh" : "resolve");
        return { Authorization: forceRefresh ? "Bearer fixture-new" : "Bearer fixture-old" };
      });
      const fetchWithSsrFGuardImpl = vi.fn(
        async (params: Parameters<typeof fetchWithSsrFGuard>[0]) => {
          events.push(new Headers(params.init?.headers).get("Authorization") ?? "missing");
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
    },
  );

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
