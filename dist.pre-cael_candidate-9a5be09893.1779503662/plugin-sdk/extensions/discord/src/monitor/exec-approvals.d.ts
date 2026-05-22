import { ButtonStyle } from "discord-api-types/v10";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Button, type ButtonInteraction, type ComponentData } from "../internal/discord.js";
export { buildExecApprovalCustomId } from "../approval-handler.runtime.js";
export { extractDiscordChannelId } from "../approval-native.js";
export declare function parseExecApprovalData(data: ComponentData): {
    approvalId: string;
    action: ExecApprovalDecision;
} | null;
type ExecApprovalButtonContext = {
    getApprovers: () => string[];
    resolveApproval: (approvalId: string, decision: ExecApprovalDecision) => Promise<ExecApprovalResolveResult>;
};
type ExecApprovalResolveResult = {
    ok: true;
} | {
    ok: false;
    reason: "error" | "not-found";
};
export declare class ExecApprovalButton extends Button {
    private readonly ctx;
    label: string;
    customId: string;
    style: ButtonStyle;
    constructor(ctx: ExecApprovalButtonContext);
    run(interaction: ButtonInteraction, data: ComponentData): Promise<void>;
}
export declare function createExecApprovalButton(ctx: ExecApprovalButtonContext): Button;
export declare function createDiscordExecApprovalButtonContext(params: {
    cfg: OpenClawConfig;
    accountId: string;
    config: DiscordExecApprovalConfig;
    gatewayUrl?: string;
}): ExecApprovalButtonContext;
