import { createEnvelope } from "./ooda";
import { evaluateGovdossPolicy } from "./policy";
import { scoreGovdossRisk } from "./risk";
import { ApprovalQueue } from "./approval";
import { AuditBuffer, createAuditEvent } from "./audit";

export class GovdossRuntime {
  private approvals = new ApprovalQueue();
  private audit = new AuditBuffer();

  async execute({ subject, action, context, executor }) {
    const observe = createEnvelope("observe", { action, context });

    const risk = scoreGovdossRisk({
      action: action?.type,
      mode: context?.mode
    });

    const decide = createEnvelope("decide", {
      action,
      risk
    });

    const policy = evaluateGovdossPolicy({
      risk: risk.tier,
      mode: context?.mode
    });

    this.audit.add(
      createAuditEvent({
        subject,
        object: action?.type || "unknown",
        authentication: "session",
        authorization: policy.allowed ? "allowed" : "blocked",
        approval: policy.requiresApproval ? "required" : "not-required",
        action: "runtime.execute",
        outcome: policy.allowed ? "continue" : "halt",
        metadata: { risk }
      })
    );

    if (policy.requiresApproval) {
      const request = this.approvals.create({
        id: `approval-${Date.now()}`,
        subject,
        action: action?.type || "unknown",
        risk: risk.tier
      });

      return {
        status: "approval-required",
        approvalRequest: request,
        audit: this.audit.list()
      };
    }

    if (!policy.allowed) {
      return {
        status: "blocked",
        audit: this.audit.list()
      };
    }

    const act = createEnvelope("act", action);
    const result = await executor();
    const assess = createEnvelope("assess", result);

    this.audit.add(
      createAuditEvent({
        subject,
        object: action?.type || "unknown",
        authentication: "session",
        authorization: "allowed",
        approval: "not-required",
        action: "runtime.executed",
        outcome: "completed",
        metadata: { result }
      })
    );

    return {
      status: "executed",
      observe,
      decide,
      act,
      assess,
      audit: this.audit.list()
    };
  }
}
