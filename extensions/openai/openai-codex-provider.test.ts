import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
	refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai codex provider", () => {
	beforeEach(async () => {
		vi.resetModules();
		refreshOpenAICodexTokenMock.mockReset();
		({ buildOpenAICodexProviderPlugin } = await import(
			"./openai-codex-provider.js"
		));
	});

	it("falls back to the cached credential when accountId extraction fails", async () => {
		const provider = buildOpenAICodexProviderPlugin();
		const credential = {
			type: "oauth" as const,
			provider: "openai-codex",
			access: "cached-access-token",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
		};
		refreshOpenAICodexTokenMock.mockRejectedValueOnce(
			new Error("Failed to extract accountId from token"),
		);

		await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(
			credential,
		);
	});

	it("rethrows unrelated refresh failures", async () => {
		const provider = buildOpenAICodexProviderPlugin();
		const credential = {
			type: "oauth" as const,
			provider: "openai-codex",
			access: "cached-access-token",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
		};
		refreshOpenAICodexTokenMock.mockRejectedValueOnce(
			new Error("invalid_grant"),
		);

		await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(
			"invalid_grant",
		);
	});

	it("merges refreshed oauth credentials", async () => {
		const provider = buildOpenAICodexProviderPlugin();
		const credential = {
			type: "oauth" as const,
			provider: "openai-codex",
			access: "cached-access-token",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
			email: "user@example.com",
			displayName: "User",
		};
		refreshOpenAICodexTokenMock.mockResolvedValueOnce({
			access: "next-access",
			refresh: "next-refresh",
			expires: Date.now() + 60_000,
		});

		await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
			...credential,
			access: "next-access",
			refresh: "next-refresh",
			expires: expect.any(Number),
		});
	});

	it("returns deprecated-profile doctor guidance for legacy Codex CLI ids", () => {
		const provider = buildOpenAICodexProviderPlugin();

		expect(
			provider.buildAuthDoctorHint?.({
				provider: "openai-codex",
				profileId: "openai-codex:codex-cli",
				config: undefined,
				store: { version: 1, profiles: {} },
			}),
		).toBe(
			"Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.",
		);
	});
});
