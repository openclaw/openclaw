import { describe, expect, it } from "vitest";
import { buildAgentHookContext } from "./hook-context.js";

describe("buildAgentHookContext", () => {
  it("carries accountId through to the plugin hook context", () => {
    expect(buildAgentHookContext({ runId: "r1", accountId: "acct-1" }).accountId).toBe("acct-1");
  });

  it("omits accountId when absent, matching the sparse context contract", () => {
    expect("accountId" in buildAgentHookContext({ runId: "r1" })).toBe(false);
  });
});
