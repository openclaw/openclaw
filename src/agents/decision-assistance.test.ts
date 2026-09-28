import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../config/zod-schema.agent-defaults-base.js";
import { isDecisionAssistanceEligible } from "./decision-assistance.js";

describe("Decision assistance foundation", () => {
  it("requires a decision model even when assistance is enabled", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { decisionAssistance: true } } },
    };
    expect(isDecisionAssistanceEligible(config, "support")).toBe(false);
  });

  it.each([undefined, { localModelLean: true }])(
    "does not infer consent from omitted/option-bearing experimental config %j",
    (experimental) => {
      const defaults = AgentDefaultsBaseSchema.parse({
        experimental,
        decisionModel: "example/decision",
      });
      expect(defaults.experimental?.decisionAssistance).not.toBe(true);
      expect(isDecisionAssistanceEligible({ agents: { defaults } }, "support")).toBe(false);
    },
  );

  it.each([{ enabled: true }, "true", 1, null])(
    "rejects non-Boolean gate %j rather than implicitly opting in",
    (decisionAssistance) => {
      expect(
        AgentDefaultsBaseSchema.safeParse({ experimental: { decisionAssistance } }).success,
      ).toBe(false);
    },
  );

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
