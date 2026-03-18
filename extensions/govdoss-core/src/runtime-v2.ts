import { createEnvelope } from "./ooda";
import { evaluateGovdossPolicy } from "./policy";
import { scoreGovdossRisk } from "./risk";
import { ApprovalQueue } from "./approval";
import { AuditBuffer, createAuditEvent } from "./audit";
import { createContinuation, markContinuationReady } from "./resume";

export class GovdossRuntimeV2 {
  private approvals = new ApprovalQueue();
  private audit = new AuditBuffer();
  private continuations = new Map();

  async execute({ subject, action, context, executor }) {
    const observe = createEnvelope("observe", { action, context });

    const risk = scoreGovdossRisk({
      action: action?.type,
      mode: context?.mode,
      targetType: action?.targetType,
      containsSensitiveData: action?.containsSensitiveData,
      externalDestination: action?.externalDestination
    });

    const decide = createEnvelope("decide", { action, risk });

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
        action: "runtime.execute.v2",
        outcome: policy.allowed ? "continue" : "hold",
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

      const continuation = createContinuation({
        approvalId: request.id,
        subject,
        action: action?.type || "unknown"
      });

      this.continuations.set(request.id, {
        continuation,
        action,
        context,
        executor
      });

      this.audit.add(
        createAuditEvent({
          subject,
          object: action?.type || "unknown",
          authentication: "session",
          authorization: "approval-pending",
          approval: "required",
          action: "runtime.continuation.created",
          outcome: request.id,
          metadata: { risk }
        })
      );

      return {
        status: "approval-required",
        approvalRequest: request,
        continuation,
        observe,
        decide,
        audit: this.audit.list()
      };
    }

    if (!policy.allowed) {
      return {
        status: "blocked",
        observe,
        decide,
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
        action: "runtime.executed.v2",
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
      result,
      audit: this.audit.list()
    };
  }

  approve(approvalId) {
    const request = this.approvals.approve(approvalId);
    const stored = this.continuations.get(approvalId);

    if (!request || !stored) {
      return null;
    }

    const ready = markContinuationReady(stored.continuation);
    stored.continuation = ready;
    this.continuations.set(approvalId, stored);

    this.audit.add(
      createAuditEvent({
        subject: request.subject,
        object: request.action,
        authentication: "session",
        authorization: "approved",
        approval: "granted",
        action: "runtime.approval.granted",
        outcome: approvalId
      })
    );

    return ready;
  }

  async resume(approvalId) {
    const stored = this.continuations.get(approvalId);

    if (!stored || stored.continuation.status !== "ready") {
      return {
        status: "resume-blocked",
        audit: this.audit.list()
      };
    }

    const act = createEnvelope("act", stored.action);
    const result = await stored.executor();
    const assess = createEnvelope("assess", result);

    this.audit.add(
      createAuditEvent({
        subject: stored.continuation.subject,
        object: stored.action?.type || "unknown",
        authentication: "session",
        authorization: "allowed",
        approval: "used",
        action: "runtime.resumed",
        outcome: result?.status || "completed"
      })
    );

    this.continuations.delete(approvalId);

    return {
      status: "resumed-and-executed",
      continuation: stored.continuation,
      act,
      assess,
      result,
      audit: this.audit.list()
    };
  }
}
