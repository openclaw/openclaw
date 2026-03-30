import { describe, expect, it } from "vitest";
import {
	isLiveProfileKeyModeEnabled,
	isLiveTestEnabled,
} from "./live-test-helpers.js";

describe("isLiveTestEnabled", () => {
	it("treats LIVE and OPENCLAW_LIVE_TEST as shared live gates", () => {
		expect(isLiveTestEnabled([], { LIVE: "1" })).toBe(true);
		expect(isLiveTestEnabled([], { OPENCLAW_LIVE_TEST: "1" })).toBe(true);
		expect(isLiveTestEnabled([], {})).toBe(false);
	});

	it("supports provider-specific live flags", () => {
		expect(
			isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "1" }),
		).toBe(true);
		expect(
			isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "0" }),
		).toBe(false);
	});
});

describe("isLiveProfileKeyModeEnabled", () => {
	it("only enables profile-key mode for the dedicated flag", () => {
		expect(
			isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS: "1" }),
		).toBe(true);
		expect(isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_TEST: "1" })).toBe(
			false,
		);
		expect(isLiveProfileKeyModeEnabled({ LIVE: "1" })).toBe(false);
	});
});
