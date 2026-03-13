export type AgentInternalEventType = "task_completion";
export type AgentTaskCompletionInternalEvent = {
    type: "task_completion";
    source: "subagent" | "cron";
    childSessionKey: string;
    childSessionId?: string;
    announceType: string;
    taskLabel: string;
    status: "ok" | "timeout" | "error" | "unknown";
    statusLabel: string;
    result: string;
    statsLine?: string;
    replyInstruction: string;
};
export type AgentInternalEvent = AgentTaskCompletionInternalEvent;
export declare function formatAgentInternalEventsForPrompt(events?: AgentInternalEvent[]): string;
