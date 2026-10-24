import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const fetchMock = vi.fn<typeof fetch>();
const grants = new Map<string, unknown>();
let now = 1_000_000;

async function discover(account: string, baseUrl?: string) {
  const result = await buildOpenAIProvider().catalog?.run({
    resolveProviderAuth: () => ({
      mode: "api_key",
      apiKey: "sk-fixture-" + account,
      profileId: "openai:" + account,
      source: "profile",
    }),
    resolveProviderApiKey: () => ({ apiKey: "sk-fixture-" + account }),
    config: baseUrl
      ? { models: { providers: { openai: { baseUrl, models: [] } } } }
      : { auth: { profiles: {} } },
    env: {},
    agentDir: "/fixture/agent",
    workspaceDir: "/fixture/workspace",
  });
  if (!result || "provider" in result) {
    throw new Error("expected account catalog");
  }
  return result;
}

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  grants.clear();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(init?.method ?? "GET").toBe("GET");
    const key = new Headers(init?.headers).get("Authorization")?.replace("Bearer sk-fixture-", "");
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/models") {
      // Identical base-model availability says nothing about these accounts' grants.
      return Response.json({ data: [{ id: "gpt-6.1-sol", object: "model" }] });
    }
    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toBeTruthy();
    const cyber = grants.get(key ?? "");
    if (cyber instanceof Error) {
      throw cyber;
    }
    if (cyber instanceof Response) {
      return cyber.clone();
    }
    return Response.json({
      models: [
        {
          slug: "gpt-6.1-sol",
          ...(cyber === undefined ? {} : { available_access_programs: { cyber } }),
        },
        { slug: "gpt-unlisted-fixture", available_access_programs: { cyber: ["daybreak_red"] } },
      ],
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
});
afterEach(() => vi.restoreAllMocks());

it("discovers explicit per-key programs independently of identical model availability", async () => {
  grants.set("none", []);
  grants.set("blue", ["standard", "daybreak_blue"]);
  grants.set("red", ["standard", "daybreak_red"]);
  const results = await Promise.all([discover("none"), discover("blue"), discover("red")]);
  for (const [index, cyber] of [
    [],
    ["standard", "daybreak_blue"],
    ["standard", "daybreak_red"],
  ].entries()) {
    expect(results[index]?.providers.openai?.models.map(({ id }) => id)).toEqual(["gpt-6.1-sol"]);
    expect(results[index]?.outcomes?.[0]?.modelAccessPrograms).toEqual([
      {
        modelId: "gpt-6.1-sol",
        runtimeId: "openclaw",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        cyber,
      },
    ]);
  }
  await discover("blue");
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it("replaces grants after expiry, preserves unknown, and never reuses a failed refresh", async () => {
  grants.set("selected", ["standard", "daybreak_blue"]);
  expect((await discover("selected")).outcomes?.[0]?.modelAccessPrograms?.[0]?.cyber).toEqual([
    "standard",
    "daybreak_blue",
  ]);
  for (const cyber of [
    [],
    ["standard", "daybreak_blue", "daybreak_red"],
    undefined,
    [12],
    Response.json({ error: { code: "access_denied" } }, { status: 403 }),
    new Error("offline"),
    ["standard", "daybreak_blue"],
  ]) {
    now += 60_001;
    grants.set("selected", cyber);
    const result = await discover("selected");
    expect(result.outcomes?.[0]?.status).toBe("ready");
    expect(result.outcomes?.[0]?.modelAccessPrograms?.[0]?.cyber).toEqual(
      Array.isArray(cyber) && cyber.every((value) => typeof value === "string") ? cyber : undefined,
    );
    expect(result.providers.openai?.models.map(({ id }) => id)).toEqual(["gpt-6.1-sol"]);
  }
});

it("does not send custom-provider credentials to the official discovery endpoint", async () => {
  await discover("custom", "https://custom.example/v1");
  expect(fetchMock).not.toHaveBeenCalled();
});
