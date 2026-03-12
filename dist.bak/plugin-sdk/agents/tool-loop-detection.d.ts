import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
export type LoopDetectorKind = "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
export type LoopDetectionResult = {
    stuck: false;
} | {
    stuck: true;
    level: "warning" | "critical";
    detector: LoopDetectorKind;
    count: number;
    message: string;
    pairedToolName?: string;
    warningKey?: string;
};
export declare const TOOL_CALL_HISTORY_SIZE = 30;
export declare const WARNING_THRESHOLD = 10;
export declare const CRITICAL_THRESHOLD = 20;
export declare const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;
/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON serialization digest of params.
 */
export declare function hashToolCall(toolName: string, params: unknown): string;
/**
 * Detect if an agent is stuck in a repetitive tool call loop.
 * Checks if the same tool+params combination has been called excessively.
 */
export declare function detectToolCallLoop(state: SessionState, toolName: string, params: unknown, config?: ToolLoopDetectionConfig): LoopDetectionResult;
/**
 * Record a tool call in the session's history for loop detection.
 * Maintains sliding window of last N calls.
 */
export declare function recordToolCall(state: SessionState, toolName: string, params: unknown, toolCallId?: string, config?: ToolLoopDetectionConfig): void;
/**
 * Record a completed tool call outcome so loop detection can identify no-progress repeats.
 */
export declare function recordToolCallOutcome(state: SessionState, params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
    config?: ToolLoopDetectionConfig;
}): void;
/**
 * Get current tool call statistics for a session (for debugging/monitoring).
 */
export declare function getToolCallStats(state: SessionState): {
    totalCalls: number;
    uniquePatterns: number;
    mostFrequent: {
        toolName: string;
        count: number;
    } | null;
};
