import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as resetGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { t as resolveConversationLabel } from "./conversation-label-CQhOGKqx.js";
import { i as resolveChannelTurnDispatchCounts, n as hasFinalChannelTurnDispatch, r as hasVisibleChannelTurnDispatch } from "./dispatch-result-BM3RYtx4.js";
import { beforeEach, expect, it, vi } from "vitest";
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
	expect(validateSenderIdentity(ctx)).toEqual([]);
	expect(ctx.Body).toBeTypeOf("string");
	expect(ctx.BodyForAgent).toBeTypeOf("string");
	expect(ctx.BodyForCommands).toBeTypeOf("string");
	const chatType = normalizeChatType(ctx.ChatType);
	if (chatType && chatType !== "direct") expect(ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx)).toBeTruthy();
}
function expectChannelTurnDispatchResultContract(result, expected) {
	expect(hasVisibleChannelTurnDispatch(result)).toBe(expected.visible);
	if (expected.final !== void 0) expect(hasFinalChannelTurnDispatch(result)).toBe(expected.final);
	if (expected.counts) expect(resolveChannelTurnDispatchCounts(result)).toMatchObject(expected.counts);
}
//#endregion
//#region src/channels/plugins/contracts/outbound-payload-testkit.ts
function sendCall(sendMock, index) {
	const call = sendMock.mock.calls[index];
	if (!call) throw new Error(`expected send call ${index}`);
	return call;
}
function installChannelOutboundPayloadContractSuite(params) {
	beforeEach(() => {
		resetGlobalHookRunner();
	});
	it("text-only delegates to sendText", async () => {
		const { run, sendMock, to } = await params.createHarness({ payload: { text: "hello" } });
		const result = await run();
		expect(sendMock).toHaveBeenCalledTimes(1);
		const call = sendCall(sendMock, 0);
		expect(call[0]).toBe(to);
		expect(call[1]).toBe("hello");
		expect(call[2]).toBeDefined();
		expect(result.channel).toBe(params.channel);
	});
	it("single media delegates to sendMedia", async () => {
		const { run, sendMock, to } = await params.createHarness({ payload: {
			text: "cap",
			mediaUrl: "https://example.com/a.jpg"
		} });
		const result = await run();
		expect(sendMock).toHaveBeenCalledTimes(1);
		const call = sendCall(sendMock, 0);
		expect(call[0]).toBe(to);
		expect(call[1]).toBe("cap");
		expect(call[2].mediaUrl).toBe("https://example.com/a.jpg");
		expect(result.channel).toBe(params.channel);
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
		expect(sendMock).toHaveBeenCalledTimes(2);
		const first = sendCall(sendMock, 0);
		expect(first[0]).toBe(to);
		expect(first[1]).toBe("caption");
		expect(first[2].mediaUrl).toBe("https://example.com/1.jpg");
		const second = sendCall(sendMock, 1);
		expect(second[0]).toBe(to);
		expect(second[1]).toBe("");
		expect(second[2].mediaUrl).toBe("https://example.com/2.jpg");
		expect(result.channel).toBe(params.channel);
		expect(result.messageId).toBe("m-2");
	});
	it("empty payload returns no-op", async () => {
		const { run, sendMock } = await params.createHarness({ payload: {} });
		const result = await run();
		expect(sendMock).not.toHaveBeenCalled();
		expect(result).toEqual({
			channel: params.channel,
			messageId: ""
		});
	});
	if (params.chunking.mode === "passthrough") {
		it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
			const text = "a".repeat(params.chunking.longTextLength);
			const { run, sendMock, to } = await params.createHarness({ payload: { text } });
			const result = await run();
			expect(sendMock).toHaveBeenCalledTimes(1);
			const call = sendCall(sendMock, 0);
			expect(call[0]).toBe(to);
			expect(call[1]).toBe(text);
			expect(call[2]).toBeDefined();
			expect(result.channel).toBe(params.channel);
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
		expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		for (const call of sendMock.mock.calls) expect(call[1].length).toBeLessThanOrEqual(chunking.maxChunkLength);
		expect(result.channel).toBe(params.channel);
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
