// Fail-closed regression for the plan-mode gate hook.
//
// Plan mode is the read-only safety boundary. If the session-store read throws, an
// unreadable store cannot prove the session is NOT planning, so the gate must apply
// (blocking mutating tools while still allowing the read-only allowlist) instead of
// silently reporting the session inactive and letting mutations through.
import { describe, expect, it, vi } from "vitest";

// Force loadSessionEntry to throw so resolvePlanModeGate exercises its catch path.
// Only loadSessionEntry is consumed by gate-hook; resolveSessionPlanState (used here)
// takes the entry directly and never touches the mocked module's other exports.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: () => {
    throw new Error("simulated session store read failure");
  },
}));

import { resolvePlanModeGate } from "./gate-hook.js";

describe("resolvePlanModeGate — fail closed on store read failure", () => {
  const ctx = (toolName: string, toolParams?: unknown) => ({
    toolName,
    toolParams,
    sessionKey: "agent:main:telegram:direct:900",
    agentId: "main",
  });

  it("blocks a mutating tool when the store read throws", () => {
    const outcome = resolvePlanModeGate(ctx("write", { path: "x", content: "y" }));
    expect(outcome.blocked).toBe(true);
  });

  it("still allows a read-only allowlisted tool when the store read throws", () => {
    const outcome = resolvePlanModeGate(ctx("read", { path: "README.md" }));
    expect(outcome.blocked).toBe(false);
  });
});
