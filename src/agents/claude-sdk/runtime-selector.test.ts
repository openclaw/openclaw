import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { selectAgentRuntime } from "./runtime-selector.js";

function mkCfg(list: unknown[] | undefined): OpenClawConfig {
  return { agents: list === undefined ? undefined : { list } } as unknown as OpenClawConfig;
}

describe("selectAgentRuntime", () => {
  // Post-Phase-3: the default runtime is claude-sdk. Agents that want
  // the legacy pi-embedded / acp path opt in explicitly via
  // `agents.list[<id>].runtime.type`.

  it("returns claude-sdk when agentId is undefined (no per-agent opt-in to consult)", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, undefined)).toBe("claude-sdk");
  });

  it("returns claude-sdk when agents.list is missing", () => {
    expect(selectAgentRuntime(mkCfg(undefined), "a")).toBe("claude-sdk");
  });

  it("returns claude-sdk when the agent is not found in the list", () => {
    const cfg = mkCfg([{ id: "other", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("claude-sdk");
  });

  it("returns claude-sdk when the agent has no runtime field", () => {
    const cfg = mkCfg([{ id: "a" }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("claude-sdk");
  });

  it("returns default (legacy) only when the agent explicitly opts into embedded", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "embedded" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns default (legacy) when the agent explicitly opts into acp", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "acp" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("default");
  });

  it("returns claude-sdk on explicit opt-in", () => {
    const cfg = mkCfg([{ id: "a", runtime: { type: "claude-sdk" } }]);
    expect(selectAgentRuntime(cfg, "a")).toBe("claude-sdk");
  });

  it("normalizes agent IDs on both sides so camelCase entries still match", () => {
    // Config uses a camelCase id; selector is invoked with the lowercase
    // normalized form (same shape agent routing uses elsewhere). The
    // selector must match despite the string diff -- and the match must
    // win over the default so legacy opt-outs are respected.
    const cfg = mkCfg([{ id: "MyAgent", runtime: { type: "embedded" } }]);
    expect(selectAgentRuntime(cfg, "myagent")).toBe("default");
  });

  it("normalizes agent IDs with inverse casing too", () => {
    const cfg = mkCfg([{ id: "myagent", runtime: { type: "embedded" } }]);
    expect(selectAgentRuntime(cfg, "MyAgent")).toBe("default");
  });
});
