import { type Mock } from "vitest";
import type { ReplyPayload } from "../../../plugin-sdk/reply-payload.js";
type PayloadLike = Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "text">;
type SendResultLike = {
    messageId: string;
    [key: string]: unknown;
};
type ChunkingMode = {
    longTextLength: number;
    maxChunkLength: number;
    mode: "split";
} | {
    longTextLength: number;
    mode: "passthrough";
};
type OutboundPayloadHarness = {
    run: () => Promise<Record<string, unknown>>;
    sendMock: Mock;
    to: string;
};
export type OutboundPayloadHarnessParams = {
    payload: PayloadLike;
    sendResults?: SendResultLike[];
};
export declare function installChannelOutboundPayloadContractSuite(params: {
    channel: string;
    chunking: ChunkingMode;
    createHarness: (params: OutboundPayloadHarnessParams) => OutboundPayloadHarness | Promise<OutboundPayloadHarness>;
}): void;
export {};
