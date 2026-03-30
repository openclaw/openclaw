import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider } from "../plugin-sdk/kimi-coding.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("Kimi implicit provider (#22409)", () => {
	it("should include Kimi when KIMI_API_KEY is configured", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KIMI_API_KEY"]);
		process.env.KIMI_API_KEY = "test-key"; // pragma: allowlist secret

		try {
			const providers = await resolveImplicitProvidersForTest({ agentDir });
			expect(providers?.kimi).toBeDefined();
			expect(providers?.kimi?.api).toBe("anthropic-messages");
			expect(providers?.kimi?.baseUrl).toBe("https://api.kimi.com/coding/");
		} finally {
			envSnapshot.restore();
		}
	});

	it("should build Kimi provider with anthropic-messages API", () => {
		const provider = buildKimiCodingProvider();
		expect(provider.api).toBe("anthropic-messages");
		expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
		expect(provider.headers).toEqual({ "User-Agent": "claude-code/0.1.0" });
		expect(provider.models).toBeDefined();
		expect(provider.models.length).toBeGreaterThan(0);
		expect(provider.models[0].id).toBe("kimi-code");
		expect(provider.models.some((model) => model.id === "k2p5")).toBe(true);
	});

	it("should not include Kimi when no API key is configured", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KIMI_API_KEY"]);
		delete process.env.KIMI_API_KEY;

		try {
			const providers = await resolveImplicitProvidersForTest({ agentDir });
			expect(providers?.kimi).toBeUndefined();
		} finally {
			envSnapshot.restore();
		}
	});

	it("uses explicit legacy kimi-coding baseUrl when provided", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KIMI_API_KEY"]);
		process.env.KIMI_API_KEY = "test-key";

		try {
			const providers = await resolveImplicitProvidersForTest({
				agentDir,
				explicitProviders: {
					"kimi-coding": {
						baseUrl: "https://kimi.example.test/coding/",
						api: "anthropic-messages",
						models: buildKimiCodingProvider().models,
					},
				},
			});
			expect(providers?.kimi?.baseUrl).toBe(
				"https://kimi.example.test/coding/",
			);
		} finally {
			envSnapshot.restore();
		}
	});

	it("merges explicit legacy kimi-coding headers on top of the built-in user agent", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KIMI_API_KEY"]);
		process.env.KIMI_API_KEY = "test-key";

		try {
			const providers = await resolveImplicitProvidersForTest({
				agentDir,
				explicitProviders: {
					"kimi-coding": {
						baseUrl: "https://api.kimi.com/coding/",
						api: "anthropic-messages",
						headers: {
							"User-Agent": "custom-kimi-client/1.0",
							"X-Kimi-Tenant": "tenant-a",
						},
						models: buildKimiCodingProvider().models,
					},
				},
			});
			expect(providers?.kimi?.headers).toEqual({
				"User-Agent": "custom-kimi-client/1.0",
				"X-Kimi-Tenant": "tenant-a",
			});
		} finally {
			envSnapshot.restore();
		}
	});
});
