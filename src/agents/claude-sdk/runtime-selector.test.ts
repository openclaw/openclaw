import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { selectAgentRuntime } from "./runtime-selector.js";

function mkCfg(list: unknown[] | undefined): OpenClawConfig {
  return { agents: list === undefined ? undefined : { list } } as unknown as OpenClawConfig;
}

describe("selectAgentRuntime", () => {
  // This PR keeps the legacy pi-embedded path as the default. Claude
  // Agent SDK is an explicit per-agent opt-in via
  // `agents.list[<id>].runtime.type: "claude-sdk"`. Phase 4 may flip
  // the default once the SDK path has soaked; until then, anything
  // that isn't an explicit claude-sdk opt-in routes to the legacy
  // runtime.

  it("returns default (legacy) when agentId is undefined", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, undefined)).toBe("default");
  });

  it("returns default when agents.list is missing", () => {
    expect(selectAgentRuntime(mkCfg(undefined), "a")).toBe("default");
  });

  it("returns default when the agent is not found in the list", () => {
    const cfg = mkCfg([{ id: "other", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default when the agent has no runtime field", () => {
    const cfg = mkCfg([{ id: "a" }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default when the agent explicitly opts into embedded", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "embedded" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default when the agent explicitly opts into acp", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "acp" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns claude-sdk only on explicit opt-in", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("claude-sdk");
  });

  it("normalizes agent IDs on both sides so camelCase entries still match", () => {
    // Config uses a camelCase id; selector is invoked with the lowercase
    // normalized form. The selector must match despite the string diff
    // so the claude-sdk opt-in wins over the default.
    const cfg = mkCfg([{ id: "MyAgent", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "myagent")).toBe("claude-sdk");
  });

  it("normalizes agent IDs with inverse casing too", () => {
    const cfg = mkCfg([{ id: "myagent", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "MyAgent")).toBe("claude-sdk");
  });
});
