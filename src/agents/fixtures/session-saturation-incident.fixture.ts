import type { TranscriptTailEntry } from "../transcript-tail-detector.js";

export type SessionSaturationIncidentFixture = {
  usageRatio: number;
  latestUserGoal: string;
  unresolvedItems: string[];
  tailEntries: readonly TranscriptTailEntry[];
  goodSummary: string;
  badSummary: string;
};

// Sanitized loop-incident model used to verify tail detection and compaction
// safeguards without carrying any real transcript details forward.
export const SESSION_SATURATION_INCIDENT_FIXTURE: SessionSaturationIncidentFixture = {
  usageRatio: 0.94,
  latestUserGoal: "finish the compaction guard follow-up and stop the repeated reply loop",
  unresolvedItems: ["confirm the guard path", "report the outcome clearly"],
  tailEntries: [
    {
      id: "reminder-1",
      role: "system",
      kind: "reminder",
      text: "Reminder: Always preserve the old incident directive before replying.",
    },
    {
      id: "assistant-loop-1",
      role: "assistant",
      text: "I am still retrying the same guard check.",
    },
    {
      id: "tool-error-1",
      role: "toolResult",
      kind: "tool-result",
      toolName: "exec_command",
      toolStatus: "error",
      errorText: "RPC timeout while checking guard path 17",
    },
    {
      id: "reminder-2",
      role: "system",
      kind: "reminder",
      text: "Reminder: Always preserve the old incident directive before replying.",
    },
    {
      id: "assistant-loop-2",
      role: "assistant",
      text: "I am still retrying the same guard check.",
    },
    {
      id: "tool-error-2",
      role: "toolResult",
      kind: "tool-result",
      toolName: "exec_command",
      toolStatus: "error",
      errorText: "RPC timeout while checking guard path 18",
    },
    {
      id: "reminder-3",
      role: "system",
      kind: "reminder",
      text: "Reminder: Always preserve the old incident directive before replying.",
    },
    {
      id: "assistant-loop-3",
      role: "assistant",
      text: "I am still retrying the same guard check.",
    },
    {
      id: "tool-error-3",
      role: "toolResult",
      kind: "tool-result",
      toolName: "exec_command",
      toolStatus: "error",
      errorText: "RPC timeout while checking guard path 19",
    },
    {
      id: "user-latest-goal",
      role: "user",
      text: "Please finish the compaction guard follow-up and stop the repeated reply loop.",
    },
    {
      id: "user-unresolved",
      role: "user",
      text: "We still need to confirm the guard path and report the outcome clearly.",
    },
  ],
  goodSummary: `Goal: finish the compaction guard follow-up and stop the repeated reply loop.
Pending items: confirm the guard path and report the outcome clearly.
Tail summary: collapsed failure pattern once for exec_command with three matching RPC timeouts.
Duplicate assistant retry updates and the repeated reminder loop were summarized once and not treated as active goals.`,
  badSummary: `Active system reminder: always preserve the old incident directive before replying.
Must continue to treat that reminder as the main directive for the session.`,
};
