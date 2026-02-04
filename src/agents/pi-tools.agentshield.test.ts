import { describe, it, expect, vi, afterEach } from "vitest";
import {
  wrapToolWithAgentShieldApproval,
  __testing,
} from "./pi-tools.agentshield.js";
import type { AnyAgentTool } from "./tools/common.js";

const { isEnabled, needsApproval, canonicalParamsJSON } = __testing;

function makeTool(result: unknown): AnyAgentTool {
  return {
    name: "test_tool",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as AnyAgentTool;
}

describe("canonicalParamsJSON", () => {
  it("returns {} for undefined", () => {
    expect(canonicalParamsJSON(undefined)).toBe("{}");
  });

  it("returns {} for null", () => {
    expect(canonicalParamsJSON(null)).toBe("{}");
  });

  it("wraps a string value", () => {
    expect(canonicalParamsJSON("hello")).toBe('"hello"');
  });

  it("sorts object keys", () => {
    const result = canonicalParamsJSON({ b: 2, a: 1 });
    expect(result).toBe('{"a":1,"b":2}');
  });

  it("is deterministic", () => {
    const params = { z: 3, m: 1, a: 2 };
    expect(canonicalParamsJSON(params)).toBe(canonicalParamsJSON(params));
  });
});

describe("needsApproval", () => {
  it("returns false for null", () => {
    expect(needsApproval(null)).toBe(false);
  });

  it("returns false for string", () => {
    expect(needsApproval("hello")).toBe(false);
  });

  it("detects needs_approval in details (underscore)", () => {
    expect(needsApproval({ details: { action: "needs_approval" } })).toBe(true);
  });

  it("detects needs-approval in details (hyphen)", () => {
    expect(needsApproval({ details: { action: "needs-approval" } })).toBe(true);
  });

  it("returns false for unrelated details action", () => {
    expect(needsApproval({ details: { action: "other" } })).toBe(false);
  });

  it("detects needs_approval in content text JSON", () => {
    const result = {
      content: [{ text: JSON.stringify({ action: "needs_approval" }) }],
    };
    expect(needsApproval(result)).toBe(true);
  });

  it("returns false for non-JSON content text", () => {
    const result = { content: [{ text: "not json" }] };
    expect(needsApproval(result)).toBe(false);
  });

  it("returns false for content text with unrelated action", () => {
    const result = {
      content: [{ text: JSON.stringify({ action: "allowed" }) }],
    };
    expect(needsApproval(result)).toBe(false);
  });
});

describe("isEnabled", () => {
  const original = process.env.AGENTSHIELD_APPROVALS_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    } else {
      process.env.AGENTSHIELD_APPROVALS_ENABLED = original;
    }
  });

  it("returns true when env is 1", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    expect(isEnabled()).toBe(true);
  });

  it("returns false when env is unset", () => {
    delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    expect(isEnabled()).toBe(false);
  });

  it("returns false when env is 0", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "0";
    expect(isEnabled()).toBe(false);
  });
});

describe("wrapToolWithAgentShieldApproval", () => {
  const original = process.env.AGENTSHIELD_APPROVALS_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    } else {
      process.env.AGENTSHIELD_APPROVALS_ENABLED = original;
    }
  });

  it("passes through when feature is disabled", async () => {
    delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    const inner = { content: [{ type: "text", text: "ok" }] };
    const tool = makeTool(inner);
    const wrapped = wrapToolWithAgentShieldApproval(tool);
    // When disabled, the original tool object is returned unchanged.
    expect(wrapped).toBe(tool);
  });

  it("passes through when result has no approval signal", async () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const inner = { content: [{ type: "text", text: "ok" }] };
    const tool = makeTool(inner);
    const wrapped = wrapToolWithAgentShieldApproval(tool, { agentId: "a1" });
    const result = await wrapped.execute!("tc-1", { x: 1 }, undefined as never);
    expect(result).toBe(inner);
  });

  it("returns approval-pending when details has needs_approval", async () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const inner = { details: { action: "needs_approval" } };
    const tool = makeTool(inner);
    const wrapped = wrapToolWithAgentShieldApproval(tool, {
      agentId: "a1",
      sessionKey: "s1",
    });
    const result = await wrapped.execute!("tc-1", { cmd: "ls" }, undefined as never);
    expect(result).toBeDefined();
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.status).toBe("approval-pending");
    expect(details.tool).toBe("test_tool");
    expect(details.agentId).toBe("a1");
    expect(details.sessionKey).toBe("s1");
    expect(typeof details.paramsJSON).toBe("string");
  });

  it("returns approval-pending when content text has needs-approval", async () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const inner = {
      content: [{ text: JSON.stringify({ action: "needs-approval" }) }],
    };
    const tool = makeTool(inner);
    const wrapped = wrapToolWithAgentShieldApproval(tool);
    const result = await wrapped.execute!("tc-1", {}, undefined as never);
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.status).toBe("approval-pending");
  });

  it("paramsJSON in result matches canonicalParamsJSON", async () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const inner = { details: { action: "needs_approval" } };
    const tool = makeTool(inner);
    const params = { b: 2, a: 1 };
    const wrapped = wrapToolWithAgentShieldApproval(tool);
    const result = await wrapped.execute!("tc-1", params, undefined as never);
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.paramsJSON).toBe(canonicalParamsJSON(params));
  });

  it("returns original tool when execute is absent", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const tool = { name: "no_exec" } as unknown as AnyAgentTool;
    const wrapped = wrapToolWithAgentShieldApproval(tool);
    expect(wrapped).toBe(tool);
  });
});
