import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/acpx";
import type {
  CodexNativeStatus,
  CodexProposalExecutionResult,
  CodexRouteSummary,
} from "./controller.js";
import type {
  CodexCompatibilityRecord,
  CodexEventRecord,
  CodexProposalRecord,
  CodexSessionRecord,
} from "./state.js";

export function formatCodexStatus(status: CodexNativeStatus): string {
  const routeCount = status.routes.length;
  const sessionCount = status.sessions.length;
  const newInbox = status.inbox.filter((proposal) => proposal.status === "new").length;
  return [
    `Codex SDK: ${status.healthy ? "ready" : "not yet probed"}`,
    `Backend: ${status.backend}`,
    `Default route: ${status.defaultRoute}`,
    `Routes: ${routeCount}`,
    `Recent sessions: ${sessionCount}`,
    `New proposals: ${newInbox}`,
    `Backchannel: ${status.backchannel.enabled ? "enabled" : "disabled"} (${status.backchannel.server})`,
  ].join("\n");
}

export function formatCodexRoutes(routes: CodexRouteSummary[]): string {
  if (routes.length === 0) {
    return "No Codex routes are configured.";
  }
  return routes
    .map((route) => {
      const parts = [
        route.model ? `model=${route.model}` : "",
        route.modelReasoningEffort ? `reasoning=${route.modelReasoningEffort}` : "",
        route.sandboxMode ? `sandbox=${route.sandboxMode}` : "",
        route.approvalPolicy ? `approval=${route.approvalPolicy}` : "",
        route.webSearchMode ? `webSearch=${route.webSearchMode}` : "",
      ].filter(Boolean);
      const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `- ${route.label}${suffix}\n  aliases: ${route.aliases.join(", ")}`;
    })
    .join("\n");
}

export function formatCodexSessions(sessions: CodexSessionRecord[]): string {
  if (sessions.length === 0) {
    return "No Codex sessions recorded yet.";
  }
  return sessions
    .map((session) => {
      const thread = session.threadId ? ` thread=${session.threadId}` : "";
      const model = session.model ? ` model=${session.model}` : "";
      const reasoning = session.modelReasoningEffort
        ? ` reasoning=${session.modelReasoningEffort}`
        : "";
      const error = session.lastError ? ` error=${session.lastError}` : "";
      return `- ${session.sessionKey} ${session.routeLabel} ${session.status} turns=${session.turnCount}${model}${reasoning}${thread}${error}`;
    })
    .join("\n");
}

export function formatCodexEvents(events: CodexEventRecord[]): string {
  if (events.length === 0) {
    return "No Codex events recorded for this session.";
  }
  return events
    .map((event) => {
      const mapped = event.mappedEvents.map(formatRuntimeEvent).join("\n  ");
      return `- ${event.at} ${event.sdkEventType}\n  ${mapped}`;
    })
    .join("\n");
}

export function formatCodexInbox(proposals: CodexProposalRecord[]): string {
  if (proposals.length === 0) {
    return "Codex proposal inbox is empty.";
  }
  return proposals
    .map((proposal) => {
      const summary = proposal.summary ? `\n  ${proposal.summary}` : "";
      const actions =
        proposal.actions && proposal.actions.length > 0
          ? `\n  actions: ${proposal.actions.join("; ")}`
          : "";
      const execution = proposal.executedAt
        ? `\n  executed: ${proposal.executedAt} session=${proposal.executedSessionKey ?? "unknown"}`
        : proposal.lastExecutionError
          ? `\n  execution error: ${proposal.lastExecutionError}`
          : "";
      return `- ${proposal.id} [${proposal.status}] ${proposal.title}${summary}${actions}${execution}`;
    })
    .join("\n");
}

export function formatCompatibilityRecord(record: CodexCompatibilityRecord): string {
  return [
    `Codex SDK compatibility: ${record.ok ? "pass" : "fail"}`,
    `Record: ${record.id}`,
    `SDK: ${record.sdkPackage}@${record.sdkVersion}`,
    `Default route: ${record.defaultRoute}`,
    ...record.checks.map((check) => `- ${check.id}: ${check.status} - ${check.message}`),
  ].join("\n");
}

export function formatProposalUpdate(proposal: CodexProposalRecord | null): string {
  if (!proposal) {
    return "Codex proposal not found.";
  }
  return `Codex proposal ${proposal.id} marked ${proposal.status}: ${proposal.title}`;
}

export function formatProposalExecution(result: CodexProposalExecutionResult): string {
  const output = result.text ? `\n\n${result.text}` : "";
  return (
    [
      `Codex proposal executed: ${result.proposal.title}`,
      `Proposal: ${result.proposal.id}`,
      `Session: ${result.sessionKey}`,
      `Route: ${result.route.label}`,
      ...(result.backendSessionId ? [`Thread: ${result.backendSessionId}`] : []),
      `Events: ${result.events.length}`,
      `Completed: ${result.completedAt}`,
    ].join("\n") + output
  );
}

function formatRuntimeEvent(entry: AcpRuntimeEvent): string {
  if (entry.type === "text_delta") {
    return `text: ${entry.text}`;
  }
  if (entry.type === "status") {
    return `status: ${entry.text}`;
  }
  if (entry.type === "tool_call") {
    return `tool: ${entry.title ?? "tool"} - ${entry.text}`;
  }
  if (entry.type === "error") {
    return `error: ${entry.message}`;
  }
  return `done: ${entry.stopReason ?? "end_turn"}`;
}
