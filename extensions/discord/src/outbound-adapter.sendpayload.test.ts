import { describe, vi } from "vitest";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../src/test-utils/send-payload-contract.js";
import { discordOutbound } from "./outbound-adapter.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  const sendDiscord = vi.fn();
  primeSendMock(sendDiscord, { messageId: "dc-1", channelId: "123456" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: params.payload,
    deps: {
      sendDiscord,
    },
  };
  return {
    run: async () => await discordOutbound.sendPayload!(ctx),
    sendMock: sendDiscord,
    to: ctx.to,
  };
}

describe("discordOutbound sendPayload", () => {
  installSendPayloadContractSuite({
    channel: "discord",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness,
  });
});
