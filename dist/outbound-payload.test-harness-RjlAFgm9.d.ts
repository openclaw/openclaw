import { r as ReplyPayload } from "./reply-payload-DjPL5qa-.js";
import { Mock } from "vitest";

//#region extensions/slack/src/outbound-payload.test-harness.d.ts
type OutboundSendMock = Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
type SlackOutboundPayloadHarness = {
  run: () => Promise<Record<string, unknown>>;
  sendMock: OutboundSendMock;
  to: string;
};
declare function createSlackOutboundPayloadHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{
    messageId: string;
  }>;
}): SlackOutboundPayloadHarness;
//#endregion
export { createSlackOutboundPayloadHarness as t };