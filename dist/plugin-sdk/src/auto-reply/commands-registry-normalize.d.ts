import type { OpenClawConfig } from "../config/types.js";
import type { ChatCommandDefinition, CommandDetection, CommandNormalizeOptions } from "./commands-registry.types.js";
export declare function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string;
export declare function getCommandDetection(_cfg?: OpenClawConfig): CommandDetection;
export declare function maybeResolveTextAlias(raw: string, cfg?: OpenClawConfig): string | null;
export declare function resolveTextCommand(raw: string, cfg?: OpenClawConfig): {
    command: ChatCommandDefinition;
    args?: string;
} | null;
