import { describe, expect, it } from "vitest";
import { POLICY_TOOL_GROUPS } from "./tool-policy-conformance.js";

const agentGroupTools = [
  "agents_list",
  "get_goal",
  "create_goal",
  "update_goal",
  "update_plan",
  "skill_workshop",
] as const;

describe("POLICY_TOOL_GROUPS", () => {
  it("keeps group:agents aligned with the core agent tool group", () => {
    expect(POLICY_TOOL_GROUPS["group:agents"]).toEqual(agentGroupTools);
  });

  it("keeps group:openclaw covering the same agent tools as group:agents", () => {
    expect(POLICY_TOOL_GROUPS["group:openclaw"]).toEqual(
      expect.arrayContaining(agentGroupTools),
    );
  });
});
