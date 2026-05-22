import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import "./text-runtime-CFBwIeh_.js";
import { o as resolveAnthropicVertexRegion } from "./region-BumP4wJs.js";
//#region extensions/anthropic-vertex/provider-catalog.ts
const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1e6;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
function buildAnthropicVertexModel(params) {
	return {
		id: params.id,
		name: params.name,
		reasoning: params.reasoning,
		input: params.input,
		cost: params.cost,
		contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
		maxTokens: params.maxTokens
	};
}
function buildAnthropicVertexCatalog() {
	return [buildAnthropicVertexModel({
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 5,
			output: 25,
			cacheRead: .5,
			cacheWrite: 6.25
		},
		maxTokens: 128e3
	}), buildAnthropicVertexModel({
		id: ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
		name: "Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 3,
			output: 15,
			cacheRead: .3,
			cacheWrite: 3.75
		},
		maxTokens: 128e3
	})];
}
function buildAnthropicVertexProvider(params) {
	const region = resolveAnthropicVertexRegion(params?.env);
	return {
		baseUrl: normalizeLowercaseStringOrEmpty(region) === "global" ? "https://aiplatform.googleapis.com" : `https://${region}-aiplatform.googleapis.com`,
		api: "anthropic-messages",
		apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
		models: buildAnthropicVertexCatalog()
	};
}
//#endregion
export { buildAnthropicVertexProvider as n, ANTHROPIC_VERTEX_DEFAULT_MODEL_ID as t };
