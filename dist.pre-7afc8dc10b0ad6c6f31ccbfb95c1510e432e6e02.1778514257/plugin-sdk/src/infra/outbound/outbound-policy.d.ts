import type { ChannelId, ChannelMessageActionName, ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessagePresentation } from "../../interactive/payload.js";
export type CrossContextPresentationBuilder = (message: string) => MessagePresentation;
export type CrossContextDecoration = {
    prefix: string;
    suffix: string;
    presentationBuilder?: CrossContextPresentationBuilder;
};
export declare function enforceCrossContextPolicy(params: {
    channel: ChannelId;
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
    toolContext?: ChannelThreadingToolContext;
    cfg: OpenClawConfig;
}): void;
export declare function buildCrossContextDecoration(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    target: string;
    toolContext?: ChannelThreadingToolContext;
    accountId?: string | null;
}): Promise<CrossContextDecoration | null>;
export declare function shouldApplyCrossContextMarker(action: ChannelMessageActionName): boolean;
export declare function applyCrossContextDecoration(params: {
    message: string;
    decoration: CrossContextDecoration;
    preferPresentation: boolean;
}): {
    message: string;
    presentation?: MessagePresentation;
    usedPresentation: boolean;
};
