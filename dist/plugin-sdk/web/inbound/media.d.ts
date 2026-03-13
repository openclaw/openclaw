import type { proto } from "@whiskeysockets/baileys";
import type { createWaSocket } from "../session.js";
export declare function downloadInboundMedia(msg: proto.IWebMessageInfo, sock: Awaited<ReturnType<typeof createWaSocket>>): Promise<{
    buffer: Buffer;
    mimetype?: string;
    fileName?: string;
} | undefined>;
