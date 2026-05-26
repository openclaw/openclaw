import * as fsPromises from "node:fs/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginAttachmentChannelHints, PluginSessionAttachmentCaptionFormat, PluginSessionAttachmentParams, PluginSessionAttachmentResult } from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export declare const attachmentProbeFs: {
    open: (...args: Parameters<typeof fsPromises.open>) => Promise<fsPromises.FileHandle>;
};
type ResolvedAttachmentDelivery = {
    parseMode?: "HTML";
    escapePlainHtmlCaption?: boolean;
    disableNotification?: boolean;
    forceDocumentMime?: string;
    threadTs?: string;
};
export declare function resolveAttachmentDelivery(params: {
    channel: string;
    captionFormat?: PluginSessionAttachmentCaptionFormat;
    channelHints?: PluginAttachmentChannelHints;
}): ResolvedAttachmentDelivery;
export declare function resolveSessionAttachmentThreadId(params: {
    deliveryThreadId?: unknown;
    explicitThreadId?: unknown;
    fallbackThreadId?: unknown;
    hintThreadTs?: string;
}): string | number | undefined;
export declare function sendPluginSessionAttachment(params: PluginSessionAttachmentParams & {
    config?: OpenClawConfig;
    origin?: PluginOrigin;
}): Promise<PluginSessionAttachmentResult>;
export {};
