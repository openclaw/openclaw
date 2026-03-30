import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildKilocodeProvider } from "../plugin-sdk/kilocode.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

const KILOCODE_MODEL_IDS = ["kilo/auto"];

describe("Kilo Gateway implicit provider", () => {
	it("should include kilocode when KILOCODE_API_KEY is configured", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
		process.env.KILOCODE_API_KEY = "test-key"; // pragma: allowlist secret

		try {
			const providers = await resolveImplicitProvidersForTest({ agentDir });
			expect(providers?.kilocode).toBeDefined();
			expect(providers?.kilocode?.models?.length).toBeGreaterThan(0);
		} finally {
			envSnapshot.restore();
		}
	});

	it("should not include kilocode when no API key is configured", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
		delete process.env.KILOCODE_API_KEY;

		try {
			const providers = await resolveImplicitProvidersForTest({ agentDir });
			expect(providers?.kilocode).toBeUndefined();
		} finally {
			envSnapshot.restore();
		}
	});

	it("should build kilocode provider with correct configuration", () => {
		const provider = buildKilocodeProvider();
		expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway/");
		expect(provider.api).toBe("openai-completions");
		expect(provider.models).toBeDefined();
		expect(provider.models.length).toBeGreaterThan(0);
	});

	it("should include the default kilocode model", () => {
		const provider = buildKilocodeProvider();
		const modelIds = provider.models.map((m) => m.id);
		expect(modelIds).toContain("kilo/auto");
	});

	it("should include the static fallback catalog", () => {
		const provider = buildKilocodeProvider();
		const modelIds = provider.models.map((m) => m.id);
		for (const modelId of KILOCODE_MODEL_IDS) {
			expect(modelIds).toContain(modelId);
		}
		expect(provider.models).toHaveLength(KILOCODE_MODEL_IDS.length);
	});
});
