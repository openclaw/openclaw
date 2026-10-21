import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requireApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import { jsonResponse, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createXaiWebSearchProvider } from "./web-search.js";

const { resolveAuth } = vi.hoisted(() => ({ resolveAuth: vi.fn() }));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveAuth,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  listUsableProviderAuthProfileIdsAsync: async () => ({ agentDir: "", profileIds: [] }),
}));

function search(query: string, apiKey?: string, signal?: AbortSignal) {
  const tool = createXaiWebSearchProvider().createTool({
    config: {
      plugins: { entries: { xai: { enabled: true, config: { webSearch: { apiKey } } } } },
    },
  });
  if (!tool) {
    throw new Error("Expected xAI web search tool");
  }
  return tool.execute({ query }, { signal });
}

const mockFetch = vi.fn<(_input?: unknown, _init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  resolveAuth.mockReset().mockResolvedValue({ source: "test", mode: "api-key" });
  mockFetch
    .mockReset()
    .mockImplementation(async () => jsonResponse({ output_text: "Grounded Grok answer" }));
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["initial lookup", "refresh after 401"])(
  "preserves failures during %s without a fallback",
  async (phase) => {
    const authError = new Error("OAuth token refresh failed for xai: refresh did not settle");
    if (phase === "refresh after 401") {
      resolveAuth.mockResolvedValueOnce({
        apiKey: "expired",
        mode: "oauth",
        profileId: "xai:default",
      });
    }
    resolveAuth.mockRejectedValueOnce(authError);
    mockFetch.mockImplementation(async () => new Response("expired", { status: 401 }));
    await expect(search(`search auth failure: ${phase}`)).rejects.toBe(authError);
    expect(mockFetch).toHaveBeenCalledTimes(phase === "initial lookup" ? 0 : 1);
  },
);

it("keeps configured API-key fallback when OAuth credential resolution fails", async () => {
  resolveAuth.mockRejectedValueOnce(new Error("OAuth token refresh failed for xai"));
  const result = await search("configured fallback", "fallback-key");
  expect(result.content).toContain("Grounded Grok answer");
  expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
    "Bearer fallback-key",
  );
});

it("reports genuinely absent credentials as a missing API key", async () => {
  resolveAuth.mockImplementationOnce(() =>
    requireApiKey({ source: "test", mode: "api-key" }, "xai"),
  );
  const result = await search("search without credentials");
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
    const lookup = createDeferred<never>();
    const aborted = vi.fn(lookup.reject);
    resolveAuth.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", () => aborted(signal.reason), { once: true });
      started.resolve();
      return lookup.promise;
    });
    const searching = search(`${cancellation} cancellation`, undefined, controller.signal);
    const rejected =
      cancellation === "caller"
        ? expect(searching).rejects.toBe(reason)
        : expect(searching).rejects.toMatchObject({
            name: "TimeoutError",
            code: "ETIMEDOUT",
            timeoutMs: 60_000,
          });
    try {
      await started.promise;
      if (cancellation === "caller") {
        controller.abort(reason);
      } else {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await rejected;
      expect(aborted).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(reason);
      await searching.catch(() => {});
    }
  },
);
