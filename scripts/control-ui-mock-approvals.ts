import type {
  ApprovalResolveResult,
  PendingApprovalSnapshot,
  SessionApprovalEvent,
  SessionApprovalReplay,
  TerminalApprovalSnapshot,
} from "../packages/gateway-protocol/src/schema/approvals.js";
import type { ExecApprovalRequest } from "../ui/src/app/exec-approval.ts";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

/** Runs in the preview document; one record owns Inbox, replay, and resolution. */
function installApprovalMock(includeInbox: boolean): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Approval fixtures require the mock Gateway");
  }
  const now = Date.now();
  const seeds: (PendingApprovalSnapshot & {
    sourceSessionKey: string;
    request: Pick<ExecApprovalRequest["request"], "cwd" | "security" | "ask">;
    presentation: Extract<PendingApprovalSnapshot["presentation"], { kind: "exec" }>;
  })[] = [
    {
      id: "mock-production-export-approval",
      urlPath: "/api/approvals/mock-production-export-approval",
      sourceSessionKey: "agent:main:production-export",
      request: { cwd: "/Users/demo/Projects/openclaw", security: "full", ask: "on-miss" },
      createdAtMs: now - 7 * 60_000,
      expiresAtMs: now + 4 * 60 * 60_000,
      status: "pending",
      presentation: {
        kind: "exec",
        commandText: "openclaw export --target production",
        commandPreview: "Export the prepared release bundle",
        warningText: "This action writes outside the preview workspace.",
        host: "mock-workstation.invalid",
        agentId: "main",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
    {
      id: "mock-worktree-cleanup-approval",
      urlPath: "/api/approvals/mock-worktree-cleanup-approval",
      sourceSessionKey: "agent:main:worktree-cleanup",
      request: { cwd: "/mock/workspace", security: "sandboxed", ask: "always" },
      createdAtMs: now - 6 * 60_000,
      expiresAtMs: now + 4 * 60 * 60_000,
      status: "pending",
      presentation: {
        kind: "exec",
        commandText: "git -C /mock/workspace clean -nd",
        host: "mock-workstation.invalid",
        agentId: "release",
        allowedDecisions: ["allow-once", "deny"],
      },
    },
  ];
  const pending = new Map(
    seeds
      .filter((_, index) => includeInbox || index === 0)
      .map((approval) => [approval.id, approval]),
  );
  const resolved = new Map<string, TerminalApprovalSnapshot>();
  const publishReads = () => {
    const inbox: ExecApprovalRequest[] = [];
    if (includeInbox) {
      for (const approval of pending.values()) {
        inbox.push({
          id: approval.id,
          kind: "exec",
          createdAtMs: approval.createdAtMs,
          expiresAtMs: approval.expiresAtMs,
          request: {
            ...approval.request,
            command: approval.presentation.commandText,
            host: approval.presentation.host,
            agentId: approval.presentation.agentId,
            sessionKey: approval.sourceSessionKey,
            allowedDecisions: approval.presentation.allowedDecisions,
          },
        });
      }
    }
    gateway.setMethodResponse("exec.approval.list", inbox);
    // Keep the generic subscription path so transcript stream tracking still runs.
    gateway.setMethodResponse("sessions.messages.subscribe", {
      cases: seeds.map((seed) => {
        const sessionKey = seed.sourceSessionKey;
        const approvalReplay: SessionApprovalReplay = {
          sessionKey,
          updatedAtMs: Date.now(),
          truncated: false,
          approvals: [...pending.values()]
            .filter((entry) => entry.sourceSessionKey === sessionKey)
            .map(({ request: _request, ...approval }) => approval),
        };
        return {
          match: { key: sessionKey, includeApprovals: true },
          response: { key: sessionKey, approvalReplay },
        };
      }),
    });
  };
  publishReads();
  for (const method of ["approval.resolve", "exec.approval.resolve"]) {
    gateway.setRequestHandler(method, ({ params: input, respond, emit }) => {
      const params = (input ?? {}) as { id?: string; kind?: string; decision?: string };
      const seed = seeds.find((entry) => entry.id === params.id);
      const decision = params.decision;
      if (
        !seed ||
        (method === "approval.resolve" && params.kind !== "exec") ||
        (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") ||
        !seed.presentation.allowedDecisions.includes(decision)
      ) {
        respond({
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Unknown approval or unavailable decision; refresh the approval list.",
          },
        });
        return;
      }
      let approval = resolved.get(seed.id);
      const applied = !approval;
      if (!approval) {
        const { status: _status, sourceSessionKey, request: _request, ...common } = seed;
        approval = {
          ...common,
          resolvedAtMs: Date.now(),
          source: { sessionKey: sourceSessionKey },
          reason: "user",
          ...(decision === "deny"
            ? { status: "denied", decision }
            : { status: "allowed", decision }),
        };
        resolved.set(seed.id, approval);
        pending.delete(seed.id);
        publishReads();
      }
      const result: ApprovalResolveResult = { applied, approval };
      respond(method === "approval.resolve" ? result : { ok: true });
      if (applied) {
        const event: SessionApprovalEvent = {
          sessionKey: seed.sourceSessionKey,
          sourceSessionKey: seed.sourceSessionKey,
          updatedAtMs: approval.resolvedAtMs,
          phase: "terminal",
          approval,
        };
        emit("session.approval", event);
        emit("exec.approval.resolved", { id: seed.id, decision, ts: approval.resolvedAtMs });
      }
    });
  }
}

export function approvalMockInitScript(includeInbox: boolean): string {
  return `(() => { const __name = (target) => target; (${installApprovalMock.toString()})(${JSON.stringify(includeInbox)}); })();`;
}
