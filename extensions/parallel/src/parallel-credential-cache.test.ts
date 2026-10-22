import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, expect, it, vi } from "vitest";
import { createParallelWebSearchProvider } from "../web-search-contract-api.js";

installPinnedHostnameTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps paid Parallel search results scoped to the request credential", async () => {
  const credentials: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const apiKey = new Headers(init?.headers).get("x-api-key");
    credentials.push(apiKey ?? "");
    const account =
      apiKey === "parallel-account-a"
        ? "account-a"
        : apiKey === "parallel-account-b"
          ? "account-b"
          : undefined;
    if (!account) {
      throw new Error("Unexpected synthetic Parallel credential");
    }
    return new Response(
      JSON.stringify({
        search_id: account,
        results: [{ url: `https://example.com/${account}`, title: account }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const provider = createParallelWebSearchProvider();
  const tool = (apiKey: string) => {
    const created = provider.createTool({ searchConfig: { parallel: { apiKey } } });
    if (!created) {
      throw new Error("Expected paid Parallel search tool");
    }
    return created;
  };
  const accountA = tool("parallel-account-a");
  const accountB = tool("parallel-account-b");
  const args = { search_queries: ["parallel credential-scoped result reuse"] };

  expect(await accountA.execute(args)).toMatchObject({
    searchId: "account-a",
    results: [{ url: "https://example.com/account-a" }],
  });
  expect(await accountB.execute(args)).toMatchObject({
    searchId: "account-b",
    results: [{ url: "https://example.com/account-b" }],
  });
  expect(await accountA.execute(args)).toMatchObject({
    searchId: "account-a",
    results: [{ url: "https://example.com/account-a" }],
    cached: true,
  });
  expect(credentials).toEqual(["parallel-account-a", "parallel-account-b"]);
});
