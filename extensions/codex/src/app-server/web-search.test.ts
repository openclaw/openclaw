import { describe, expect, it } from "vitest";
import { resolveCodexWebSearchPlan } from "./web-search.js";

describe("resolveCodexWebSearchPlan", () => {
  it("uses Codex hosted web search by default when no managed provider is selected", () => {
    expect(resolveCodexWebSearchPlan({})).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "cached",
      },
    });
  });

  it("projects Codex native web search tuning into thread config", () => {
    const plan = resolveCodexWebSearchPlan({
      config: {
        tools: {
          web: {
            search: {
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: [" example.com ", "example.com", ""],
                contextSize: "high",
                userLocation: {
                  country: " CA ",
                  region: " Alberta ",
                  city: " Edmonton ",
                  timezone: "America/Edmonton",
                },
              },
            },
          },
        },
      },
    });

    expect(plan).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "live",
        "tools.web_search.allowed_domains": ["example.com"],
        "tools.web_search.context_size": "high",
        "tools.web_search.location.country": "CA",
        "tools.web_search.location.region": "Alberta",
        "tools.web_search.location.city": "Edmonton",
        "tools.web_search.location.timezone": "America/Edmonton",
      },
      webFetchHostnameAllowlist: ["example.com", "*.example.com"],
    });
  });

  it.each<{ name: string; params: Parameters<typeof resolveCodexWebSearchPlan>[0] }>([
    {
      name: "an explicit managed provider is selected",
      params: { config: { tools: { web: { search: { provider: "brave" } } } } },
    },
    {
      name: "Codex native search is explicitly disabled",
      params: { config: { tools: { web: { search: { openaiCodex: { enabled: false } } } } } },
    },
    {
      name: "runtime policy disables Codex native tools",
      params: { nativeToolSurfaceEnabled: false },
    },
    {
      name: "the active Codex provider lacks hosted search",
      params: { nativeProviderWebSearchSupport: "unsupported" },
    },
  ])("keeps managed web_search when $name", ({ params }) => {
    expect(resolveCodexWebSearchPlan(params)).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it("fails closed instead of bypassing native domain restrictions through managed fallback", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: {
          tools: {
            web: {
              search: { openaiCodex: { allowedDomains: ["example.com"] } },
            },
          },
        },
        nativeProviderWebSearchSupport: "unsupported",
      }),
    ).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });

  it.each<{ name: string; params: Parameters<typeof resolveCodexWebSearchPlan>[0] }>([
    { name: "tool-disabled runs", params: { disableTools: true } },
    { name: "effective tool policy denial", params: { webSearchAllowed: false } },
    {
      name: "disabled OpenClaw web search",
      params: { config: { tools: { web: { search: { enabled: false } } } } },
    },
  ])("disables native and managed search for $name", ({ params }) => {
    expect(resolveCodexWebSearchPlan(params)).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: {
        "features.standalone_web_search": false,
        web_search: "disabled",
      },
    });
  });
});
