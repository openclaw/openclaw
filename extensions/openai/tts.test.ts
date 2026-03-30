import { describe, expect, it } from "vitest";
import {
	isValidOpenAIModel,
	isValidOpenAIVoice,
	OPENAI_TTS_MODELS,
	OPENAI_TTS_VOICES,
	resolveOpenAITtsInstructions,
} from "./tts.js";

describe("openai tts", () => {
	describe("isValidOpenAIVoice", () => {
		it("accepts all valid OpenAI voices including newer additions", () => {
			for (const voice of OPENAI_TTS_VOICES) {
				expect(isValidOpenAIVoice(voice)).toBe(true);
			}
			for (const newerVoice of [
				"ballad",
				"cedar",
				"juniper",
				"marin",
				"verse",
			]) {
				expect(isValidOpenAIVoice(newerVoice), newerVoice).toBe(true);
			}
		});

		it("rejects invalid voice names", () => {
			expect(isValidOpenAIVoice("invalid")).toBe(false);
			expect(isValidOpenAIVoice("")).toBe(false);
			expect(isValidOpenAIVoice("ALLOY")).toBe(false);
			expect(isValidOpenAIVoice("alloy ")).toBe(false);
			expect(isValidOpenAIVoice(" alloy")).toBe(false);
		});

		it("treats the default endpoint with trailing slash as the default endpoint", () => {
			expect(
				isValidOpenAIVoice("kokoro-custom-voice", "https://api.openai.com/v1/"),
			).toBe(false);
		});
	});

	describe("isValidOpenAIModel", () => {
		it("matches the supported model set and rejects unsupported values", () => {
			expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
			expect(OPENAI_TTS_MODELS).toContain("tts-1");
			expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
			expect(OPENAI_TTS_MODELS).toHaveLength(3);
			expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
			expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
			const cases = [
				{ model: "gpt-4o-mini-tts", expected: true },
				{ model: "tts-1", expected: true },
				{ model: "tts-1-hd", expected: true },
				{ model: "invalid", expected: false },
				{ model: "", expected: false },
				{ model: "gpt-4", expected: false },
			] as const;
			for (const testCase of cases) {
				expect(isValidOpenAIModel(testCase.model), testCase.model).toBe(
					testCase.expected,
				);
			}
		});

		it("treats the default endpoint with trailing slash as the default endpoint", () => {
			expect(
				isValidOpenAIModel("kokoro-custom-model", "https://api.openai.com/v1/"),
			).toBe(false);
		});
	});

	describe("resolveOpenAITtsInstructions", () => {
		it("keeps instructions only for gpt-4o-mini-tts variants", () => {
			expect(
				resolveOpenAITtsInstructions("gpt-4o-mini-tts", " Speak warmly "),
			).toBe("Speak warmly");
			expect(
				resolveOpenAITtsInstructions(
					"gpt-4o-mini-tts-2025-12-15",
					"Speak warmly",
				),
			).toBe("Speak warmly");
			expect(
				resolveOpenAITtsInstructions("tts-1", "Speak warmly"),
			).toBeUndefined();
			expect(
				resolveOpenAITtsInstructions("tts-1-hd", "Speak warmly"),
			).toBeUndefined();
			expect(
				resolveOpenAITtsInstructions("gpt-4o-mini-tts", "   "),
			).toBeUndefined();
		});
	});
});
