import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateWorkerExecApprovalParams,
  validateWorkerExecApprovalDecisionParams,
  WorkerExecApprovalDecisionResponseFrameSchema,
} from "./worker-exec-approval.js";

describe("worker exec approval protocol", () => {
  const request = {
    id: "approval-1",
    command: "hostname",
    cwd: "/workspace",
    toolCallId: "exec-1",
  };
  it("accepts bounded command details but rejects worker-supplied authority", () => {
    expect(validateWorkerExecApprovalParams(request)).toBe(true);
    for (const field of ["agentId", "sessionKey", "runId", "host", "security", "ask", "env"]) {
      expect(validateWorkerExecApprovalParams({ ...request, [field]: "forged" })).toBe(false);
    }
    expect(validateWorkerExecApprovalParams({ ...request, command: "x".repeat(32_769) })).toBe(
      false,
    );
    expect(validateWorkerExecApprovalDecisionParams({ id: request.id })).toBe(true);
    expect(validateWorkerExecApprovalDecisionParams({ id: request.id, runId: "forged" })).toBe(
      false,
    );
  });
  it("cannot return a persistent grant over the worker bridge", () => {
    const frame = { type: "res", id: "frame-1", ok: true, payload: { decision: "allow-always" } };
    expect(Value.Check(WorkerExecApprovalDecisionResponseFrameSchema, frame)).toBe(false);
    for (const decision of ["allow-once", "deny", null]) {
      expect(
        Value.Check(WorkerExecApprovalDecisionResponseFrameSchema, {
          ...frame,
          payload: { decision },
        }),
      ).toBe(true);
    }
  });
});
