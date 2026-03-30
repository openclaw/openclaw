import { describe, expect, it, vi } from "vitest";
import {
	createPluginSetupWizardConfigure,
	createTestWizardPrompter,
	runSetupWizardConfigure,
	type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { zaloPlugin } from "./channel.js";

const zaloConfigure = createPluginSetupWizardConfigure(zaloPlugin);

describe("zalo setup wizard", () => {
	it("configures a polling token flow", async () => {
		const prompter = createTestWizardPrompter({
			select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
			text: vi.fn(async ({ message }: { message: string }) => {
				if (message === "Enter Zalo bot token") {
					return "12345689:abc-xyz";
				}
				throw new Error(`Unexpected prompt: ${message}`);
			}) as WizardPrompter["text"],
			confirm: vi.fn(async ({ message }: { message: string }) => {
				if (message === "Use webhook mode for Zalo?") {
					return false;
				}
				return false;
			}),
		});

		const result = await runSetupWizardConfigure({
			configure: zaloConfigure,
			cfg: {} as OpenClawConfig,
			prompter,
			options: { secretInputMode: "plaintext" as const },
		});

		expect(result.accountId).toBe("default");
		expect(result.cfg.channels?.zalo?.enabled).toBe(true);
		expect(result.cfg.channels?.zalo?.botToken).toBe("12345689:abc-xyz");
		expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
	});
});
