import type { CommandFlagKey } from "../../config/commands.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
export declare function rejectUnauthorizedCommand(params: HandleCommandsParams, commandLabel: string): CommandHandlerResult | null;
export declare function buildDisabledCommandReply(params: {
    label: string;
    configKey: CommandFlagKey;
    disabledVerb?: "is" | "are";
    docsUrl?: string;
}): ReplyPayload;
export declare function requireCommandFlagEnabled(cfg: {
    commands?: unknown;
} | undefined, params: {
    label: string;
    configKey: CommandFlagKey;
    disabledVerb?: "is" | "are";
    docsUrl?: string;
}): CommandHandlerResult | null;
