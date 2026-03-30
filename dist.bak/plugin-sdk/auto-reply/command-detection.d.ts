import type { OpenClawConfig } from "../config/types.js";
import { type CommandNormalizeOptions } from "./commands-registry.js";
export declare function hasControlCommand(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
export declare function isControlCommandMessage(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export declare function hasInlineCommandTokens(text?: string): boolean;
export declare function shouldComputeCommandAuthorized(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
