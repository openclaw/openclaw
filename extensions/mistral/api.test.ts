import { describe, expect, it } from "vitest";
import { applyMistralModelCompat } from "./api.js";

function supportsStore(model: { compat?: unknown }): boolean | undefined {
	return (model.compat as { supportsStore?: boolean } | undefined)
		?.supportsStore;
}

function supportsReasoningEffort(model: {
	compat?: unknown;
}): boolean | undefined {
	return (model.compat as { supportsReasoningEffort?: boolean } | undefined)
		?.supportsReasoningEffort;
}

function maxTokensField(model: {
	compat?: unknown;
}): "max_completion_tokens" | "max_tokens" | undefined {
	return (
		model.compat as
			| { maxTokensField?: "max_completion_tokens" | "max_tokens" }
			| undefined
	)?.maxTokensField;
}

describe("applyMistralModelCompat", () => {
	it("applies the Mistral request-shape compat flags", () => {
		const normalized = applyMistralModelCompat({});
		expect(supportsStore(normalized)).toBe(false);
		expect(supportsReasoningEffort(normalized)).toBe(false);
		expect(maxTokensField(normalized)).toBe("max_tokens");
	});

	it("overrides explicit compat values that would trigger 422s", () => {
		const normalized = applyMistralModelCompat({
			compat: {
				supportsStore: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_completion_tokens" as const,
			},
		});
		expect(supportsStore(normalized)).toBe(false);
		expect(supportsReasoningEffort(normalized)).toBe(false);
		expect(maxTokensField(normalized)).toBe("max_tokens");
	});

	it("returns the same object when the compat patch is already present", () => {
		const model = {
			compat: {
				supportsStore: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens" as const,
			},
		};
		expect(applyMistralModelCompat(model)).toBe(model);
	});
});
