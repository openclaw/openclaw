import { describe, expect, it } from "vitest";
import { expandPolicyToolRequirement, toolListCoversTool } from "./tool-policy-conformance.js";

describe("policy tool group conformance", () => {
  it("normalizes aliases and expands groups", () => {
    expect(toolListCoversTool(["bash"], "exec")).toBe(true);
    expect(toolListCoversTool(["apply-patch"], "apply_patch")).toBe(true);
    expect(toolListCoversTool(["cron"], "automations")).toBe(true);
    expect(expandPolicyToolRequirement("cron")).toEqual(["automations"]);
    expect(expandPolicyToolRequirement("group:web")).toEqual([
      "web_search",
      "web_fetch",
      "x_search",
    ]);
  });

  it("keeps coverage lists restrictive without the runtime write compatibility", () => {
    expect(toolListCoversTool([], "exec")).toBe(false);
    expect(toolListCoversTool(["write"], "apply_patch")).toBe(false);
    expect(toolListCoversTool(["*"], "exec")).toBe(true);
  });

  it("matches wildcard tool requirements", () => {
    expect(toolListCoversTool(["web_*"], "web_search")).toBe(true);
    expect(toolListCoversTool(["web_*"], "memory_search")).toBe(false);
  });
});
