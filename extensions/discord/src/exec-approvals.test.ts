import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
	getDiscordExecApprovalApprovers,
	isDiscordExecApprovalApprover,
	isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

function buildConfig(
	execApprovals?: NonNullable<
		NonNullable<OpenClawConfig["channels"]>["discord"]
	>["execApprovals"],
	channelOverrides?: Partial<
		NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>
	>,
): OpenClawConfig {
	return {
		channels: {
			discord: {
				token: "discord-token",
				...channelOverrides,
				execApprovals,
			},
		},
	} as OpenClawConfig;
}

describe("discord exec approvals", () => {
	it("requires enablement and an explicit or inferred approver", () => {
		expect(isDiscordExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(
			false,
		);
		expect(
			isDiscordExecApprovalClientEnabled({
				cfg: buildConfig({ enabled: true }),
			}),
		).toBe(false);
		expect(
			isDiscordExecApprovalClientEnabled({
				cfg: buildConfig({ enabled: true }, { allowFrom: ["123"] }),
			}),
		).toBe(true);
	});

	it("prefers explicit approvers when configured", () => {
		const cfg = buildConfig(
			{ enabled: true, approvers: ["456"] },
			{ allowFrom: ["123"], defaultTo: "user:789" },
		);

		expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["456"]);
		expect(isDiscordExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
		expect(isDiscordExecApprovalApprover({ cfg, senderId: "123" })).toBe(false);
	});

	it("infers approvers from allowFrom, legacy dm.allowFrom, and explicit DM defaultTo", () => {
		const cfg = buildConfig(
			{ enabled: true },
			{
				allowFrom: ["123"],
				dm: { allowFrom: ["456"] },
				defaultTo: "user:789",
			},
		);

		expect(getDiscordExecApprovalApprovers({ cfg })).toEqual([
			"123",
			"456",
			"789",
		]);
		expect(isDiscordExecApprovalApprover({ cfg, senderId: "789" })).toBe(true);
	});

	it("ignores non-user default targets when inferring approvers", () => {
		const cfg = buildConfig(
			{ enabled: true },
			{
				defaultTo: "channel:123",
			},
		);

		expect(getDiscordExecApprovalApprovers({ cfg })).toEqual([]);
	});
});
