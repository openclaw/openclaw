// Memory Host SDK tests cover remote http behavior.
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
      expect(events).toEqual(
        !auth
          ? ["Bearer fixture-static", "release"]
          : retries
            ? [
                "resolve",
                "Bearer fixture-old",
                "release",
                "refresh",
                "Bearer fixture-new",
                "release",
              ]
            : ["resolve", "Bearer fixture-old", "release"],
      );
      if (retries) {
        await expect(result).rejects.not.toThrow("fixture-new");
      }
    },
  );

  function makeFetchDeps({ useEnvProxy = false }: { useEnvProxy?: boolean } = {}) {
    const calls: unknown[] = [];
    return {
      calls,
      fetchWithSsrFGuardImpl: async (params: unknown) => {
        calls.push(params);
        return {
          response: new Response("ok", { status: 200 }),
          finalUrl: "https://memory.example/v1",
          release: async () => {},
        };
      },
      shouldUseEnvHttpProxyForUrlImpl: () => useEnvProxy,
    };
  }

  it("uses trusted env proxy mode when the target will use EnvHttpProxyAgent", async () => {
    const deps = makeFetchDeps({ useEnvProxy: true });

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("url", "https://memory.example/v1/embeddings");
    expect(deps.calls[0]).toHaveProperty("mode", "trusted_env_proxy");
  });

  it("keeps strict guarded fetch mode when proxy env would not proxy the target", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://internal.corp.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).not.toHaveProperty("mode");
  });

  it("passes abort signals to the guarded fetch", async () => {
    const deps = makeFetchDeps();
    const controller = new AbortController();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      signal: controller.signal,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toHaveProperty("signal", controller.signal);
  });
});
