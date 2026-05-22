import type { AgentMessage } from "@earendil-works/pi-agent-core";
export type AgentAttemptLifecycleState = {
    currentTurnUserMessagePersisted: boolean;
    lifecycleFinishing: boolean;
    lifecycleEnded: boolean;
};
export type AgentAttemptLifecycleEvent = {
    stream: string;
    data?: Record<string, unknown>;
    sessionKey?: string;
};
export declare function createAgentAttemptLifecycleCallbacks(state: AgentAttemptLifecycleState): {
    onUserMessagePersisted: (message: Extract<AgentMessage, {
        role: "user";
    }>) => void;
    onAgentEvent: (evt: AgentAttemptLifecycleEvent) => void;
};
