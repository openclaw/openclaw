// One-stop gatekeep: evaluate policy, prompt operator if needed, persist
// allow-always to config, audit the outcome. Returns a uniform decision
// the tool can act on.

import { requestFileTransferApproval } from "./approval.js";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import type { GatewayCallOptions } from "./params.js";
import { evaluateFilePolicy, persistAllowAlways, type FilePolicyKind } from "./policy.js";

export type GatekeepOutcome = { ok: true; maxBytes?: number } | { ok: false; throwMessage: string };

/**
 * Single-call entry point used by every tool's execute() before it
 * forwards to the node. Handles policy evaluation, optional
 * plugin-approval prompt, persistence on allow-always, and the
 * pre-flight audit log entry.
 *
 * Caller is responsible for the post-flight check (re-evaluate against
 * canonicalPath returned by the node) — we don't have the canonical
 * path here yet.
 */
export async function gatekeep(input: {
  op: FileTransferAuditOp;
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  path: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  startedAt: number;
  /** Operation-friendly label for the approval prompt, e.g. "Read file". */
  promptVerb: string;
}): Promise<GatekeepOutcome> {
  const decision = evaluateFilePolicy({
    nodeId: input.nodeId,
    nodeDisplayName: input.nodeDisplayName,
    kind: input.kind,
    path: input.path,
  });

  // Silent allow path.
  if (decision.ok && decision.reason === "matched-allow") {
    return { ok: true, maxBytes: decision.maxBytes };
  }

  // ask=always: prompt even on a match.
  // Or: ask=on-miss + no allow match: prompt.
  const shouldAsk =
    (decision.ok && decision.reason === "ask-always") ||
    (!decision.ok && decision.askable === true);

  if (shouldAsk) {
    const verb = input.promptVerb;
    const subject = input.nodeDisplayName ?? input.nodeId;
    const approval = await requestFileTransferApproval({
      gatewayOpts: input.gatewayOpts,
      title: `${verb}: ${input.path}`,
      description: `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\nKind: ${input.kind}\n\n"allow-always" appends this exact path to allow${input.kind === "read" ? "Read" : "Write"}Paths.`,
      severity: input.kind === "write" ? "warning" : "info",
      toolName: input.op,
      toolCallId: input.toolCallId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
    });

    if (approval.decision === "deny") {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.nodeId,
        nodeDisplayName: input.nodeDisplayName,
        requestedPath: input.path,
        decision: "denied:approval",
        reason: "operator denied",
        durationMs: Date.now() - input.startedAt,
      });
      return {
        ok: false,
        throwMessage: `${input.op} APPROVAL_DENIED: operator denied the prompt`,
      };
    }

    if (approval.decision === "allow-once") {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.nodeId,
        nodeDisplayName: input.nodeDisplayName,
        requestedPath: input.path,
        decision: "allowed:once",
        durationMs: Date.now() - input.startedAt,
      });
      return {
        ok: true,
        maxBytes: decision.ok ? decision.maxBytes : undefined,
      };
    }

    if (approval.decision === "allow-always") {
      try {
        await persistAllowAlways({
          nodeId: input.nodeId,
          nodeDisplayName: input.nodeDisplayName,
          kind: input.kind,
          path: input.path,
        });
      } catch (e) {
        // The approval is still valid for this call — failure to persist
        // shouldn't block the operation. Just note it in the audit.
        await appendFileTransferAudit({
          op: input.op,
          nodeId: input.nodeId,
          nodeDisplayName: input.nodeDisplayName,
          requestedPath: input.path,
          decision: "allowed:always",
          reason: `persist failed: ${String(e)}`,
          durationMs: Date.now() - input.startedAt,
        });
        return {
          ok: true,
          maxBytes: decision.ok ? decision.maxBytes : undefined,
        };
      }
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.nodeId,
        nodeDisplayName: input.nodeDisplayName,
        requestedPath: input.path,
        decision: "allowed:always",
        durationMs: Date.now() - input.startedAt,
      });
      return {
        ok: true,
        maxBytes: decision.ok ? decision.maxBytes : undefined,
      };
    }

    // null decision: no operator available, treat as deny.
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.nodeId,
      nodeDisplayName: input.nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: "no operator available to approve",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      throwMessage: `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`,
    };
  }

  // Plain deny path.
  if (!decision.ok) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.nodeId,
      nodeDisplayName: input.nodeDisplayName,
      requestedPath: input.path,
      decision: decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
      errorCode: decision.code,
      reason: decision.reason,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      throwMessage: `${input.op} ${decision.code}: ${decision.reason}`,
    };
  }

  // Shouldn't reach here.
  return { ok: true, maxBytes: undefined };
}
