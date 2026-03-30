import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";

describe("listSlackMessageActions", () => {
	it("includes file actions when message actions are enabled", () => {
		const cfg = {
			channels: {
				slack: {
					botToken: "xoxb-test",
					actions: {
						messages: true,
					},
				},
			},
		} as OpenClawConfig;

		expect(listSlackMessageActions(cfg)).toEqual(
			expect.arrayContaining([
				"read",
				"edit",
				"delete",
				"download-file",
				"upload-file",
			]),
		);
	});
});
