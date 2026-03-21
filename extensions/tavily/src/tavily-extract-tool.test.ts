import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tavily-client.js", () => ({
  runTavilyExtract: vi.fn(async (params: unknown) => ({ ok: true, params })),
}));

import { runTavilyExtract } from "./tavily-client.js";
import { createTavilyExtractTool } from "./tavily-extract-tool.js";

function fakeApi(): OpenClawPluginApi {
  return {
    config: {},
  } as OpenClawPluginApi;
}

describe("tavily_extract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects chunks_per_source without query", async () => {
    const tool = createTavilyExtractTool(fakeApi());

    await expect(
      tool.execute("id", {
        urls: ["https://example.com"],
        chunks_per_source: 2,
      }),
    ).rejects.toThrow("tavily_extract requires query when chunks_per_source is set.");

    expect(runTavilyExtract).not.toHaveBeenCalled();
  });

  it("forwards query-scoped chunking when query is provided", async () => {
    const tool = createTavilyExtractTool(fakeApi());

    await tool.execute("id", {
      urls: ["https://example.com"],
      query: "pricing",
      chunks_per_source: 2,
    });

    expect(runTavilyExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        urls: ["https://example.com"],
        query: "pricing",
        chunksPerSource: 2,
      }),
    );
  });
});
