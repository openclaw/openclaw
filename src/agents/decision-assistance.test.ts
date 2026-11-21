import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../config/zod-schema.agent-defaults-base.js";
import { isDecisionAssistanceEligible } from "./decision-assistance.js";

describe("Decision assistance foundation", () => {
  it.each([
    { experimental: undefined, decisionModel: "example/decision" },
    { experimental: { localModelLean: true }, decisionModel: "example/decision" },
    { experimental: { decisionAssistance: true }, decisionModel: undefined },
  ])("requires explicit consent and a decision model: %j", (input) => {
    const defaults = AgentDefaultsBaseSchema.parse(input);
    if (input.decisionModel) {
      expect(defaults.experimental?.decisionAssistance).not.toBe(true);
    }
    expect(isDecisionAssistanceEligible({ agents: { defaults } }, "support")).toBe(false);
  });

  it("rejects a string gate rather than coercing consent", () => {
    expect(
      AgentDefaultsBaseSchema.safeParse({ experimental: { decisionAssistance: "true" } }).success,
    ).toBe(false);
  });

  it("preserves global inheritance and empty agent overrides through opt-out and model changes", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: AgentDefaultsBaseSchema.parse({
          experimental: { decisionAssistance: true },
          decisionModel: "example/global",
        }),
        entries: {
          inherit: {},
          quiet: { decisionModel: "" },
          selected: { decisionModel: "example/agent" },
        },
      },
    };
    expect(isDecisionAssistanceEligible(config, "inherit")).toBe(true);
    expect(isDecisionAssistanceEligible(config, "quiet")).toBe(false);
    expect(isDecisionAssistanceEligible(config, "selected")).toBe(true);
    config.agents!.defaults!.decisionModel = "";
    expect(isDecisionAssistanceEligible(config, "inherit")).toBe(false);
    expect(isDecisionAssistanceEligible(config, "selected")).toBe(true);
    config.agents!.defaults!.experimental!.decisionAssistance = false;
    expect(isDecisionAssistanceEligible(config, "selected")).toBe(false);
  });
});
