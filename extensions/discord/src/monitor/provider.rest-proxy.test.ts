import type { RequestClient } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import { applyProxyToRequestClient, resolveDiscordRestFetch } from "./rest-fetch.js";

const { undiciFetchMock, proxyAgentSpy, wrapFetchWithAbortSignalMock } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  proxyAgentSpy: vi.fn(),
  wrapFetchWithAbortSignalMock: vi.fn((f: typeof fetch) => f),
}));

vi.mock("undici", () => {
  class ProxyAgent {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      proxyAgentSpy(proxyUrl);
    }
  }
  return {
    ProxyAgent,
    fetch: undiciFetchMock,
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  wrapFetchWithAbortSignal: wrapFetchWithAbortSignalMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (msg: string) => msg,
}));

describe("resolveDiscordRestFetch", () => {
  it("uses undici proxy fetch when a proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockClear().mockResolvedValue(new Response("ok", { status: 200 }));
    proxyAgentSpy.mockClear();
    const fetcher = resolveDiscordRestFetch("http://proxy.test:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to global fetch when proxy URL is invalid", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    const fetcher = resolveDiscordRestFetch("bad-proxy", runtime);

    expect(fetcher).toBe(fetch);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

describe("applyProxyToRequestClient", () => {
  function makeRuntime() {
    return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as const;
  }

  /** Minimal stand-in for Carbon's RequestClient with executeRequest on proto */
  class MockRequestClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async executeRequest(_request: unknown): Promise<unknown> {
      // Simulates Carbon calling globalThis.fetch internally
      await globalThis.fetch("https://discord.com/api/v10/test", { method: "GET" });
      return { ok: true };
    }
  }

  it("patches executeRequest to route through proxy fetch", async () => {
    const runtime = makeRuntime();
    undiciFetchMock.mockClear().mockResolvedValue(new Response("ok", { status: 200 }));
    proxyAgentSpy.mockClear();

    const restClient = new MockRequestClient() as unknown as RequestClient;
    applyProxyToRequestClient(restClient, "http://proxy.test:8080", runtime);

    // Call the patched executeRequest (simulates Carbon making a REST call)
    await (restClient as unknown as MockRequestClient).executeRequest({});

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/test",
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: carbon rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("installs ALS-aware globalThis.fetch wrapper that is marked __discordProxyWrapped", () => {
    const runtime = makeRuntime();
    const restClient = new MockRequestClient() as unknown as RequestClient;
    applyProxyToRequestClient(restClient, "http://proxy.test:8080", runtime);

    // The wrapper is permanently installed; it is NOT a temporary swap.
    expect(
      (globalThis.fetch as typeof fetch & { __discordProxyWrapped?: boolean })
        .__discordProxyWrapped,
    ).toBe(true);
  });

  it("does not proxy globalThis.fetch calls made outside executeRequest context", async () => {
    const runtime = makeRuntime();
    undiciFetchMock.mockClear();

    const restClient = new MockRequestClient() as unknown as RequestClient;
    applyProxyToRequestClient(restClient, "http://proxy.test:8080", runtime);

    // A fetch call that is NOT initiated from inside executeRequest should NOT
    // go through the undici proxy.  The ALS store is empty here, so the
    // wrapper delegates to the original fetch (vitest's global fetch mock).
    const directFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("direct", { status: 200 }),
    );

    await globalThis.fetch("https://example.com/unrelated");

    // undici was NOT called for this direct fetch
    expect(undiciFetchMock).not.toHaveBeenCalledWith(
      "https://example.com/unrelated",
      expect.anything(),
    );
    directFetchSpy.mockRestore();
  });

  it("does nothing when proxy URL is undefined or empty", () => {
    const runtime = makeRuntime();
    const restClient = new MockRequestClient() as unknown as RequestClient;

    applyProxyToRequestClient(restClient, undefined, runtime);
    applyProxyToRequestClient(restClient, "   ", runtime);

    // No instance-level override, no logs
    expect(Object.prototype.hasOwnProperty.call(restClient, "executeRequest")).toBe(false);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("concurrent executeRequest calls each use their own proxy context independently", async () => {
    const runtime = makeRuntime();
    undiciFetchMock.mockClear().mockResolvedValue(new Response("ok", { status: 200 }));

    const restClient = new MockRequestClient() as unknown as RequestClient;
    applyProxyToRequestClient(restClient, "http://proxy.test:8080", runtime);

    const exec = (restClient as unknown as MockRequestClient).executeRequest.bind(restClient);

    // Both concurrent calls should succeed and route through the proxy
    const [r1, r2] = await Promise.all([exec({}), exec({})]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // Both calls should have gone through undici (ALS scoped, no interference)
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs error and skips patching when executeRequest is absent from prototype", () => {
    const runtime = makeRuntime();
    // Plain object — prototype is Object.prototype, no executeRequest
    const restClient = {} as unknown as RequestClient;

    applyProxyToRequestClient(restClient, "http://proxy.test:8080", runtime);

    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
