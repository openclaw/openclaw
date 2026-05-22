import { n as vi } from "./test.DNmyFkvJ-BSTQY5ec.js";
import { a as primeChannelOutboundSendMock } from "./inbound-testkit-HOTQ4xBE.js";
import "./channel-contract-testing-Bhq7CC0X.js";
import { t as slackOutbound } from "./outbound-adapter-CUA5DSKK.js";
//#region extensions/slack/src/outbound-payload.test-harness.ts
function createSlackOutboundPayloadHarness(params) {
	const sendSlack = vi.fn();
	primeChannelOutboundSendMock(sendSlack, {
		messageId: "sl-1",
		channelId: "C12345",
		ts: "1234.5678"
	}, params.sendResults);
	const ctx = {
		cfg: {},
		to: "C12345",
		text: "",
		payload: params.payload,
		deps: { sendSlack }
	};
	return {
		run: async () => await slackOutbound.sendPayload(ctx),
		sendMock: sendSlack,
		to: ctx.to
	};
}
//#endregion
export { createSlackOutboundPayloadHarness as t };
