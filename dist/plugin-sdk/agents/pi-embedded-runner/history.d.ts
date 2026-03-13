import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 */
export declare function limitHistoryTurns(messages: AgentMessage[], limit: number | undefined): AgentMessage[];
/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 * For channel/group sessions, uses historyLimit from provider config.
 */
export declare function getHistoryLimitFromSessionKey(sessionKey: string | undefined, config: OpenClawConfig | undefined): number | undefined;
/**
 * @deprecated Use getHistoryLimitFromSessionKey instead.
 * Alias for backward compatibility.
 */
export declare const getDmHistoryLimitFromSessionKey: typeof getHistoryLimitFromSessionKey;
