import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requireApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXaiWebSearchProvider } from "./web-search.js";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn().mockResolvedValue({ source: "test", mode: "api-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: providerAuthRuntimeMocks.resolveApiKeyForProvider,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  listUsableProviderAuthProfileIds: () => ({ agentDir: "", profileIds: [] }),
}));

function createAuthSearchTool(webSearch?: { apiKey: string }) {
  const tool = createXaiWebSearchProvider().createTool({
    config: {
      tools: { web: { search: { provider: "grok" } } },
      plugins: { entries: { xai: { enabled: true, config: { webSearch } } } },
    },
  });
  if (!tool) {
    throw new Error("Expected xAI web search tool");
  }
  return tool;
}

function installXaiWebSearchFetch() {
  const mockFetch = vi.fn(
    async (_input?: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ output_text: "Grounded Grok answer" }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  providerAuthRuntimeMocks.resolveApiKeyForProvider
    .mockReset()
    .mockResolvedValue({ source: "test", mode: "api-key" });
});

describe("xAI web search auth lifecycle", () => {
  it("preserves credential settlement failures instead of reporting a missing API key", async () => {
    const authError = new Error("OAuth token refresh failed for xai: refresh did not settle");
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockRejectedValueOnce(authError);
    const mockFetch = installXaiWebSearchFetch();
    const tool = createAuthSearchTool();

    await expect(tool.execute({ query: "search waiting for credentials" })).rejects.toBe(authError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps configured API-key fallback when OAuth credential resolution fails", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockRejectedValueOnce(
      new Error("OAuth token refresh failed for xai"),
    );
    const mockFetch = installXaiWebSearchFetch();
    const tool = createAuthSearchTool({ apiKey: "configured-fallback-key" });

    const result = await tool.execute({ query: "configured search fallback after auth failure" });

    expect(result.content).toContain("Grounded Grok answer");
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer configured-fallback-key",
    );
  });

  it("reports genuinely absent credentials as a missing API key", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockImplementationOnce(() =>
      requireApiKey({ source: "test", mode: "api-key" }, "xai"),
    );
    const mockFetch = installXaiWebSearchFetch();

    const result = await createAuthSearchTool().execute({ query: "search without credentials" });

    expect(result.error).toBe("missing_xai_api_key");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["deadline", "caller"] as const)(
    "ends credential preparation on %s cancellation without starting a search",
    async (cancellation) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new DOMException("search cancelled by caller", "AbortError");
      const started = createDeferred<void>();
      let activeLookups = 0;
      providerAuthRuntimeMocks.resolveApiKeyForProvider.mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) => {
          const { promise, reject } = createDeferred<never>();
          activeLookups += 1;
          signal.addEventListener(
            "abort",
            () => {
              activeLookups -= 1;
              reject(signal.reason);
            },
            { once: true },
          );
          started.resolve();
          return promise;
        },
      );
      const mockFetch = installXaiWebSearchFetch();
      const searching = createAuthSearchTool().execute(
        { query: `search credential ${cancellation} cancellation` },
        { signal: controller.signal },
      );
      const rejected =
        cancellation === "caller"
          ? expect(searching).rejects.toBe(reason)
          : expect(searching).rejects.toMatchObject({ code: "ETIMEDOUT" });
      try {
        await started.promise;
        if (cancellation === "caller") {
          controller.abort(reason);
        } else {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await rejected;
        expect(activeLookups).toBe(0);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort(reason);
        await searching.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it("preserves a failed OAuth refresh when no API-key fallback can recover", async () => {
    const authError = new Error("OAuth token refresh failed for xai: re-authenticate");
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockRejectedValueOnce(authError);
    const mockFetch = vi.fn(
      async () => new Response("expired", { status: 401, statusText: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));

    await expect(
      createAuthSearchTool().execute({ query: "unrecoverable search OAuth refresh" }),
    ).rejects.toBe(authError);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
