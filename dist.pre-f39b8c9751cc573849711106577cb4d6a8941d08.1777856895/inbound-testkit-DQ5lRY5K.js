import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { a as resetGlobalHookRunner } from "./hook-runner-global-j8teApmQ.js";
import { t as normalizeChatType } from "./chat-type-O5o90NDg.js";
import { t as resolveConversationLabel } from "./conversation-label-BsK-ecM6.js";
import { i as resolveChannelTurnDispatchCounts, n as hasFinalChannelTurnDispatch, r as hasVisibleChannelTurnDispatch } from "./dispatch-result-PLkbMtLB.js";
import { c as it, i as beforeEach } from "./dist-BosyQhji.js";
import { n as vi, t as globalExpect } from "./test.DNmyFkvJ-C-ie2OOa.js";
//#region src/channels/sender-identity.ts
function validateSenderIdentity(ctx) {
	const issues = [];
	const isDirect = normalizeChatType(ctx.ChatType) === "direct";
	const senderId = normalizeOptionalString(ctx.SenderId) || "";
	const senderName = normalizeOptionalString(ctx.SenderName) || "";
	const senderUsername = normalizeOptionalString(ctx.SenderUsername) || "";
	const senderE164 = normalizeOptionalString(ctx.SenderE164) || "";
	if (!isDirect) {
		if (!senderId && !senderName && !senderUsername && !senderE164) issues.push("missing sender identity (SenderId/SenderName/SenderUsername/SenderE164)");
	}
	if (senderE164) {
		if (!/^\+\d{3,}$/.test(senderE164)) issues.push(`invalid SenderE164: ${senderE164}`);
	}
	if (senderUsername) {
		if (senderUsername.includes("@")) issues.push(`SenderUsername should not include "@": ${senderUsername}`);
		if (/\s/.test(senderUsername)) issues.push(`SenderUsername should not include whitespace: ${senderUsername}`);
	}
	if (ctx.SenderId != null && !senderId) issues.push("SenderId is set but empty");
	return issues;
}
//#endregion
//#region src/channels/plugins/contracts/test-helpers.ts
function primeChannelOutboundSendMock(sendMock, fallbackResult, sendResults = []) {
	sendMock.mockReset();
	if (sendResults.length === 0) {
		sendMock.mockResolvedValue(fallbackResult);
		return;
	}
	for (const result of sendResults) sendMock.mockResolvedValueOnce(result);
}
function expectChannelInboundContextContract(ctx) {
	globalExpect(validateSenderIdentity(ctx)).toEqual([]);
	globalExpect(ctx.Body).toBeTypeOf("string");
	globalExpect(ctx.BodyForAgent).toBeTypeOf("string");
	globalExpect(ctx.BodyForCommands).toBeTypeOf("string");
	const chatType = normalizeChatType(ctx.ChatType);
	if (chatType && chatType !== "direct") globalExpect(ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx)).toBeTruthy();
}
function expectChannelTurnDispatchResultContract(result, expected) {
	globalExpect(hasVisibleChannelTurnDispatch(result)).toBe(expected.visible);
	if (expected.final !== void 0) globalExpect(hasFinalChannelTurnDispatch(result)).toBe(expected.final);
	if (expected.counts) globalExpect(resolveChannelTurnDispatchCounts(result)).toMatchObject(expected.counts);
}
//#endregion
//#region src/channels/plugins/contracts/outbound-payload-testkit.ts
function installChannelOutboundPayloadContractSuite(params) {
	beforeEach(() => {
		resetGlobalHookRunner();
	});
	it("text-only delegates to sendText", async () => {
		const { run, sendMock, to } = await params.createHarness({ payload: { text: "hello" } });
		const result = await run();
		globalExpect(sendMock).toHaveBeenCalledTimes(1);
		globalExpect(sendMock).toHaveBeenCalledWith(to, "hello", globalExpect.any(Object));
		globalExpect(result).toMatchObject({ channel: params.channel });
	});
	it("single media delegates to sendMedia", async () => {
		const { run, sendMock, to } = await params.createHarness({ payload: {
			text: "cap",
			mediaUrl: "https://example.com/a.jpg"
		} });
		const result = await run();
		globalExpect(sendMock).toHaveBeenCalledTimes(1);
		globalExpect(sendMock).toHaveBeenCalledWith(to, "cap", globalExpect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }));
		globalExpect(result).toMatchObject({ channel: params.channel });
	});
	it("multi-media iterates URLs with caption on first", async () => {
		const { run, sendMock, to } = await params.createHarness({
			payload: {
				text: "caption",
				mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"]
			},
			sendResults: [{ messageId: "m-1" }, { messageId: "m-2" }]
		});
		const result = await run();
		globalExpect(sendMock).toHaveBeenCalledTimes(2);
		globalExpect(sendMock).toHaveBeenNthCalledWith(1, to, "caption", globalExpect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }));
		globalExpect(sendMock).toHaveBeenNthCalledWith(2, to, "", globalExpect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }));
		globalExpect(result).toMatchObject({
			channel: params.channel,
			messageId: "m-2"
		});
	});
	it("empty payload returns no-op", async () => {
		const { run, sendMock } = await params.createHarness({ payload: {} });
		const result = await run();
		globalExpect(sendMock).not.toHaveBeenCalled();
		globalExpect(result).toEqual({
			channel: params.channel,
			messageId: ""
		});
	});
	if (params.chunking.mode === "passthrough") {
		it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
			const text = "a".repeat(params.chunking.longTextLength);
			const { run, sendMock, to } = await params.createHarness({ payload: { text } });
			const result = await run();
			globalExpect(sendMock).toHaveBeenCalledTimes(1);
			globalExpect(sendMock).toHaveBeenCalledWith(to, text, globalExpect.any(Object));
			globalExpect(result).toMatchObject({ channel: params.channel });
		});
		return;
	}
	const chunking = params.chunking;
	it("chunking splits long text", async () => {
		const text = "a".repeat(chunking.longTextLength);
		const { run, sendMock } = await params.createHarness({
			payload: { text },
			sendResults: [{ messageId: "c-1" }, { messageId: "c-2" }]
		});
		const result = await run();
		globalExpect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		for (const call of sendMock.mock.calls) globalExpect(call[1].length).toBeLessThanOrEqual(chunking.maxChunkLength);
		globalExpect(result).toMatchObject({ channel: params.channel });
	});
}
//#endregion
//#region src/channels/plugins/contracts/inbound-testkit.ts
function buildDispatchInboundCaptureMock(actual, setCtx) {
	const dispatchInboundMessage = vi.fn(async (params) => {
		setCtx(params.ctx);
		return {
			queuedFinal: false,
			counts: {
				tool: 0,
				block: 0,
				final: 0
			}
		};
	});
	return {
		...actual,
		dispatchInboundMessage,
		dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
		dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage
	};
}
//#endregion
export { primeChannelOutboundSendMock as a, expectChannelTurnDispatchResultContract as i, installChannelOutboundPayloadContractSuite as n, expectChannelInboundContextContract as r, buildDispatchInboundCaptureMock as t };
