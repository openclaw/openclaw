import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));
vi.mock("../policy/policy.manager.js", () => ({
  getPolicyManagerState: vi.fn(async () => ({
    enabled: true,
    valid: true,
    lockdown: false,
    failClosed: true,
    policyPath: "/tmp/POLICY.json",
    sigPath: "/tmp/POLICY.sig",
    publicKey: "public",
    policy: { version: 1 },
  })),
}));
vi.mock("../policy/policy.evaluate.js", () => ({
  evaluateToolCall: vi.fn(() => ({ allow: false, reason: "blocked by test policy" })),
}));
vi.mock("./bash-tools.exec-approval-request.js", () => ({
  requestExecApprovalDecision: vi.fn(async () => null),
}));

import { evaluateToolCall } from "../policy/policy.evaluate.js";
import { getPolicyManagerState } from "../policy/policy.manager.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

describe("policy guardrails tool gate", () => {
  beforeEach(() => {
    vi.mocked(getPolicyManagerState).mockClear();
    vi.mocked(evaluateToolCall).mockClear();
  });

  it("does not execute denied tools", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = wrapToolWithBeforeToolCallHook({
      name: "exec",
      execute,
    } as unknown as AnyAgentTool);

    await expect(
      wrapped.execute("tool-call-1", { command: "whoami" }, undefined, undefined),
    ).rejects.toThrow("Denied by policy");
    expect(execute).not.toHaveBeenCalled();
  });
});
