import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "../web-search-contract-api.js";
import { captureTavilyTools } from "./tavily-tools.test-support.js";

const { runTavilySearch, runTavilyExtract } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
  runTavilyExtract: vi.fn(async (params: Record<string, unknown>) => ({ ok: true, params })),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
  runTavilyExtract,
}));

function configWithWebSearch(webSearch: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { tavily: { config: { webSearch } } } } };
}

beforeEach(() => {
  runTavilySearch.mockReset().mockImplementation(async (params) => params);
  runTavilyExtract.mockReset().mockImplementation(async (params) => ({ ok: true, params }));
  vi.unstubAllEnvs();
});

function providerTool() {
  const tool = createTavilyWebSearchProvider().createTool({ config: {} });
  assert(tool, "Expected tool definition");
  return tool;
}

it.each(["web_search", "search", "extract"] as const)("forwards %s aborts", async (operation) => {
  const args = operation === "extract" ? { urls: ["https://example.com"] } : { query: "cancel" };
  const execute =
    operation === "web_search"
      ? (signal: AbortSignal) => providerTool().execute(args, { signal })
      : (signal: AbortSignal) =>
          captureTavilyTools()(`tavily_${operation}`).execute("cancel", args, signal);
  const networkOwner = operation === "extract" ? runTavilyExtract : runTavilySearch;
  const controller = new AbortController();
  await execute(controller.signal);
  expect(networkOwner).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  controller.abort(new Error("preflight aborted"));
  await expect(execute(controller.signal)).rejects.toBe(controller.signal.reason);
  expect(networkOwner).toHaveBeenCalledOnce();
});

it("normalizes generic Tavily search count before dispatch", async () => {
  const tool = providerTool();
  const result = await tool.execute({ query: "weather sf", count: "7" });
  expect(result).toEqual({ cfg: {}, query: "weather sf", maxResults: 7 });
  await expect(tool.execute({ query: "weather sf", count: "7.5" })).rejects.toThrow(
    "count must be an integer from 1 to 20",
  );
});

it("late-binds tools to the resolved runtime config snapshot", async () => {
  const rawConfig = configWithWebSearch({
    apiKey: { source: "exec", provider: "default", id: "printf resolved-key" },
  });
  const runtimeConfig = configWithWebSearch({ apiKey: "resolved-key" });
  const tools = captureTavilyTools(rawConfig);
  const searchTool = tools("tavily_search", { config: rawConfig, runtimeConfig });
  const extractTool = tools("tavily_extract", {
    config: rawConfig,
    getRuntimeConfig: () => runtimeConfig,
  });
  expect(searchTool.resultContentSource).toBe("network");
  expect(extractTool.resultContentSource).toBe("network");
  await searchTool.execute("search-call", { query: "openclaw" });
  await extractTool.execute("extract-call", { urls: ["https://example.com"] });
  expect(runTavilySearch.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
  expect(runTavilySearch.mock.calls[0]?.[0]?.query).toBe("openclaw");
  expect(runTavilyExtract.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
  expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com"]);
});

it("rejects chunks_per_source without query", async () => {
  const tool = captureTavilyTools()("tavily_extract");
  const result = tool.execute("id", { urls: ["https://example.com"], chunks_per_source: 2 });
  await expect(result).rejects.toThrow(
    "tavily_extract requires query when chunks_per_source is set.",
  );
  expect(runTavilyExtract).not.toHaveBeenCalled();
});

it("rejects blank extract URLs before Tavily calls and trims valid URLs", async () => {
  const tool = captureTavilyTools()("tavily_extract");
  await expect(tool.execute("extract", { urls: ["   "] })).rejects.toThrow(
    "tavily_extract requires at least one URL.",
  );
  expect(runTavilyExtract).not.toHaveBeenCalled();
  await tool.execute("extract", { urls: [" https://example.com/article "] });
  expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com/article"]);
});
