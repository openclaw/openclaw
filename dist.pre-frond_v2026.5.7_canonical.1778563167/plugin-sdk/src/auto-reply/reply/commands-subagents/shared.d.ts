import type { ResolvedSubagentController } from "../../../agents/subagent-control.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import { stripToolMessages } from "../../../agents/tools/sessions-helpers.js";
import { resolveCommandSurfaceChannel, resolveChannelAccountId } from "../channel-context.js";
import { type ChatMessage } from "../commands-subagents-text.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
export { stripToolMessages };
export { resolveCommandSurfaceChannel, resolveChannelAccountId };
export type { ChatMessage } from "../commands-subagents-text.js";
export declare const COMMAND = "/subagents";
export declare const COMMAND_KILL = "/kill";
export declare const RECENT_WINDOW_MINUTES = 30;
type SubagentsAction = "list" | "kill" | "log" | "send" | "steer" | "info" | "spawn" | "focus" | "unfocus" | "agents" | "help";
type SubagentsCommandParams = Parameters<CommandHandler>[0];
export type SubagentsCommandContext = {
    params: SubagentsCommandParams;
    handledPrefix: string;
    requesterKey: string;
    runs: SubagentRunRecord[];
    restTokens: string[];
};
export declare function stopWithText(text: string): CommandHandlerResult;
export declare function resolveSubagentEntryForToken(runs: SubagentRunRecord[], token: string | undefined): {
    entry: SubagentRunRecord;
} | {
    reply: CommandHandlerResult;
};
export declare function resolveRequesterSessionKey(params: SubagentsCommandParams, opts?: {
    preferCommandTarget?: boolean;
}): string | undefined;
export declare function resolveCommandSubagentController(params: SubagentsCommandParams, requesterKey: string): ResolvedSubagentController;
export declare function resolveHandledPrefix(normalized: string): string | null;
export declare function resolveSubagentsAction(params: {
    handledPrefix: string;
    restTokens: string[];
}): SubagentsAction | null;
type FocusTargetResolution = {
    targetKind: "subagent" | "acp";
    targetSessionKey: string;
    agentId: string;
    label?: string;
};
export declare function resolveFocusTargetSession(params: {
    runs: SubagentRunRecord[];
    token: string;
    requesterKey?: string;
}): Promise<FocusTargetResolution | null>;
export declare function buildSubagentsHelp(): string;
export declare function formatLogLines(messages: ChatMessage[]): string[];
