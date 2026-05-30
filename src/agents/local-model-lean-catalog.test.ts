import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  filterLocalModelLeanPreCatalogTools,
  filterLocalModelLeanTools,
} from "./local-model-lean.js";

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

describe("local model lean catalog filtering", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        experimental: {
          localModelLean: true,
        },
      },
    },
  };

  it("preserves heavyweight tools before catalog compaction when compact controls are enabled", () => {
    expect(
      filterLocalModelLeanPreCatalogTools({
        tools: tools(["tool_search_code", "read", "browser", "cron", "message", "exec"]),
        controlsEnabled: true,
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["tool_search_code", "read", "browser", "cron", "message", "exec"]);
  });

  it("still trims heavyweight tools from the final visible surface", () => {
    expect(
      filterLocalModelLeanTools({
        tools: tools(["tool_search_code", "read", "browser", "cron", "message", "exec"]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["tool_search_code", "read", "exec"]);
  });

  it("filters before catalog compaction when compact controls are unavailable", () => {
    expect(
      filterLocalModelLeanPreCatalogTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        controlsEnabled: false,
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });
});
