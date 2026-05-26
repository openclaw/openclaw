import { a as provider_auth_runtime_exports } from "../../provider-auth-runtime-COV17c31.js";
import { expect, vi } from "vitest";
//#region extensions/comfy/test-helpers.ts
function buildComfyConfig(config) {
	return { plugins: { entries: { comfy: { config } } } };
}
function buildLegacyComfyConfig(config) {
	return { models: { providers: { comfy: config } } };
}
function parseComfyJsonBody(fetchWithSsrFGuardMock, call) {
	const body = (fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0])?.init?.body;
	expect(body).toBeTruthy();
	if (typeof body !== "string") throw new Error(`Missing Comfy request body for fetch call ${call}`);
	return JSON.parse(body);
}
function mockComfyProviderApiKey(apiKey = "comfy-test-key") {
	return vi.spyOn(provider_auth_runtime_exports, "resolveApiKeyForProvider").mockResolvedValue({
		apiKey,
		source: "env",
		mode: "api-key"
	});
}
function mockComfyCloudJobResponses(fetchWithSsrFGuardMock, options) {
	fetchWithSsrFGuardMock.mockResolvedValueOnce(fetchGuardJson({ prompt_id: options.promptId })).mockResolvedValueOnce(fetchGuardJson({ status: "completed" })).mockResolvedValueOnce(fetchGuardJson({ [options.promptId]: { outputs: { "9": { [options.outputKind]: [{
		filename: options.filename,
		subfolder: "",
		type: "output"
	}] } } } })).mockResolvedValueOnce(fetchGuardResponse(new Response(null, {
		status: 302,
		headers: { location: options.redirectLocation }
	}))).mockResolvedValueOnce(fetchGuardResponse(new Response(options.body, {
		status: 200,
		headers: { "content-type": options.contentType }
	})));
}
function fetchGuardJson(body) {
	return fetchGuardResponse(new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" }
	}));
}
function fetchGuardResponse(response) {
	return {
		response,
		release: vi.fn(async () => {})
	};
}
//#endregion
export { buildComfyConfig, buildLegacyComfyConfig, mockComfyCloudJobResponses, mockComfyProviderApiKey, parseComfyJsonBody };
