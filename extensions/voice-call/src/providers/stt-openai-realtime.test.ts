import { describe, expect, it } from "vitest";
import type { RealtimeSTTConfig } from "./stt-openai-realtime.js";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";

type ProviderInternals = {
	vadThreshold: number;
	silenceDurationMs: number;
};

function readProviderInternals(config: RealtimeSTTConfig): ProviderInternals {
	const provider = new OpenAIRealtimeSTTProvider(config) as unknown as Record<
		string,
		unknown
	>;
	return {
		vadThreshold: provider.vadThreshold as number,
		silenceDurationMs: provider.silenceDurationMs as number,
	};
}

describe("OpenAIRealtimeSTTProvider constructor defaults", () => {
	it("uses vadThreshold: 0 when explicitly configured (max sensitivity)", () => {
		const provider = readProviderInternals({
			apiKey: "sk-test", // pragma: allowlist secret
			vadThreshold: 0,
		});
		expect(provider.vadThreshold).toBe(0);
	});

	it("uses silenceDurationMs: 0 when explicitly configured", () => {
		const provider = readProviderInternals({
			apiKey: "sk-test", // pragma: allowlist secret
			silenceDurationMs: 0,
		});
		expect(provider.silenceDurationMs).toBe(0);
	});

	it("falls back to defaults when values are undefined", () => {
		const provider = readProviderInternals({
			apiKey: "sk-test", // pragma: allowlist secret
		});
		expect(provider.vadThreshold).toBe(0.5);
		expect(provider.silenceDurationMs).toBe(800);
	});
});
