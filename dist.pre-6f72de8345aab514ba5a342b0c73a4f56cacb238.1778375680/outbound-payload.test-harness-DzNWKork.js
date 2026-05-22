import { n as vi } from "./test.DNmyFkvJ-BPd67fVG.js";
import { a as primeChannelOutboundSendMock } from "./inbound-testkit-C2R-_-j1.js";
import "./channel-contract-testing-DNcre_5n.js";
import { t as slackOutbound } from "./outbound-adapter-CYRqMSQr.js";
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
