import type { MsgContext } from "../auto-reply/templating.js";
import type { MediaAttachment } from "./types.js";
export declare function normalizeAttachmentPath(raw?: string | null): string | undefined;
export declare function normalizeAttachments(ctx: MsgContext): MediaAttachment[];
export declare function resolveAttachmentKind(attachment: MediaAttachment): "image" | "audio" | "video" | "document" | "unknown";
export declare function isVideoAttachment(attachment: MediaAttachment): boolean;
export declare function isAudioAttachment(attachment: MediaAttachment): boolean;
export declare function isImageAttachment(attachment: MediaAttachment): boolean;
