import { OperatorNode } from "./operator";
import { createEnvelope } from "../../govdoss-core/src/ooda";
import { evaluateGovdossPolicy } from "../../govdoss-core/src/policy";
import { ApprovalQueue } from "../../govdoss-core/src/approval";
import { AuditBuffer, createAuditEvent } from "../../govdoss-core/src/audit";

export class GovdossOperatorNode {
  private readonly operator = new OperatorNode();
  private readonly approvals = new ApprovalQueue();
  private readonly audit = new AuditBuffer();

  async run(goal, rawObservation, context) {
    const observe = createEnvelope("observe", rawObservation);
    const orient = createEnvelope("orient", {
      goal,
      context,
      observation: observe.input
    });
    const decide = createEnvelope("decide", {
      goal,
      mode: context?.mode || "approval-required"
    });

    const policy = evaluateGovdossPolicy({
      risk: decide.risk || "MEDIUM",
      mode: context?.mode || "approval-required"
    });

    this.audit.add(
      createAuditEvent({
        subject: context?.sessionId || "unknown-session",
        object: "operator-node",
        authentication: "workspace-session",
        authorization: policy.allowed ? "allowed" : "blocked",
        approval: policy.requiresApproval ? "required" : "not-required",
        action: "operator.run",
        outcome: policy.allowed ? "continue" : "hold",
        metadata: { goal }
      })
    );

    if (policy.requiresApproval) {
      const request = this.approvals.create({
        id: `approval-${Date.now()}`,
        subject: context?.sessionId || "unknown-session",
        action: goal,
        risk: decide.risk || "MEDIUM"
      });

      return {
        status: "approval-required",
        observe,
        orient,
        decide,
        policy,
        approvalRequest: request,
        audit: this.audit.list()
      };
    }

    if (!policy.allowed) {
      return {
        status: "blocked",
        observe,
        orient,
        decide,
        policy,
        audit: this.audit.list()
      };
    }

    const act = createEnvelope("act", { goal });
    const result = await this.operator.run(goal, rawObservation, context);
    const assess = createEnvelope("assess", result);

    this.audit.add(
      createAuditEvent({
        subject: context?.sessionId || "unknown-session",
        object: "operator-node",
        authentication: "workspace-session",
        authorization: "allowed",
        approval: "not-required",
        action: "operator.execute",
        outcome: result?.status || "unknown",
        metadata: { goal }
      })
    );

    return {
      status: "completed-with-governance",
      observe,
      orient,
      decide,
      act,
      assess,
      result,
      audit: this.audit.list()
    };
  }
}
