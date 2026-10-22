import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "../web-search-provider.js";

installPinnedHostnameTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps grounded Gemini answers scoped to the request credential", async () => {
  const credentials: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const apiKey = new Headers(init?.headers).get("x-goog-api-key");
    credentials.push(apiKey ?? "");
    const account =
      apiKey === "gemini-account-a"
        ? "account-a"
        : apiKey === "gemini-account-b"
          ? "account-b"
          : undefined;
    if (!account) {
      throw new Error("Unexpected synthetic Gemini credential");
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: account }] } }] });
  });
  const provider = createGeminiWebSearchProvider();
  const tool = (apiKey: string) => {
    const created = provider.createTool({
      config: {
        plugins: { entries: { google: { config: { webSearch: { apiKey } } } } },
      },
    });
    if (!created) {
      throw new Error("Expected Gemini search tool");
    }
    return created;
  };
  const accountA = tool("gemini-account-a");
  const accountB = tool("gemini-account-b");
  const args = { query: "Gemini credential-scoped grounded answer" };
  const first = await accountA.execute(args);

  expect(first).toMatchObject({ content: expect.stringContaining("account-a") });
  expect(await accountB.execute(args)).toMatchObject({
    content: expect.stringContaining("account-b"),
  });
  expect(await accountA.execute(args)).toEqual({ ...first, cached: true });
  expect(credentials).toEqual(["gemini-account-a", "gemini-account-b"]);
});
