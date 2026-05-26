import type { SkillCommandSpec } from "../agents/skills/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";
export declare function listChatCommands(params?: {
    skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[];
export declare function isCommandEnabled(cfg: OpenClawConfig, commandKey: string): boolean;
export declare function listChatCommandsForConfig(cfg: OpenClawConfig, params?: {
    skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[];
