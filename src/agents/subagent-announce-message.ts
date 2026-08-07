import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import type { SubagentAnnounceTarget } from "./subagent-announce-target.types.js";
export type SubagentAnnounceType = "subagent task" | "cron job";

export function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  announceTarget?: SubagentAnnounceTarget;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage && params.announceTarget === "parent") {
    return buildParentOnlyDirectReplyInstruction(params.announceType);
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

export function buildParentOnlyDirectReplyInstruction(announceType: string): string {
  return `A completed ${announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. This completion is parent-only: your normal final reply stays internal and is not published automatically. If a user-facing update is appropriate, publish it explicitly with the message tool to the original destination; otherwise reply ONLY: ${SILENT_REPLY_TOKEN} to record intentional silence. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
}

export function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}
