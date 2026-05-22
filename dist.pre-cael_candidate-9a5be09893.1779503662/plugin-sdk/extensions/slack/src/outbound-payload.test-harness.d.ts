import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { type Mock } from "vitest";
type OutboundSendMock = Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
type SlackOutboundPayloadHarness = {
    run: () => Promise<Record<string, unknown>>;
    sendMock: OutboundSendMock;
    to: string;
};
export declare function createSlackOutboundPayloadHarness(params: {
    payload: ReplyPayload;
    sendResults?: Array<{
        messageId: string;
    }>;
}): SlackOutboundPayloadHarness;
export {};
