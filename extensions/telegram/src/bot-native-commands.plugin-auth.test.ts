import type {
	OpenClawConfig,
	TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

let createNativeCommandsHarness: typeof import("./bot-native-commands.test-helpers.js").createNativeCommandsHarness;
let deliverReplies: typeof import("./bot-native-commands.test-helpers.js").deliverReplies;
let executePluginCommand: typeof import("./bot-native-commands.test-helpers.js").executePluginCommand;
let getPluginCommandSpecs: typeof import("./bot-native-commands.test-helpers.js").getPluginCommandSpecs;
let matchPluginCommand: typeof import("./bot-native-commands.test-helpers.js").matchPluginCommand;

let getPluginCommandSpecsMock: {
	mockReturnValue: (
		value: ReturnType<
			typeof import("../../../src/plugins/commands.js").getPluginCommandSpecs
		>,
	) => unknown;
};
let matchPluginCommandMock: {
	mockReturnValue: (
		value: ReturnType<
			typeof import("../../../src/plugins/commands.js").matchPluginCommand
		>,
	) => unknown;
};
let executePluginCommandMock: {
	mockResolvedValue: (
		value: Awaited<
			ReturnType<
				typeof import("../../../src/plugins/commands.js").executePluginCommand
			>
		>,
	) => unknown;
};

describe("registerTelegramNativeCommands (plugin auth)", () => {
	beforeEach(async () => {
		vi.resetModules();
		({
			createNativeCommandsHarness,
			deliverReplies,
			executePluginCommand,
			getPluginCommandSpecs,
			matchPluginCommand,
		} = await import("./bot-native-commands.test-helpers.js"));
		getPluginCommandSpecsMock =
			getPluginCommandSpecs as unknown as typeof getPluginCommandSpecsMock;
		matchPluginCommandMock =
			matchPluginCommand as unknown as typeof matchPluginCommandMock;
		executePluginCommandMock =
			executePluginCommand as unknown as typeof executePluginCommandMock;
		vi.clearAllMocks();
	});

	it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
		const specs = Array.from({ length: 101 }, (_, i) => ({
			name: `cmd_${i}`,
			description: `Command ${i}`,
			acceptsArgs: false,
		}));
		getPluginCommandSpecsMock.mockReturnValue(specs);

		const { handlers, setMyCommands, log } = createNativeCommandsHarness({
			cfg: {} as OpenClawConfig,
			telegramCfg: {} as TelegramAccountConfig,
			nativeEnabled: false,
		});

		expect(setMyCommands).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith(
			expect.stringContaining("registering first 100"),
		);
		expect(Object.keys(handlers)).toHaveLength(101);
	});

	it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
		const command = {
			name: "plugin",
			description: "Plugin command",
			pluginId: "test-plugin",
			requireAuth: false,
			handler: vi.fn(),
		} as const;

		getPluginCommandSpecsMock.mockReturnValue([
			{ name: "plugin", description: "Plugin command", acceptsArgs: false },
		]);
		matchPluginCommandMock.mockReturnValue({ command, args: undefined });
		executePluginCommandMock.mockResolvedValue({ text: "ok" });

		const { handlers, bot } = createNativeCommandsHarness({
			cfg: {} as OpenClawConfig,
			telegramCfg: {} as TelegramAccountConfig,
			allowFrom: ["999"],
			nativeEnabled: false,
		});

		const ctx = {
			message: {
				chat: { id: 123, type: "private" },
				from: { id: 111, username: "nope" },
				message_id: 10,
				date: 123456,
			},
			match: "",
		};

		await handlers.plugin?.(ctx);

		expect(matchPluginCommand).toHaveBeenCalled();
		expect(executePluginCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				isAuthorizedSender: false,
			}),
		);
		expect(deliverReplies).toHaveBeenCalledWith(
			expect.objectContaining({
				replies: [{ text: "ok" }],
			}),
		);
		expect(bot.api.sendMessage).not.toHaveBeenCalled();
	});
});
