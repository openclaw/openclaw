import { describe, expect, it } from "vitest";
import { listKnownProviderEnvApiKeyNames } from "./model-auth-env-vars.js";
import {
	GCP_VERTEX_CREDENTIALS_MARKER,
	isKnownEnvApiKeyMarker,
	isNonSecretApiKeyMarker,
	NON_ENV_SECRETREF_MARKER,
	resolveOAuthApiKeyMarker,
} from "./model-auth-markers.js";

describe("model auth markers", () => {
	it("recognizes explicit non-secret markers", () => {
		expect(isNonSecretApiKeyMarker(NON_ENV_SECRETREF_MARKER)).toBe(true);
		expect(isNonSecretApiKeyMarker(resolveOAuthApiKeyMarker("chutes"))).toBe(
			true,
		);
		expect(isNonSecretApiKeyMarker("ollama-local")).toBe(true);
		expect(isNonSecretApiKeyMarker(GCP_VERTEX_CREDENTIALS_MARKER)).toBe(true);
	});

	it("does not treat removed provider markers as active auth markers", () => {
		expect(isNonSecretApiKeyMarker("qwen-oauth")).toBe(false);
	});

	it("recognizes known env marker names but not arbitrary all-caps keys", () => {
		expect(isNonSecretApiKeyMarker("OPENAI_API_KEY")).toBe(true);
		expect(isNonSecretApiKeyMarker("ALLCAPS_EXAMPLE")).toBe(false);
	});

	it("recognizes all built-in provider env marker names", () => {
		for (const envVarName of listKnownProviderEnvApiKeyNames()) {
			expect(isNonSecretApiKeyMarker(envVarName)).toBe(true);
		}
	});

	it("can exclude env marker-name interpretation for display-only paths", () => {
		expect(
			isNonSecretApiKeyMarker("OPENAI_API_KEY", { includeEnvVarName: false }),
		).toBe(false);
	});

	it("excludes aws-sdk env markers from known api key env marker helper", () => {
		expect(isKnownEnvApiKeyMarker("OPENAI_API_KEY")).toBe(true);
		expect(isKnownEnvApiKeyMarker("AWS_PROFILE")).toBe(false);
	});
});
