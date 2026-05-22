import { expect } from "vitest";
//#region extensions/xai/test-helpers.ts
function createXaiToolStreamPayload() {
	return {
		reasoning: { effort: "high" },
		tools: [{
			type: "function",
			function: {
				name: "write",
				parameters: {
					type: "object",
					properties: {}
				},
				strict: true
			}
		}]
	};
}
function createXaiPayloadCaptureStream() {
	let capturedModelId = "";
	let capturedPayload;
	const streamFn = (model, _context, options) => {
		capturedModelId = model.id;
		const payload = createXaiToolStreamPayload();
		options?.onPayload?.(payload, model);
		capturedPayload = payload;
		return {
			result: async () => ({}),
			async *[Symbol.asyncIterator]() {}
		};
	};
	return {
		streamFn,
		getCapturedModelId: () => capturedModelId,
		getCapturedPayload: () => capturedPayload
	};
}
function runXaiGrok4ResponseStream(streamFn) {
	streamFn?.({
		api: "openai-responses",
		provider: "xai",
		id: "grok-4"
	}, { messages: [] }, {});
}
function expectXaiFastToolStreamShaping(capture) {
	const capturedPayload = capture.getCapturedPayload();
	expect(capture.getCapturedModelId()).toBe("grok-4-fast");
	expect(capturedPayload).toMatchObject({ tool_stream: true });
	expect(capturedPayload).not.toHaveProperty("reasoning");
	const payloadTools = capturedPayload?.tools;
	expect(payloadTools?.[0]?.function).not.toHaveProperty("strict");
}
//#endregion
export { createXaiPayloadCaptureStream, expectXaiFastToolStreamShaping, runXaiGrok4ResponseStream };
