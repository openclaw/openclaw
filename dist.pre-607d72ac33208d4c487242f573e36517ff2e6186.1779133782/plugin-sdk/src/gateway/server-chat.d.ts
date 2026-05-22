import { type AgentEventPayload } from "../infra/agent-events.js";
import type { ChatRunState, SessionEventSubscriberRegistry, ToolEventRecipientRegistry } from "./server-chat-state.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
export { createChatRunRegistry, createChatRunState, createSessionEventSubscriberRegistry, createSessionMessageSubscriberRegistry, createToolEventRecipientRegistry, } from "./server-chat-state.js";
export type { ChatRunEntry, ChatRunRegistry, ChatRunState, SessionEventSubscriberRegistry, SessionMessageSubscriberRegistry, ToolEventRecipientRegistry, } from "./server-chat-state.js";
export type ChatEventBroadcast = (event: string, payload: unknown, opts?: {
    dropIfSlow?: boolean;
}) => void;
export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;
export type AgentEventHandlerOptions = {
    broadcast: ChatEventBroadcast;
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>, opts?: {
        dropIfSlow?: boolean;
    }) => void;
    nodeSendToSession: NodeSendToSession;
    agentRunSeq: Map<string, number>;
    chatRunState: ChatRunState;
    resolveSessionKeyForRun: (runId: string) => string | undefined;
    clearAgentRunContext: (runId: string) => void;
    toolEventRecipients: ToolEventRecipientRegistry;
    sessionEventSubscribers: SessionEventSubscriberRegistry;
    loadGatewaySessionRowForSnapshot?: typeof loadGatewaySessionRow;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
};
export declare function createAgentEventHandler({ broadcast, broadcastToConnIds, nodeSendToSession, agentRunSeq, chatRunState, resolveSessionKeyForRun, clearAgentRunContext, toolEventRecipients, sessionEventSubscribers, loadGatewaySessionRowForSnapshot, lifecycleErrorRetryGraceMs, isChatSendRunActive, }: AgentEventHandlerOptions): (evt: AgentEventPayload) => void;
