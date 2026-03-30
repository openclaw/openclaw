import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";

describe("isSlackInteractiveRepliesEnabled", () => {
	it("uses the configured default account when accountId is unknown and multiple accounts exist", () => {
		const cfg = {
			channels: {
				slack: {
					defaultAccount: "one",
					accounts: {
						one: {
							capabilities: { interactiveReplies: true },
						},
						two: {},
					},
				},
			},
		} as OpenClawConfig;

		expect(
			isSlackInteractiveRepliesEnabled({ cfg, accountId: undefined }),
		).toBe(true);
	});

	it("uses the only configured account when accountId is unknown", () => {
		const cfg = {
			channels: {
				slack: {
					accounts: {
						only: {
							capabilities: { interactiveReplies: true },
						},
					},
				},
			},
		} as OpenClawConfig;

		expect(
			isSlackInteractiveRepliesEnabled({ cfg, accountId: undefined }),
		).toBe(true);
	});
});
