import { describe, expect, it } from "vitest";
import { MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE, withRemoteHttpResponse } from "./remote-http.js";

describe("package withRemoteHttpResponse", () => {
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
    expect(deps.calls[0]).toHaveProperty("mode", MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE);
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

  it("wraps transport failures with sanitized request context", async () => {
    const original = new TypeError(
      "fetch failed https://memory.example/v1/embeddings?api_key=secret Bearer sk-test",
    ) as TypeError & { cause?: unknown };
    original.cause = Object.assign(
      new Error("socket closed https://memory.example/v1/embeddings?token=secret"),
      {
        name: "SocketError",
        code: "UND_ERR_SOCKET",
      },
    );

    let caught: unknown;
    try {
      await withRemoteHttpResponse({
        url: "https://memory.example/v1/embeddings?api_key=secret",
        init: { headers: { Authorization: "Bearer sk-test" } },
        auditContext: "memory-remote",
        fetchWithSsrFGuardImpl: async () => {
          throw original;
        },
        shouldUseEnvHttpProxyForUrlImpl: () => false,
        onResponse: async () => undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { cause?: unknown };
    expect(err.cause).toBe(original);
    expect(err.message).toContain("memory-remote");
    expect(err.message).toContain("https://memory.example/v1/embeddings");
    expect(err.message).toContain("fetch failed");
    expect(err.message).toContain("SocketError");
    expect(err.message).toContain("UND_ERR_SOCKET");
    expect(err.message).not.toContain("api_key");
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("Authorization");
    expect(err.message).not.toContain("sk-test");
  });
});
