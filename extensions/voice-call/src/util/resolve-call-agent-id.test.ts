import { describe, expect, it } from "vitest";
import { resolveCallAgentId } from "./resolve-call-agent-id.js";

describe("resolveCallAgentId", () => {
  it("prefers call.agentId over effectiveConfig.agentId", () => {
    expect(resolveCallAgentId({ agentId: "slack-u123" }, { agentId: "main" })).toBe("slack-u123");
  });

  it("falls back to effectiveConfig.agentId when call.agentId is unset", () => {
    expect(resolveCallAgentId({ agentId: undefined }, { agentId: "owner" })).toBe("owner");
  });

  it("falls back to literal 'main' when neither is set", () => {
    expect(resolveCallAgentId({ agentId: undefined }, { agentId: undefined })).toBe("main");
  });

  it("treats empty string call.agentId as unset (falsy)", () => {
    expect(resolveCallAgentId({ agentId: "" }, { agentId: "owner" })).toBe("owner");
  });

  it("treats empty string effectiveConfig.agentId as unset (falsy)", () => {
    expect(resolveCallAgentId({ agentId: undefined }, { agentId: "" })).toBe("main");
  });
});
