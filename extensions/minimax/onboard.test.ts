import {
	resolveAgentModelFallbackValues,
	resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
	createConfigWithFallbacks,
	createLegacyProviderConfig,
	EXPECTED_FALLBACKS,
} from "../../test/helpers/plugins/onboard-config.js";
import {
	applyMinimaxApiConfig,
	applyMinimaxApiProviderConfig,
} from "./onboard.js";

describe("minimax onboard", () => {
	it("adds minimax provider with correct settings", () => {
		const cfg = applyMinimaxApiConfig({});
		expect(cfg.models?.providers?.minimax).toMatchObject({
			baseUrl: "https://api.minimax.io/anthropic",
			api: "anthropic-messages",
			authHeader: true,
		});
	});

	it("keeps reasoning enabled for MiniMax-M2.7", () => {
		const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7");
		expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(true);
	});

	it("preserves existing model params when adding alias", () => {
		const cfg = applyMinimaxApiConfig(
			{
				agents: {
					defaults: {
						models: {
							"minimax/MiniMax-M2.7": {
								alias: "MiniMax",
								params: { custom: "value" },
							},
						},
					},
				},
			},
			"MiniMax-M2.7",
		);
		expect(
			cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.7"],
		).toMatchObject({
			alias: "Minimax",
			params: { custom: "value" },
		});
	});

	it("merges existing minimax provider models", () => {
		const cfg = applyMinimaxApiConfig(
			createLegacyProviderConfig({
				providerId: "minimax",
				api: "openai-completions",
			}),
		);
		expect(cfg.models?.providers?.minimax?.baseUrl).toBe(
			"https://api.minimax.io/anthropic",
		);
		expect(cfg.models?.providers?.minimax?.api).toBe("anthropic-messages");
		expect(cfg.models?.providers?.minimax?.authHeader).toBe(true);
		expect(cfg.models?.providers?.minimax?.apiKey).toBe("old-key");
		expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
			"old-model",
			"MiniMax-M2.7",
		]);
	});

	it("preserves other providers when adding minimax", () => {
		const cfg = applyMinimaxApiConfig({
			models: {
				providers: {
					anthropic: {
						baseUrl: "https://api.anthropic.com",
						apiKey: "anthropic-key",
						api: "anthropic-messages",
						models: [
							{
								id: "claude-opus-4-5",
								name: "Claude Opus 4.5",
								reasoning: false,
								input: ["text"],
								cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				},
			},
		});
		expect(cfg.models?.providers?.anthropic).toBeDefined();
		expect(cfg.models?.providers?.minimax).toBeDefined();
	});

	it("preserves existing models mode", () => {
		const cfg = applyMinimaxApiConfig({
			models: { mode: "replace", providers: {} },
		});
		expect(cfg.models?.mode).toBe("replace");
	});

	it("does not overwrite existing primary model in provider-only mode", () => {
		const cfg = applyMinimaxApiProviderConfig({
			agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
		});
		expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
			"anthropic/claude-opus-4-5",
		);
	});

	it("sets the chosen model as primary in config mode", () => {
		const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7-highspeed");
		expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
			"minimax/MiniMax-M2.7-highspeed",
		);
	});

	it("preserves existing model fallbacks", () => {
		const cfg = applyMinimaxApiConfig(createConfigWithFallbacks());
		expect(
			resolveAgentModelFallbackValues(cfg.agents?.defaults?.model),
		).toEqual([...EXPECTED_FALLBACKS]);
	});
});
