import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadWebFetchToolFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describeWebFetchProviderContracts } from "openclaw/plugin-sdk/provider-test-contracts";
import {
  createTempHomeEnv,
  jsonResponse,
  mockPinnedHostnameResolution,
  withFetchPreconnect,
} from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekWebFetchProvider } from "./web-fetch-provider.js";

const KEY = "synthetic-deepseek-fetch-key";
const TARGET = "https://example.com/article";
const API = "https://api.deepseek.com/v1/tools/fetch";
const fetchMock = vi.fn<typeof fetch>();
function config(apiKey: unknown = KEY): OpenClawConfig {
  return {
    tools: { web: { fetch: { provider: "deepseek", cacheTtlMinutes: 0 } } },
    plugins: {
      allow: ["deepseek"],
      entries: { deepseek: { enabled: true, config: { webSearch: { apiKey } } } },
    },
  };
}
function fetchTool(cfg = config()) {
  const tool = createDeepSeekWebFetchProvider().createTool({
    config: cfg,
    fetchConfig: cfg.tools?.web?.fetch,
  });
  if (!tool) {
    throw new Error("expected explicitly selected fetch provider");
  }
  return tool;
}
function page() {
  return jsonResponse({ title: "Page title", content: "# Page\n\nUseful **content**." });
}

let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
beforeAll(async () => {
  home = await createTempHomeEnv("deepseek-fetch-test-");
});
afterAll(async () => {
  await home.restore();
});
beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fileURLToPath(new URL("../", import.meta.url)));
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(name, undefined);
  }
  mockPinnedHostnameResolution();
  fetchMock.mockReset().mockImplementation(async () => page());
  vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describeWebFetchProviderContracts("deepseek");
describe("DeepSeek Fetch", () => {
  it("does not opt inference/search users into paid URL delegation", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", KEY);
    const cfg = config();
    delete cfg.tools!.web!.fetch!.provider;
    expect(createDeepSeekWebFetchProvider().createTool({ config: cfg })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts only the URL to the official endpoint and returns provider Markdown", async () => {
    const result = await fetchTool().execute({ url: TARGET });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(API);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    if (typeof init?.body !== "string") {
      throw new Error("expected serialized Fetch request");
    }
    expect(JSON.parse(init.body)).toEqual({ url: TARGET });
    expect(result).toMatchObject({
      title: "Page title",
      text: "# Page\n\nUseful **content**.",
      extractor: "deepseek",
      contentType: "text/markdown",
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("uses the standard text renderer for headings and links", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: "# Page\n\nUseful [content](https://example.com/source)." }),
    );
    const result = await fetchTool().execute({ url: TARGET, extractMode: "text" });
    expect(result.text).toBe("Page\n\nUseful content.");
    expect(result.contentType).toBe("text/plain");
  });

  it.each(["plugin", "env", "model"])(
    "resolves the %s credential without inheriting a chat URL",
    async (source) => {
      const cfg = config(source === "plugin" ? KEY : "");
      cfg.models = {
        providers: {
          deepseek: { baseUrl: "https://chat-proxy.example/v1", models: [], apiKey: "model-key" },
        },
      };
      if (source === "env") {
        vi.stubEnv("DEEPSEEK_API_KEY", "env-key");
      }
      await fetchTool(cfg).execute({ url: TARGET });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(API);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${source === "plugin" ? KEY : source === "env" ? "env-key" : "model-key"}`,
      );
    },
  );

  it("rejects missing or unresolved credentials before buying a fetch", async () => {
    await expect(fetchTool(config("")).execute({ url: TARGET })).rejects.toThrow(
      "DeepSeek API key",
    );
    await expect(
      fetchTool(config({ source: "file", provider: "default", id: "/key" })).execute({
        url: TARGET,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "non-HTTP protocol", url: "ftp://example.com" },
    { name: "internal hostname", url: "http://localhost/" },
    { name: "loopback address", url: "http://127.0.0.1/" },
    { name: "metadata address", url: "http://169.254.169.254/latest/meta-data" },
    { name: "embedded credentials", url: "https://user:password@example.com" },
    { name: "oversized URL", url: "https://example.com/" + "x".repeat(8192) },
  ])("does not delegate $name", async ({ url }) => {
    await expect(fetchTool().execute({ url })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["[]", "{}", '{"content":123}', '{"content":"  "}'])(
    "rejects malformed or unusable response %s",
    async (body) => {
      fetchMock.mockResolvedValueOnce(new Response(body));
      await expect(fetchTool().execute({ url: TARGET })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 402, 429, 504])(
    "preserves HTTP %s without retrying or exposing the key",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(`reflected Bearer ${KEY}`, { status }));
      const error = await fetchTool()
        .execute({ url: TARGET })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ status });
      expect(String(error)).not.toContain(KEY);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects already-cancelled and late-cancelled fetches", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled fetch");
    let finish!: (response: Response) => void;
    const started = Promise.withResolvers<void>();
    fetchMock.mockImplementationOnce(async () => {
      started.resolve();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const pending = fetchTool().execute({ url: TARGET }, { signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    finish(page());
    await expect(pending).rejects.toBe(reason);
    await expect(fetchTool().execute({ url: TARGET }, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("integrates with canonical web_fetch while leaving successful local fetches first", async () => {
    const createWebFetchTool = await loadWebFetchToolFactoryForTest();
    const tool = createWebFetchTool({ config: config(), sandboxed: false });
    if (!tool) {
      throw new Error("expected canonical web_fetch");
    }
    fetchMock.mockResolvedValueOnce(
      new Response("# Local document", { headers: { "content-type": "text/markdown" } }),
    );
    const local = await tool.execute("local", { url: "https://example.com/local" });
    expect(local.details).toMatchObject({ text: expect.stringContaining("Local document") });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/local");

    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(page());
    const fallback = await tool.execute("fallback", { url: TARGET, maxChars: 2000 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([TARGET, API]);
    expect(fallback.details).toMatchObject({
      extractor: "deepseek",
      text: expect.stringContaining("Useful **content**"),
      externalContent: { untrusted: true, wrapped: true },
    });
    expect(JSON.stringify(fallback)).not.toContain(KEY);
  });
});
