import { describe, expect, it, vi } from "vitest";
import { resolveCopilotApiToken } from "./github-copilot-token.js";

describe("resolveCopilotApiToken", () => {
	it("treats 11-digit expires_at values as seconds epochs", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				token: "copilot-token",
				expires_at: 12_345_678_901,
			}),
		}));

		const result = await resolveCopilotApiToken({
			githubToken: "github-token",
			cachePath: "/tmp/github-copilot-token-test.json",
			loadJsonFileImpl: () => undefined,
			saveJsonFileImpl: () => undefined,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result.expiresAt).toBe(12_345_678_901_000);
	});
});
