import {
	resolveAgentModelFallbackValues,
	resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
	createConfigWithFallbacks,
	EXPECTED_FALLBACKS,
} from "../../test/helpers/plugins/onboard-config.js";
import {
	applyOpencodeGoConfig,
	applyOpencodeGoProviderConfig,
} from "./onboard.js";

const MODEL_REF = "opencode-go/kimi-k2.5";

describe("opencode-go onboard", () => {
	it("adds allowlist entry and preserves alias", () => {
		const withDefault = applyOpencodeGoProviderConfig({});
		expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(
			MODEL_REF,
		);

		const withAlias = applyOpencodeGoProviderConfig({
			agents: {
				defaults: {
					models: {
						[MODEL_REF]: { alias: "Kimi" },
					},
				},
			},
		});
		expect(withAlias.agents?.defaults?.models?.[MODEL_REF]?.alias).toBe("Kimi");
	});

	it("sets primary model and preserves existing model fallbacks", () => {
		const cfg = applyOpencodeGoConfig({});
		expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
			MODEL_REF,
		);

		const cfgWithFallbacks = applyOpencodeGoConfig(createConfigWithFallbacks());
		expect(
			resolveAgentModelFallbackValues(cfgWithFallbacks.agents?.defaults?.model),
		).toEqual([...EXPECTED_FALLBACKS]);
	});
});
