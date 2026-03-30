import { describe, expect, it } from "vitest";
import {
	resolveDiscordAccount,
	resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

describe("resolveDiscordAccount allowFrom precedence", () => {
	it("prefers accounts.default.allowFrom over top-level for default account", () => {
		const resolved = resolveDiscordAccount({
			cfg: {
				channels: {
					discord: {
						allowFrom: ["top"],
						accounts: {
							default: { allowFrom: ["default"], token: "token-default" },
						},
					},
				},
			},
			accountId: "default",
		});

		expect(resolved.config.allowFrom).toEqual(["default"]);
	});

	it("falls back to top-level allowFrom for named account without override", () => {
		const resolved = resolveDiscordAccount({
			cfg: {
				channels: {
					discord: {
						allowFrom: ["top"],
						accounts: {
							work: { token: "token-work" },
						},
					},
				},
			},
			accountId: "work",
		});

		expect(resolved.config.allowFrom).toEqual(["top"]);
	});

	it("does not inherit default account allowFrom for named account when top-level is absent", () => {
		const resolved = resolveDiscordAccount({
			cfg: {
				channels: {
					discord: {
						accounts: {
							default: { allowFrom: ["default"], token: "token-default" },
							work: { token: "token-work" },
						},
					},
				},
			},
			accountId: "work",
		});

		expect(resolved.config.allowFrom).toBeUndefined();
	});
});

describe("resolveDiscordMaxLinesPerMessage", () => {
	it("falls back to merged root discord maxLinesPerMessage when runtime config omits it", () => {
		const resolved = resolveDiscordMaxLinesPerMessage({
			cfg: {
				channels: {
					discord: {
						maxLinesPerMessage: 120,
						accounts: {
							default: { token: "token-default" },
						},
					},
				},
			},
			discordConfig: {},
			accountId: "default",
		});

		expect(resolved).toBe(120);
	});

	it("prefers explicit runtime discord maxLinesPerMessage over merged config", () => {
		const resolved = resolveDiscordMaxLinesPerMessage({
			cfg: {
				channels: {
					discord: {
						maxLinesPerMessage: 120,
						accounts: {
							default: { token: "token-default", maxLinesPerMessage: 80 },
						},
					},
				},
			},
			discordConfig: { maxLinesPerMessage: 55 },
			accountId: "default",
		});

		expect(resolved).toBe(55);
	});

	it("uses per-account discord maxLinesPerMessage over the root value when runtime config omits it", () => {
		const resolved = resolveDiscordMaxLinesPerMessage({
			cfg: {
				channels: {
					discord: {
						maxLinesPerMessage: 120,
						accounts: {
							work: { token: "token-work", maxLinesPerMessage: 80 },
						},
					},
				},
			},
			discordConfig: {},
			accountId: "work",
		});

		expect(resolved).toBe(80);
	});
});
