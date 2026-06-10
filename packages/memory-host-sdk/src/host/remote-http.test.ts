// Memory Host SDK tests cover remote http behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRemoteHttpResponse } from "./remote-http.js";

describe("package withRemoteHttpResponse", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeFetchDeps() {
    const calls: unknown[] = [];
    return {
      calls,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response("ok", { status: 200 });
      },
    };
  }

  it("uses ordinary fetch and releases the response after the callback", async () => {
    const deps = makeFetchDeps();
    let body = "";

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async (response) => {
        body = await response.text();
      },
      ...deps,
    });

    expect(body).toBe("ok");
    expect(deps.calls[0]).toMatchObject({
      input: "https://memory.example/v1/embeddings",
    });
  });

  it("passes abort signals to fetch", async () => {
    const deps = makeFetchDeps();
    const controller = new AbortController();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      signal: controller.signal,
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toMatchObject({
      init: expect.objectContaining({ signal: controller.signal }),
    });
  });

  it("passes request init to fetch", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      init: { method: "POST" },
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).toMatchObject({
      init: expect.objectContaining({ method: "POST" }),
    });
  });

  it("routes remote memory requests through env proxy dispatchers", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "");
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    const call = deps.calls[0] as { init?: { dispatcher?: unknown } } | undefined;
    expect(call?.init?.dispatcher).toBeDefined();
  });

  it("closes env proxy dispatchers when fetch setup fails", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "");
    const close = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const dispatcher = (init as { dispatcher?: { close?: () => Promise<void> } } | undefined)
        ?.dispatcher;
      if (!dispatcher) {
        throw new Error("expected dispatcher");
      }
      dispatcher.close = close;
      throw new Error("proxy setup failed");
    });

    await expect(
      withRemoteHttpResponse({
        url: "https://memory.example/v1/embeddings",
        fetchImpl,
        onResponse: async () => undefined,
      }),
    ).rejects.toThrow("proxy setup failed");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects outside the initial configured remote host", async () => {
    const calls: unknown[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example/v1/embeddings" },
      });
    };

    await expect(
      withRemoteHttpResponse({
        url: "https://memory.example/v1/embeddings",
        fetchImpl,
        onResponse: async () => undefined,
      }),
    ).rejects.toThrow("Blocked hostname (not configured remote host)");

    expect(calls).toHaveLength(1);
  });
});
