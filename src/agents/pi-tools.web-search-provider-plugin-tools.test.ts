import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

function createBrightDataConfig(profile: "coding" | "minimal"): OpenClawConfig {
  return {
    tools: {
      profile,
      web: {
        search: {
          enabled: true,
          provider: "brightdata",
        },
      },
    },
    plugins: {
      entries: {
        brightdata: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: "brd-test-key", // pragma: allowlist secret
            },
          },
        },
      },
    },
  };
}

describe("createOpenClawCodingTools web-search provider plugin tools", () => {
  it("keeps active Bright Data plugin tools under the coding profile", () => {
    const tools = createOpenClawCodingTools({
      config: createBrightDataConfig("coding"),
      senderIsOwner: true,
    });
    const toolNames = new Set(tools.map((tool) => tool.name));

    expect(toolNames.has("web_search")).toBe(true);
    expect(toolNames.has("brightdata_search")).toBe(true);
    expect(toolNames.has("brightdata_browser_navigate")).toBe(true);
  });

  it("does not auto-allow Bright Data plugin tools outside the coding profile", () => {
    const tools = createOpenClawCodingTools({
      config: createBrightDataConfig("minimal"),
      senderIsOwner: true,
    });
    const toolNames = new Set(tools.map((tool) => tool.name));

    expect(toolNames.has("brightdata_search")).toBe(false);
    expect(toolNames.has("brightdata_browser_navigate")).toBe(false);
  });
});
