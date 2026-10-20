import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveCodexWebSearchPlan } from "./web-search.js";

type Params = Parameters<typeof resolveCodexWebSearchPlan>[0];
type SearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
const config = (search: SearchConfig) => ({ tools: { web: { search } } });
const threadConfig = (web_search: "cached" | "live" | "disabled") => ({
  "features.standalone_web_search": false,
  web_search,
});

describe("resolveCodexWebSearchPlan", () => {
  it("uses Codex hosted web search by default when no managed provider is selected", () => {
    expect(resolveCodexWebSearchPlan({})).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: threadConfig("cached"),
    });
  });

  it("projects Codex native web search tuning into thread config", () => {
    const plan = resolveCodexWebSearchPlan({
      config: config({
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
      }),
    });

    expect(plan).toEqual({
      kind: "native-hosted",
      suppressManagedWebSearch: true,
      threadConfig: {
        ...threadConfig("live"),
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

  it.each<[string, Params]>([
    ["an explicit managed provider is selected", { config: config({ provider: "brave" }) }],
    [
      "Codex native search is explicitly disabled",
      { config: config({ openaiCodex: { enabled: false } }) },
    ],
    ["runtime policy disables Codex native tools", { nativeToolSurfaceEnabled: false }],
    [
      "the active Codex provider lacks hosted search",
      { nativeProviderWebSearchSupport: "unsupported" },
    ],
  ])("keeps managed web_search when %s", (_name, params) => {
    expect(resolveCodexWebSearchPlan(params)).toEqual({
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: threadConfig("disabled"),
    });
  });

  it("fails closed instead of bypassing native domain restrictions through managed fallback", () => {
    expect(
      resolveCodexWebSearchPlan({
        config: config({ openaiCodex: { allowedDomains: ["example.com"] } }),
        nativeProviderWebSearchSupport: "unsupported",
      }),
    ).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: threadConfig("disabled"),
    });
  });

  it.each<[string, Params]>([
    ["tool-disabled runs", { disableTools: true }],
    ["effective tool policy denial", { webSearchAllowed: false }],
    ["disabled OpenClaw web search", { config: config({ enabled: false }) }],
  ])("disables native and managed search for %s", (_name, params) => {
    expect(resolveCodexWebSearchPlan(params)).toEqual({
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: threadConfig("disabled"),
    });
  });
});
