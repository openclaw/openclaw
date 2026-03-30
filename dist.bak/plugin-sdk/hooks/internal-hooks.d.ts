/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";
export type AgentBootstrapHookContext = {
    workspaceDir: string;
    bootstrapFiles: WorkspaceBootstrapFile[];
    cfg?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
};
export type AgentBootstrapHookEvent = InternalHookEvent & {
    type: "agent";
    action: "bootstrap";
    context: AgentBootstrapHookContext;
};
export type GatewayStartupHookContext = {
    cfg?: OpenClawConfig;
    deps?: CliDeps;
    workspaceDir?: string;
};
export type GatewayStartupHookEvent = InternalHookEvent & {
    type: "gateway";
    action: "startup";
    context: GatewayStartupHookContext;
};
export type MessageReceivedHookContext = {
    /** Sender identifier (e.g., phone number, user ID) */
    from: string;
    /** Message content */
    content: string;
    /** Unix timestamp when the message was received */
    timestamp?: number;
    /** Channel identifier (e.g., "telegram", "whatsapp") */
    channelId: string;
    /** Provider account ID for multi-account setups */
    accountId?: string;
    /** Conversation/chat ID */
    conversationId?: string;
    /** Message ID from the provider */
    messageId?: string;
    /** Additional provider-specific metadata */
    metadata?: Record<string, unknown>;
};
export type MessageReceivedHookEvent = InternalHookEvent & {
    type: "message";
    action: "received";
    context: MessageReceivedHookContext;
};
export type MessageSentHookContext = {
    /** Recipient identifier */
    to: string;
    /** Message content */
    content: string;
    /** Whether the message was sent successfully */
    success: boolean;
    /** Error message if sending failed */
    error?: string;
    /** Channel identifier (e.g., "telegram", "whatsapp") */
    channelId: string;
    /** Provider account ID for multi-account setups */
    accountId?: string;
    /** Conversation/chat ID */
    conversationId?: string;
    /** Message ID returned by the provider */
    messageId?: string;
};
export type MessageSentHookEvent = InternalHookEvent & {
    type: "message";
    action: "sent";
    context: MessageSentHookContext;
};
export interface InternalHookEvent {
    /** The type of event (command, session, agent, gateway, etc.) */
    type: InternalHookEventType;
    /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
    action: string;
    /** The session key this event relates to */
    sessionKey: string;
    /** Additional context specific to the event */
    context: Record<string, unknown>;
    /** Timestamp when the event occurred */
    timestamp: Date;
    /** Messages to send back to the user (hooks can push to this array) */
    messages: string[];
}
export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;
/**
 * Register a hook handler for a specific event type or event:action combination
 *
 * @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
 * @param handler - Function to call when the event is triggered
 *
 * @example
 * ```ts
 * // Listen to all command events
 * registerInternalHook('command', async (event) => {
 *   console.log('Command:', event.action);
 * });
 *
 * // Listen only to /new commands
 * registerInternalHook('command:new', async (event) => {
 *   await saveSessionToMemory(event);
 * });
 * ```
 */
export declare function registerInternalHook(eventKey: string, handler: InternalHookHandler): void;
/**
 * Unregister a specific hook handler
 *
 * @param eventKey - Event key the handler was registered for
 * @param handler - The handler function to remove
 */
export declare function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void;
/**
 * Clear all registered hooks (useful for testing)
 */
export declare function clearInternalHooks(): void;
/**
 * Get all registered event keys (useful for debugging)
 */
export declare function getRegisteredEventKeys(): string[];
/**
 * Trigger a hook event
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * @param event - The event to trigger
 */
export declare function triggerInternalHook(event: InternalHookEvent): Promise<void>;
/**
 * Create a hook event with common fields filled in
 *
 * @param type - The event type
 * @param action - The action within that type
 * @param sessionKey - The session key
 * @param context - Additional context
 */
export declare function createInternalHookEvent(type: InternalHookEventType, action: string, sessionKey: string, context?: Record<string, unknown>): InternalHookEvent;
export declare function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent;
export declare function isGatewayStartupEvent(event: InternalHookEvent): event is GatewayStartupHookEvent;
export declare function isMessageReceivedEvent(event: InternalHookEvent): event is MessageReceivedHookEvent;
export declare function isMessageSentEvent(event: InternalHookEvent): event is MessageSentHookEvent;
