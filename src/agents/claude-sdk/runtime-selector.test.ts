import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { selectAgentRuntime } from "./runtime-selector.js";

function mkCfg(list: unknown[] | undefined): OpenClawConfig {
  return { agents: list === undefined ? undefined : { list } } as unknown as OpenClawConfig;
}

describe("selectAgentRuntime", () => {
  it("returns default when agentId is undefined", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, undefined)).toBe("default");
  });

  it("returns default when agents.list is missing", () => {
    expect(selectAgentRuntime(mkCfg(undefined), "a")).toBe("default");
  });

  it("returns default when the agent is not found", () => {
    const cfg = mkCfg([{ id: "other", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default when the agent has no runtime field", () => {
    const cfg = mkCfg([{ id: "a" }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default when the agent runtime type is not claude-sdk", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "embedded" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
    expect(selectAgentRuntime(mkCfg([{ id: "a", runtime: { type: "acp" } }]), "a")).toBe("default");
  });

  it("returns claude-sdk only on explicit opt-in", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("claude-sdk");
  });

  it("normalizes agent IDs on both sides so camelCase entries still match", () => {
    // Config uses a camelCase id; selector is invoked with the
    // lowercase normalized form (same shape agent routing uses
    // elsewhere). The selector must match despite the string diff.
    const cfg = mkCfg([{ id: "MyAgent", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "myagent")).toBe("claude-sdk");
  });

  it("normalizes agent IDs with inverse casing too", () => {
    const cfg = mkCfg([{ id: "myagent", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "MyAgent")).toBe("claude-sdk");
  });
});
