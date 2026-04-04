import { describe, expect, it } from "vitest";
import {
	classifyOpenAiModelSwitch,
	findChatModelByStableOrCatalogId,
	isLikelyOpenAiModelId,
	needsOpenAiSwitchAcknowledgement,
	normalizeDenchModelId,
	resolveActiveChatModelId,
} from "./chat-models";

describe("chat-models", () => {
	it("finds catalog entries by stableId or catalogId", () => {
		const models = [
			{
				stableId: "claude-sonnet-4.6",
				catalogId: "dench-claude-sonnet",
				displayName: "Claude Sonnet 4.6",
				provider: "anthropic",
				reasoning: true,
			},
		];
		expect(findChatModelByStableOrCatalogId(models, "claude-sonnet-4.6")).toEqual(
			models[0],
		);
		expect(findChatModelByStableOrCatalogId(models, "dench-claude-sonnet")).toEqual(
			models[0],
		);
		expect(findChatModelByStableOrCatalogId(models, "unknown")).toBeUndefined();
	});

	it("normalizes dench-cloud model ids for picker state", () => {
		expect(normalizeDenchModelId("dench-cloud/gpt-5.4")).toBe("gpt-5.4");
		expect(normalizeDenchModelId("gpt-5.4")).toBe("gpt-5.4");
		expect(normalizeDenchModelId("")).toBeNull();
	});

	it("prefers configured primary over stale session metadata", () => {
		expect(
			resolveActiveChatModelId({
				modelOverride: null,
				sessionModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
				selectedDenchModel: "claude-sonnet-4.6",
				models: [
					{
						stableId: "anthropic.claude-opus-4-6-v1",
						displayName: "Claude Opus 4.6",
						provider: "anthropic",
						reasoning: true,
					},
					{
						stableId: "claude-sonnet-4.6",
						displayName: "Claude Sonnet 4.6",
						provider: "anthropic",
						reasoning: true,
					},
				],
			}),
		).toBe("claude-sonnet-4.6");
	});

	it("prefers configured primary when session model differs", () => {
		expect(
			resolveActiveChatModelId({
				modelOverride: null,
				sessionModel: "dench-cloud/gpt-5.4",
				selectedDenchModel: "anthropic.claude-opus-4-6-v1",
				models: [
					{
						stableId: "anthropic.claude-opus-4-6-v1",
						displayName: "Claude Opus 4.6",
						provider: "anthropic",
						reasoning: true,
					},
					{
						stableId: "gpt-5.4",
						displayName: "GPT-5.4",
						provider: "openai",
						reasoning: true,
					},
				],
			}),
		).toBe("anthropic.claude-opus-4-6-v1");
	});

	it("falls back to session model when no configured primary", () => {
		expect(
			resolveActiveChatModelId({
				modelOverride: null,
				sessionModel: "dench-cloud/gpt-5.4",
				selectedDenchModel: null,
				models: [
					{
						stableId: "gpt-5.4",
						displayName: "GPT-5.4",
						provider: "openai",
						reasoning: true,
					},
				],
			}),
		).toBe("gpt-5.4");
	});

	it("prefers model override over configured primary", () => {
		expect(
			resolveActiveChatModelId({
				modelOverride: "gpt-5.4",
				sessionModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
				selectedDenchModel: "anthropic.claude-opus-4-6-v1",
				models: [],
			}),
		).toBe("gpt-5.4");
	});

	it("detects likely OpenAI model ids", () => {
		expect(isLikelyOpenAiModelId("gpt-5.4")).toBe(true);
		expect(isLikelyOpenAiModelId("dench-cloud/openai.gpt-5.4")).toBe(true);
		expect(isLikelyOpenAiModelId("anthropic.claude-sonnet-4-6")).toBe(false);
	});

	it("classifies cross-provider switches into OpenAI", () => {
		expect(
			classifyOpenAiModelSwitch({
				sessionModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
				sessionModelProvider: "anthropic",
				targetModel: "gpt-5.4",
			}),
		).toBe("unsafe");

		expect(
			classifyOpenAiModelSwitch({
				sessionModel: "dench-cloud/gpt-5.4",
				sessionModelProvider: "openai",
				targetModel: "gpt-5.4",
			}),
		).toBe("safe");
	});

	it("classifies missing session model as unknown for OpenAI targets", () => {
		expect(
			classifyOpenAiModelSwitch({
				sessionModel: null,
				sessionModelProvider: null,
				targetModel: "gpt-5.4",
			}),
		).toBe("unknown");
	});

	it("requires acknowledgement for unsafe or unknown with assistant history", () => {
		expect(
			needsOpenAiSwitchAcknowledgement("unsafe", false),
		).toBe(true);
		expect(
			needsOpenAiSwitchAcknowledgement("unknown", true),
		).toBe(true);
		expect(
			needsOpenAiSwitchAcknowledgement("unknown", false),
		).toBe(false);
		expect(
			needsOpenAiSwitchAcknowledgement("safe", true),
		).toBe(false);
	});
});
