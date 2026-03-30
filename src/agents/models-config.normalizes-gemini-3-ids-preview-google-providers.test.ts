import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
	installModelsConfigTestHooks,
	withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

function createGoogleModelsConfig(
	models: ModelDefinitionConfig[],
): OpenClawConfig {
	return {
		models: {
			providers: {
				google: {
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					apiKey: "GEMINI_KEY", // pragma: allowlist secret
					api: "google-generative-ai",
					models,
				},
			},
		},
	};
}

async function readGeneratedProvider(providerKey: string) {
	const parsed = await readGeneratedModelsJson<{
		providers: Record<
			string,
			{ baseUrl?: string; models: Array<{ id: string }> }
		>;
	}>();
	return parsed.providers[providerKey];
}

async function expectGeneratedProvider(
	providerKey: string,
	params: { ids: string[]; baseUrl?: string },
) {
	const provider = await readGeneratedProvider(providerKey);
	expect(provider?.models?.map((model) => model.id)).toEqual(params.ids);
	if (params.baseUrl !== undefined) {
		expect(provider?.baseUrl).toBe(params.baseUrl);
	}
}

describe("models-config", () => {
	installModelsConfigTestHooks();

	it("normalizes gemini 3 ids to preview for google providers", async () => {
		await withModelsTempHome(async () => {
			const cfg = createGoogleModelsConfig([
				{
					id: "gemini-3-pro",
					name: "Gemini 3 Pro",
					api: "google-generative-ai",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1048576,
					maxTokens: 65536,
				},
				{
					id: "gemini-3-flash",
					name: "Gemini 3 Flash",
					api: "google-generative-ai",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1048576,
					maxTokens: 65536,
				},
			]);

			await ensureOpenClawModelsJson(cfg);
			await expectGeneratedProvider("google", {
				ids: ["gemini-3-pro-preview", "gemini-3-flash-preview"],
			});
		});
	});

	it("normalizes the deprecated google flash preview id to the working preview id", async () => {
		await withModelsTempHome(async () => {
			const cfg = createGoogleModelsConfig([
				{
					id: "gemini-3.1-flash-preview",
					name: "Gemini 3.1 Flash Preview",
					api: "google-generative-ai",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1048576,
					maxTokens: 65536,
				},
			]);

			await ensureOpenClawModelsJson(cfg);
			await expectGeneratedProvider("google", {
				ids: ["gemini-3-flash-preview"],
			});
		});
	});

	it("normalizes custom Google Generative AI providers by api instead of provider name", async () => {
		await withModelsTempHome(async () => {
			const cfg = {
				models: {
					providers: {
						"google-paid": {
							baseUrl: "https://generativelanguage.googleapis.com",
							apiKey: "GEMINI_KEY", // pragma: allowlist secret
							api: "google-generative-ai",
							models: [
								{
									id: "gemini-3-pro",
									name: "Gemini 3 Pro",
									api: "google-generative-ai",
									reasoning: true,
									input: ["text", "image"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 1048576,
									maxTokens: 65536,
								},
							],
						},
					},
				},
			} satisfies OpenClawConfig;

			await ensureOpenClawModelsJson(cfg);
			await expectGeneratedProvider("google-paid", {
				ids: ["gemini-3-pro-preview"],
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			});
		});
	});

	it("keeps built-in google normalization when api is only defined on models", async () => {
		await withModelsTempHome(async () => {
			const cfg = {
				models: {
					providers: {
						google: {
							baseUrl: "https://generativelanguage.googleapis.com",
							apiKey: "GEMINI_KEY", // pragma: allowlist secret
							models: [
								{
									id: "gemini-3-flash",
									name: "Gemini 3 Flash",
									api: "google-generative-ai",
									reasoning: false,
									input: ["text", "image"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 1048576,
									maxTokens: 65536,
								},
							],
						},
					},
				},
			} satisfies OpenClawConfig;

			await ensureOpenClawModelsJson(cfg);
			await expectGeneratedProvider("google", {
				ids: ["gemini-3-flash-preview"],
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			});
		});
	});
});
