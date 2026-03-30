import { Button, type ButtonInteraction, type ComponentData } from "@buape/carbon";
import { ButtonStyle } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordExecApprovalConfig } from "../../config/types.discord.js";
import type { ExecApprovalDecision, ExecApprovalRequest, ExecApprovalResolved } from "../../infra/exec-approvals.js";
import type { RuntimeEnv } from "../../runtime.js";
export type { ExecApprovalRequest, ExecApprovalResolved };
/** Extract Discord channel ID from a session key like "agent:main:discord:channel:123456789" */
export declare function extractDiscordChannelId(sessionKey?: string | null): string | null;
export declare function buildExecApprovalCustomId(approvalId: string, action: ExecApprovalDecision): string;
export declare function parseExecApprovalData(data: ComponentData): {
    approvalId: string;
    action: ExecApprovalDecision;
} | null;
export type DiscordExecApprovalHandlerOpts = {
    token: string;
    accountId: string;
    config: DiscordExecApprovalConfig;
    gatewayUrl?: string;
    cfg: OpenClawConfig;
    runtime?: RuntimeEnv;
    onResolve?: (id: string, decision: ExecApprovalDecision) => Promise<void>;
};
export declare class DiscordExecApprovalHandler {
    private gatewayClient;
    private pending;
    private requestCache;
    private opts;
    private started;
    constructor(opts: DiscordExecApprovalHandlerOpts);
    shouldHandle(request: ExecApprovalRequest): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleGatewayEvent;
    private handleApprovalRequested;
    private handleApprovalResolved;
    private handleApprovalTimeout;
    private finalizeMessage;
    private updateMessage;
    resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean>;
    /** Return the list of configured approver IDs. */
    getApprovers(): string[];
}
export type ExecApprovalButtonContext = {
    handler: DiscordExecApprovalHandler;
};
export declare class ExecApprovalButton extends Button {
    label: string;
    customId: string;
    style: ButtonStyle;
    private ctx;
    constructor(ctx: ExecApprovalButtonContext);
    run(interaction: ButtonInteraction, data: ComponentData): Promise<void>;
}
export declare function createExecApprovalButton(ctx: ExecApprovalButtonContext): Button;
