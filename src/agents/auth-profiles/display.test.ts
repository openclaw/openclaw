import { describe, expect, it } from "vitest";
import { resolveAuthProfileDisplayLabel } from "./display.js";

describe("resolveAuthProfileDisplayLabel", () => {
	it("prefers displayName over email metadata", () => {
		const label = resolveAuthProfileDisplayLabel({
			cfg: {
				auth: {
					profiles: {
						"openai-codex:id-abc": {
							provider: "openai-codex",
							mode: "oauth",
							displayName: "Work account",
							email: "work@example.com",
						},
					},
				},
			},
			store: { version: 1, profiles: {} },
			profileId: "openai-codex:id-abc",
		});

		expect(label).toBe("openai-codex:id-abc (Work account)");
	});

	it("does not synthesize bogus labels when no human metadata exists", () => {
		const label = resolveAuthProfileDisplayLabel({
			store: {
				version: 1,
				profiles: {
					"openai-codex:id-abc": {
						type: "oauth",
						provider: "openai-codex",
						access: "token",
						refresh: "refresh-token",
						expires: Date.now() + 60_000,
					},
				},
			},
			profileId: "openai-codex:id-abc",
		});

		expect(label).toBe("openai-codex:id-abc");
	});
});
