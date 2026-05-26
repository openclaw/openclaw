import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as CommandNormalizeOptions } from "./commands-registry.types-B-WfTzT-.js";

//#region src/auto-reply/command-detection.d.ts
declare function hasControlCommand(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
declare function isControlCommandMessage(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
declare function hasInlineCommandTokens(text?: string): boolean;
declare function shouldComputeCommandAuthorized(text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions): boolean;
//#endregion
export { shouldComputeCommandAuthorized as i, hasInlineCommandTokens as n, isControlCommandMessage as r, hasControlCommand as t };