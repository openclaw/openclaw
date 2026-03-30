import { describe, expect, it } from "vitest";
import {
	buildMinimaxApiModelDefinition,
	buildMinimaxModelDefinition,
	DEFAULT_MINIMAX_CONTEXT_WINDOW,
	DEFAULT_MINIMAX_MAX_TOKENS,
	MINIMAX_API_COST,
	MINIMAX_HOSTED_MODEL_ID,
} from "./model-definitions.js";

describe("minimax model definitions", () => {
	it("uses M2.7 as default hosted model", () => {
		expect(MINIMAX_HOSTED_MODEL_ID).toBe("MiniMax-M2.7");
	});

	it("uses the higher upstream MiniMax context and token defaults", () => {
		expect(DEFAULT_MINIMAX_CONTEXT_WINDOW).toBe(204800);
		expect(DEFAULT_MINIMAX_MAX_TOKENS).toBe(131072);
		expect(MINIMAX_API_COST).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
		});
	});

	it("builds catalog model with name and reasoning from catalog", () => {
		const model = buildMinimaxModelDefinition({
			id: "MiniMax-M2.7",
			cost: MINIMAX_API_COST,
			contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
		});
		expect(model).toMatchObject({
			id: "MiniMax-M2.7",
			name: "MiniMax M2.7",
			reasoning: true,
		});
	});

	it("builds API model definition with standard cost", () => {
		const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
		expect(model.cost).toEqual(MINIMAX_API_COST);
		expect(model.contextWindow).toBe(DEFAULT_MINIMAX_CONTEXT_WINDOW);
		expect(model.maxTokens).toBe(DEFAULT_MINIMAX_MAX_TOKENS);
	});

	it("falls back to generated name for unknown model id", () => {
		const model = buildMinimaxApiModelDefinition("MiniMax-Future");
		expect(model.name).toBe("MiniMax MiniMax-Future");
		expect(model.reasoning).toBe(false);
	});
});
