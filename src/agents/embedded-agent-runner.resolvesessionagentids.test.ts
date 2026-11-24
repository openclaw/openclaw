import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import { AgentSelectionRequiredError } from "./agent-scope-config.js";
import { resolveSessionAgentIdStrict as resolve, resolveSessionAgentIds } from "./agent-scope.js";

const config: OpenClawConfig = { agents: { entries: { main: {}, beta: {} } } };

describe("session agent ownership", () => {
  it.each([
    { config: {}, expected: "main" },
    { config: { agents: { entries: { beta: {} } } }, expected: "beta" },
  ])("preserves ownerless fallback for %j", ({ config: fallbackConfig, expected }) => {
    expect(resolve({ config: fallbackConfig })).toBe(expected);
  });

  it("does not use retained migration metadata to select a runtime owner", () => {
    const migrated: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
    };
    setRetainedLegacyDefaultAgentId(migrated, "beta");
    expect(() => resolve({ config: migrated })).toThrow(AgentSelectionRequiredError);
    setRetainedLegacyDefaultAgentId(migrated, "retired");
    expect(() => resolve({ config: migrated })).toThrow(AgentSelectionRequiredError);
  });

  it("selects an explicit owner before the prepared fallback", () => {
    expect(
      resolve({
        config,
        sessionKey: "feishu:direct:ou_user1",
        agentId: "beta",
        fallbackAgentId: "main",
      }),
    ).toBe("beta");
  });

  it("keeps the selected owner for paired callers despite retained migration metadata", () => {
    const paired: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
    };
    setRetainedLegacyDefaultAgentId(paired, "main");
    expect(resolveSessionAgentIds({ config: paired, agentId: "beta" })).toEqual({
      defaultAgentId: "beta",
      sessionAgentId: "beta",
    });
  });
});
