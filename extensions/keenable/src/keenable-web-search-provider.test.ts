import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createKeenableWebSearchProvider } from "../web-search-contract-api.js";

type JsonRecord = Record<string, unknown>;
let fetchMock: MockInstance<typeof fetch>;

function requireKeenableTool(webSearch: JsonRecord = {}, searchConfig: JsonRecord = {}) {
  const keenable = { config: { webSearch: { apiKey: "keen_test_key", ...webSearch } } };
  const tool = createKeenableWebSearchProvider().createTool({
    config: { plugins: { entries: { keenable } } },
    searchConfig,
  });
  if (!tool) {
    throw new Error("Expected Keenable tool definition");
  }
  return tool;
}

function respondWith(results: JsonRecord[]) {
  fetchMock.mockImplementation(async () => Response.json({ query: "fixture", mode: "pro", results }));
}

function requestBody(index = fetchMock.mock.calls.length - 1) {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Keenable JSON request body");
  }
  return JSON.parse(body);
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("returns a missing-key payload when no credential is configured", async () => {
  const tool = createKeenableWebSearchProvider().createTool({ config: {} });
  expect(tool).toBeTruthy();
  await expect(tool!.execute({ query: "missing key" })).resolves.toMatchObject({
    error: "missing_keenable_api_key",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("maps count to max_results and sends required Keenable headers", async () => {
  respondWith([{ url: "https://example.com/a", title: "A", snippet: "Snippet A" }]);
  const tool = requireKeenableTool();
  const result = await tool.execute({ query: "Keenable header contract", count: 2, mode: "realtime" });

  expect(result).toMatchObject({
    provider: "keenable",
    mode: "realtime",
    count: 1,
    results: [{ url: "https://example.com/a" }],
  });
  expect(requestBody()).toMatchObject({
    query: "Keenable header contract",
    mode: "realtime",
    max_results: 2,
  });
  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(headers.get("X-API-Key")).toBe("keen_test_key");
  expect(headers.get("X-Keenable-Title")).toBe("OpenClaw");
});

it("uses a configured app title for X-Keenable-Title", async () => {
  respondWith([{ url: "https://example.com/title", title: "Title", snippet: "Body" }]);
  await requireKeenableTool({ appTitle: "Fixture Gateway" }).execute({ query: "custom title" });
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Keenable-Title")).toBe(
    "Fixture Gateway",
  );
});

it("shares cached answers only with the same resolved credential", async () => {
  fetchMock.mockImplementation(async (_url, init) => {
    const account =
      new Headers(init?.headers).get("X-API-Key") === "keen_fixture_a" ? "a" : "b";
    return Response.json({
      results: [{ url: `https://example.com/account-${account}`, title: account, snippet: account }],
    });
  });
  const args = { query: "Keenable credential cache isolation" };
  const first = await requireKeenableTool({ apiKey: "keen_fixture_a" }, { cacheTtlMinutes: 5 }).execute(
    args,
  );
  const other = await requireKeenableTool({ apiKey: "keen_fixture_b" }, { cacheTtlMinutes: 5 }).execute(
    args,
  );
  const repeated = await requireKeenableTool({ apiKey: "keen_fixture_a" }, { cacheTtlMinutes: 5 }).execute(
    args,
  );

  expect(first.results).toMatchObject([{ url: "https://example.com/account-a" }]);
  expect(other.results).toMatchObject([{ url: "https://example.com/account-b" }]);
  expect(repeated).toEqual({ ...first, cached: true });
  expect(
    fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-API-Key")),
  ).toEqual(["keen_fixture_a", "keen_fixture_b"]);
});

it("rejects invalid search modes before calling the API", async () => {
  const tool = requireKeenableTool();
  await expect(tool.execute({ query: "bad mode", mode: "turbo" })).resolves.toMatchObject({
    error: "invalid_mode",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
