import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
	MINIMAX_OAUTH_MARKER,
	NON_ENV_SECRETREF_MARKER,
} from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

describe("models-config provider auth provenance", () => {
	it("persists env keyRef and tokenRef auth profiles as env var markers", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv([
			"VOLCANO_ENGINE_API_KEY",
			"TOGETHER_API_KEY",
		]);
		delete process.env.VOLCANO_ENGINE_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		await writeFile(
			join(agentDir, "auth-profiles.json"),
			JSON.stringify(
				{
					version: 1,
					profiles: {
						"volcengine:default": {
							type: "api_key",
							provider: "volcengine",
							keyRef: {
								source: "env",
								provider: "default",
								id: "VOLCANO_ENGINE_API_KEY",
							},
						},
						"together:default": {
							type: "token",
							provider: "together",
							tokenRef: {
								source: "env",
								provider: "default",
								id: "TOGETHER_API_KEY",
							},
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		try {
			const providers = await resolveImplicitProvidersForTest({
				agentDir,
				env: {},
			});
			expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
			expect(providers?.["volcengine-plan"]?.apiKey).toBe(
				"VOLCANO_ENGINE_API_KEY",
			);
			expect(providers?.together?.apiKey).toBe("TOGETHER_API_KEY");
		} finally {
			envSnapshot.restore();
		}
	});

	it("uses non-env marker for ref-managed profiles even when runtime plaintext is present", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		await writeFile(
			join(agentDir, "auth-profiles.json"),
			JSON.stringify(
				{
					version: 1,
					profiles: {
						"byteplus:default": {
							type: "api_key",
							provider: "byteplus",
							key: "sk-runtime-resolved-byteplus",
							keyRef: {
								source: "file",
								provider: "vault",
								id: "/byteplus/apiKey",
							},
						},
						"together:default": {
							type: "token",
							provider: "together",
							token: "tok-runtime-resolved-together",
							tokenRef: {
								source: "exec",
								provider: "vault",
								id: "providers/together/token",
							},
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		const providers = await resolveImplicitProvidersForTest({
			agentDir,
			env: {},
		});
		expect(providers?.byteplus?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
		expect(providers?.["byteplus-plan"]?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
		expect(providers?.together?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
	});

	it("keeps oauth compatibility markers for minimax-portal", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		await writeFile(
			join(agentDir, "auth-profiles.json"),
			JSON.stringify(
				{
					version: 1,
					profiles: {
						"minimax-portal:default": {
							type: "oauth",
							provider: "minimax-portal",
							access: "access-token",
							refresh: "refresh-token",
							expires: Date.now() + 60_000,
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		const providers = await resolveImplicitProvidersForTest({
			agentDir,
			env: {},
		});
		expect(providers?.["minimax-portal"]?.apiKey).toBe(MINIMAX_OAUTH_MARKER);
	});

	it("prefers profile auth over env auth in provider summaries to match runtime resolution", async () => {
		const auth = createProviderAuthResolver(
			{
				OPENAI_API_KEY: "env-openai-key",
			} as NodeJS.ProcessEnv,
			{
				version: 1,
				profiles: {
					"openai:default": {
						type: "api_key",
						provider: "openai",
						keyRef: {
							source: "env",
							provider: "default",
							id: "OPENAI_PROFILE_KEY",
						},
					},
				},
			},
		);

		expect(auth("openai")).toEqual({
			apiKey: "OPENAI_PROFILE_KEY",
			discoveryApiKey: undefined,
			mode: "api_key",
			source: "profile",
			profileId: "openai:default",
		});
	});
});
