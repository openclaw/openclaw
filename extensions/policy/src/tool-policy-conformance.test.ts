import { describe, expect, it } from "vitest";
import {
  expandPolicyToolRequirement,
  POLICY_TOOL_GROUPS,
  toolListCoversTool,
} from "./tool-policy-conformance.js";

describe("policy tool group conformance", () => {
  it("keeps computer control in both node and OpenClaw policy groups", () => {
    expect(POLICY_TOOL_GROUPS["group:nodes"]).toContain("computer");
    expect(POLICY_TOOL_GROUPS["group:openclaw"]).toContain("computer");
    expect(POLICY_TOOL_GROUPS["group:nodes"]).toContain("mobile_ui");
    expect(POLICY_TOOL_GROUPS["group:openclaw"]).toContain("mobile_ui");
  });

  it("normalizes aliases and expands groups", () => {
    expect(toolListCoversTool(["bash"], "exec")).toBe(true);
    expect(toolListCoversTool(["apply-patch"], "apply_patch")).toBe(true);
    expect(expandPolicyToolRequirement("group:web")).toEqual([
      "web_search",
      "web_fetch",
      "x_search",
    ]);
  });

  it("matches wildcard tool requirements", () => {
    expect(toolListCoversTool(["web_*"], "web_search")).toBe(true);
    expect(toolListCoversTool(["web_*"], "memory_search")).toBe(false);
  });
});
