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

  it.each<[string, Params, "managed" | "disabled"]>([
    ["explicit managed provider", { config: config({ provider: "brave" }) }, "managed"],
    ["native search disabled", { config: config({ openaiCodex: { enabled: false } }) }, "managed"],
    ["native tools denied", { nativeToolSurfaceEnabled: false }, "managed"],
    ["unsupported provider", { nativeProviderWebSearchSupport: "unsupported" }, "managed"],
    [
      "domain restrictions fail closed",
      {
        config: config({ openaiCodex: { allowedDomains: ["example.com"] } }),
        nativeProviderWebSearchSupport: "unsupported",
      },
      "disabled",
    ],
    ["tool-disabled run", { disableTools: true }, "disabled"],
    ["effective policy denial", { webSearchAllowed: false }, "disabled"],
    ["OpenClaw search disabled", { config: config({ enabled: false }) }, "disabled"],
  ])("%s keeps the intended search ownership", (_name, params, kind) => {
    expect(resolveCodexWebSearchPlan(params)).toEqual({
      kind,
      suppressManagedWebSearch: kind === "disabled",
      threadConfig: threadConfig("disabled"),
    });
  });
});
