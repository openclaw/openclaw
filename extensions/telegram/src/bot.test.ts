import { rm } from "node:fs/promises";
import type { PluginInteractiveTelegramHandlerContext } from "openclaw/plugin-sdk/core";
import {
	clearPluginInteractiveHandlers,
	registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { expectChannelInboundContextContract as expectInboundContextContract } from "openclaw/plugin-sdk/testing";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	escapeRegExp,
	formatEnvelopeTimestamp,
} from "../../../test/helpers/envelope-timestamp.js";

const {
	answerCallbackQuerySpy,
	commandSpy,
	editMessageReplyMarkupSpy,
	editMessageTextSpy,
	enqueueSystemEventSpy,
	getFileSpy,
	getChatSpy,
	getLoadConfigMock,
	getReadChannelAllowFromStoreMock,
	getOnHandler,
	listSkillCommandsForAgents,
	onSpy,
	replySpy,
	sendMessageSpy,
	setMyCommandsSpy,
	telegramBotDepsForTest,
	telegramBotRuntimeForTest,
	wasSentByBot,
} = await import("./bot.create-telegram-bot.test-harness.js");

let listNativeCommandSpecs: typeof import("../../../src/auto-reply/commands-registry.js").listNativeCommandSpecs;
let listNativeCommandSpecsForConfig: typeof import("../../../src/auto-reply/commands-registry.js").listNativeCommandSpecsForConfig;
let loadSessionStore: typeof import("../../../src/config/sessions.js").loadSessionStore;
let normalizeTelegramCommandName: typeof import("openclaw/plugin-sdk/config-runtime").normalizeTelegramCommandName;
let createTelegramBotBase: typeof import("./bot.js").createTelegramBot;
let setTelegramBotRuntimeForTest: typeof import("./bot.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
	opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();

function resolveSkillCommands(
	config: Parameters<typeof listNativeCommandSpecsForConfig>[0],
) {
	void config;
	return listSkillCommandsForAgents() as NonNullable<
		Parameters<typeof listNativeCommandSpecsForConfig>[1]
	>["skillCommands"];
}

const ORIGINAL_TZ = process.env.TZ;
describe("createTelegramBot", () => {
	beforeAll(async () => {
		({ listNativeCommandSpecs, listNativeCommandSpecsForConfig } = await import(
			"../../../src/auto-reply/commands-registry.js"
		));
		({ loadSessionStore } = await import("../../../src/config/sessions.js"));
		({ normalizeTelegramCommandName } = await import(
			"openclaw/plugin-sdk/config-runtime"
		));
		({
			createTelegramBot: createTelegramBotBase,
			setTelegramBotRuntimeForTest,
		} = await import("./bot.js"));
	});
	beforeAll(() => {
		process.env.TZ = "UTC";
	});
	afterAll(() => {
		process.env.TZ = ORIGINAL_TZ;
	});

	beforeEach(() => {
		setMyCommandsSpy.mockClear();
		clearPluginInteractiveHandlers();
		loadConfig.mockReturnValue({
			agents: {
				defaults: {
					envelopeTimezone: "utc",
				},
			},
			channels: {
				telegram: { dmPolicy: "open", allowFrom: ["*"] },
			},
		});
		setTelegramBotRuntimeForTest(
			telegramBotRuntimeForTest as unknown as Parameters<
				typeof setTelegramBotRuntimeForTest
			>[0],
		);
		createTelegramBot = (opts) =>
			createTelegramBotBase({
				...opts,
				telegramDeps: telegramBotDepsForTest,
			});
	});

	it("merges custom commands with native commands", async () => {
		const config = {
			channels: {
				telegram: {
					customCommands: [
						{ command: "custom_backup", description: "Git backup" },
						{ command: "/Custom_Generate", description: "Create an image" },
					],
				},
			},
		};
		loadConfig.mockReturnValue(config);

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "open",
						allowFrom: ["*"],
						execApprovals: {
							enabled: true,
							approvers: ["9"],
							target: "dm",
						},
					},
				},
			},
		});

		await vi.waitFor(() => {
			expect(setMyCommandsSpy).toHaveBeenCalled();
		});

		const registered = setMyCommandsSpy.mock.calls.at(-1)?.[0] as Array<{
			command: string;
			description: string;
		}>;
		const skillCommands = resolveSkillCommands(config);
		const native = listNativeCommandSpecsForConfig(config, {
			skillCommands,
		}).map((command) => ({
			command: normalizeTelegramCommandName(command.name),
			description: command.description,
		}));
		expect(registered.slice(0, native.length)).toEqual(native);
	});

	it("ignores custom commands that collide with native commands", async () => {
		const errorSpy = vi.fn();
		const config = {
			channels: {
				telegram: {
					customCommands: [
						{ command: "status", description: "Custom status" },
						{ command: "custom_backup", description: "Git backup" },
					],
				},
			},
		};
		loadConfig.mockReturnValue(config);

		createTelegramBot({
			token: "tok",
			runtime: {
				log: vi.fn(),
				error: errorSpy,
				exit: ((code: number) => {
					throw new Error(`exit ${code}`);
				}) as (code: number) => never,
			},
		});

		await vi.waitFor(() => {
			expect(setMyCommandsSpy).toHaveBeenCalled();
		});

		const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
			command: string;
			description: string;
		}>;
		const skillCommands = resolveSkillCommands(config);
		const native = listNativeCommandSpecsForConfig(config, {
			skillCommands,
		}).map((command) => ({
			command: normalizeTelegramCommandName(command.name),
			description: command.description,
		}));
		const nativeStatus = native.find((command) => command.command === "status");
		expect(nativeStatus).toBeDefined();
		expect(registered).toContainEqual({
			command: "custom_backup",
			description: "Git backup",
		});
		expect(registered).not.toContainEqual({
			command: "status",
			description: "Custom status",
		});
		expect(
			registered.filter((command) => command.command === "status"),
		).toEqual([nativeStatus]);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("registers custom commands when native commands are disabled", async () => {
		const config = {
			commands: { native: false },
			channels: {
				telegram: {
					customCommands: [
						{ command: "custom_backup", description: "Git backup" },
						{ command: "custom_generate", description: "Create an image" },
					],
				},
			},
		};
		loadConfig.mockReturnValue(config);

		createTelegramBot({ token: "tok" });

		await vi.waitFor(() => {
			expect(setMyCommandsSpy).toHaveBeenCalled();
		});

		const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
			command: string;
			description: string;
		}>;
		expect(registered).toEqual([
			{ command: "custom_backup", description: "Git backup" },
			{ command: "custom_generate", description: "Create an image" },
		]);
		const reserved = new Set(
			listNativeCommandSpecs().map((command) => command.name),
		);
		expect(registered.some((command) => reserved.has(command.command))).toBe(
			false,
		);
	});

	it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
		onSpy.mockClear();
		replySpy.mockClear();

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "pairing",
						capabilities: { inlineButtons: "allowlist" },
						allowFrom: [],
					},
				},
			},
		});
		const callbackHandler = getOnHandler("callback_query") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-2",
				data: "cmd:option_b",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 11,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).not.toHaveBeenCalled();
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
	});

	it("blocks DM model-selection callbacks for unpaired users when inline buttons are DM-scoped", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		editMessageTextSpy.mockClear();

		const storePath = `/tmp/openclaw-telegram-callback-authz-${process.pid}-${Date.now()}.json`;

		await rm(storePath, { force: true });
		try {
			const config = {
				agents: {
					defaults: {
						model: "anthropic/claude-opus-4-6",
						models: {
							"anthropic/claude-opus-4-6": {},
							"openai/gpt-5.4": {},
						},
					},
				},
				channels: {
					telegram: {
						dmPolicy: "pairing",
						capabilities: { inlineButtons: "dm" },
					},
				},
				session: {
					store: storePath,
				},
			} satisfies NonNullable<
				Parameters<typeof createTelegramBot>[0]["config"]
			>;

			loadConfig.mockReturnValue(config);
			readChannelAllowFromStore.mockResolvedValueOnce([]);

			createTelegramBot({
				token: "tok",
				config,
			});
			const callbackHandler = onSpy.mock.calls.find(
				(call) => call[0] === "callback_query",
			)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
			expect(callbackHandler).toBeDefined();

			await callbackHandler({
				callbackQuery: {
					id: "cbq-model-authz-bypass-1",
					data: "mdl_sel_openai/gpt-5.4",
					from: { id: 999, first_name: "Mallory", username: "mallory" },
					message: {
						chat: { id: 1234, type: "private" },
						date: 1736380800,
						message_id: 19,
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({ download: async () => new Uint8Array() }),
			});

			expect(replySpy).not.toHaveBeenCalled();
			expect(editMessageTextSpy).not.toHaveBeenCalled();
			expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
			expect(answerCallbackQuerySpy).toHaveBeenCalledWith(
				"cbq-model-authz-bypass-1",
			);
		} finally {
			await rm(storePath, { force: true });
		}
	});

	it("allows callback_query in groups when group policy authorizes the sender", async () => {
		onSpy.mockClear();
		editMessageTextSpy.mockClear();
		listSkillCommandsForAgents.mockClear();

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "open",
						capabilities: { inlineButtons: "allowlist" },
						allowFrom: [],
						groupPolicy: "open",
						groups: { "*": { requireMention: false } },
					},
				},
			},
		});
		const callbackHandler = getOnHandler("callback_query") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-group-1",
				data: "commands_page_2",
				from: { id: 42, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: -100999, type: "supergroup", title: "Test Group" },
					date: 1736380800,
					message_id: 20,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		// The callback should be processed (not silently blocked)
		expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
	});

	it("clears approval buttons without re-editing callback message text", async () => {
		onSpy.mockClear();
		editMessageReplyMarkupSpy.mockClear();
		editMessageTextSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
					execApprovals: {
						enabled: true,
						approvers: ["9"],
						target: "dm",
					},
				},
			},
		});
		createTelegramBot({ token: "tok" });
		const callbackHandler = getOnHandler("callback_query") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-approve-style",
				data: "/approve 138e9b8c allow-once",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 21,
					text: [
						"🧩 Yep-needs approval again.",
						"",
						"Run:",
						"/approve 138e9b8c allow-once",
						"",
						"Pending command:",
						"```shell",
						"npm view diver name version description",
						"```",
					].join("\n"),
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
		const [chatId, messageId, replyMarkup] =
			editMessageReplyMarkupSpy.mock.calls[0] ?? [];
		expect(chatId).toBe(1234);
		expect(messageId).toBe(21);
		expect(replyMarkup).toEqual({ reply_markup: { inline_keyboard: [] } });
		expect(editMessageTextSpy).not.toHaveBeenCalled();
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-style");
	});

	it("allows approval callbacks when exec approvals are enabled even without generic inlineButtons capability", async () => {
		onSpy.mockClear();
		editMessageReplyMarkupSpy.mockClear();
		editMessageTextSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
					capabilities: ["vision"],
					execApprovals: {
						enabled: true,
						approvers: ["9"],
						target: "dm",
					},
				},
			},
		});
		createTelegramBot({ token: "tok" });
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-approve-capability-free",
				data: "/approve 138e9b8c allow-once",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 23,
					text: "Approval required.",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith(
			"cbq-approve-capability-free",
		);
	});

	it("blocks approval callbacks from telegram users who are not exec approvers", async () => {
		onSpy.mockClear();
		editMessageReplyMarkupSpy.mockClear();
		editMessageTextSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
					execApprovals: {
						enabled: true,
						approvers: ["999"],
						target: "dm",
					},
				},
			},
		});
		createTelegramBot({ token: "tok" });
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-approve-blocked",
				data: "/approve 138e9b8c allow-once",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 22,
					text: "Run: /approve 138e9b8c allow-once",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
		expect(editMessageTextSpy).not.toHaveBeenCalled();
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-blocked");
	});

	it("keeps plugin approval callback buttons for target-only recipients", async () => {
		onSpy.mockClear();
		editMessageReplyMarkupSpy.mockClear();
		editMessageTextSpy.mockClear();

		loadConfig.mockReturnValue({
			approvals: {
				exec: {
					enabled: true,
					mode: "targets",
					targets: [{ channel: "telegram", to: "9" }],
				},
			},
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
					capabilities: ["vision"],
				},
			},
		});
		createTelegramBot({ token: "tok" });
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-plugin-approve-blocked",
				data: "/approve plugin:138e9b8c allow-once",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 24,
					text: "Plugin approval required.",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
		expect(editMessageTextSpy).not.toHaveBeenCalled();
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith(
			"cbq-plugin-approve-blocked",
		);
	});

	it("edits commands list for pagination callbacks", async () => {
		onSpy.mockClear();
		listSkillCommandsForAgents.mockClear();

		createTelegramBot({ token: "tok" });
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-3",
				data: "commands_page_2:main",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 12,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
			cfg: expect.any(Object),
			agentIds: ["main"],
		});
		expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
		const [chatId, messageId, text, params] =
			editMessageTextSpy.mock.calls[0] ?? [];
		expect(chatId).toBe(1234);
		expect(messageId).toBe(12);
		expect(String(text)).toContain("ℹ️ Commands");
		expect(params).toEqual(
			expect.objectContaining({
				reply_markup: expect.any(Object),
			}),
		);
	});

	it("falls back to default agent for pagination callbacks without agent suffix", async () => {
		onSpy.mockClear();
		listSkillCommandsForAgents.mockClear();

		createTelegramBot({ token: "tok" });
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-no-suffix",
				data: "commands_page_2",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 14,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
			cfg: expect.any(Object),
			agentIds: ["main"],
		});
		expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
	});

	it("blocks pagination callbacks when allowlist rejects sender", async () => {
		onSpy.mockClear();
		editMessageTextSpy.mockClear();

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "pairing",
						capabilities: { inlineButtons: "allowlist" },
						allowFrom: [],
					},
				},
			},
		});
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-4",
				data: "commands_page_2",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 13,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageTextSpy).not.toHaveBeenCalled();
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
	});

	it("routes compact model callbacks by inferring provider", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		editMessageTextSpy.mockClear();

		const modelId = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
		const storePath = `/tmp/openclaw-telegram-model-compact-${process.pid}-${Date.now()}.json`;
		const config = {
			agents: {
				defaults: {
					model: `bedrock/${modelId}`,
				},
			},
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
				},
			},
			session: {
				store: storePath,
			},
		} satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

		await rm(storePath, { force: true });
		try {
			loadConfig.mockReturnValue(config);
			createTelegramBot({
				token: "tok",
				config,
			});
			const callbackHandler = onSpy.mock.calls.find(
				(call) => call[0] === "callback_query",
			)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
			expect(callbackHandler).toBeDefined();

			await callbackHandler({
				callbackQuery: {
					id: "cbq-model-compact-1",
					data: `mdl_sel/${modelId}`,
					from: { id: 9, first_name: "Ada", username: "ada_bot" },
					message: {
						chat: { id: 1234, type: "private" },
						date: 1736380800,
						message_id: 14,
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({ download: async () => new Uint8Array() }),
			});

			expect(replySpy).not.toHaveBeenCalled();
			expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
			expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
				"✅ Model reset to default",
			);

			const entry = Object.values(
				loadSessionStore(storePath, { skipCache: true }),
			)[0];
			expect(entry?.providerOverride).toBeUndefined();
			expect(entry?.modelOverride).toBeUndefined();
			expect(answerCallbackQuerySpy).toHaveBeenCalledWith(
				"cbq-model-compact-1",
			);
		} finally {
			await rm(storePath, { force: true });
		}
	});

	it("resets overrides when selecting the configured default model", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		editMessageTextSpy.mockClear();

		const storePath = `/tmp/openclaw-telegram-model-default-${process.pid}-${Date.now()}.json`;

		await rm(storePath, { force: true });
		try {
			createTelegramBot({
				token: "tok",
				config: {
					agents: {
						defaults: {
							model: "claude-opus-4-6",
							models: {
								"anthropic/claude-opus-4-6": {},
							},
						},
					},
					channels: {
						telegram: {
							dmPolicy: "open",
							allowFrom: ["*"],
						},
					},
					session: {
						store: storePath,
					},
				},
			});
			const callbackHandler = onSpy.mock.calls.find(
				(call) => call[0] === "callback_query",
			)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
			expect(callbackHandler).toBeDefined();

			await callbackHandler({
				callbackQuery: {
					id: "cbq-model-default-1",
					data: "mdl_sel_anthropic/claude-opus-4-6",
					from: { id: 9, first_name: "Ada", username: "ada_bot" },
					message: {
						chat: { id: 1234, type: "private" },
						date: 1736380800,
						message_id: 16,
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({ download: async () => new Uint8Array() }),
			});

			expect(replySpy).not.toHaveBeenCalled();
			expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
			expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
				"✅ Model reset to default",
			);

			const entry = Object.values(
				loadSessionStore(storePath, { skipCache: true }),
			)[0];
			expect(entry?.providerOverride).toBeUndefined();
			expect(entry?.modelOverride).toBeUndefined();
			expect(answerCallbackQuerySpy).toHaveBeenCalledWith(
				"cbq-model-default-1",
			);
		} finally {
			await rm(storePath, { force: true });
		}
	});

	it("rejects ambiguous compact model callbacks and returns provider list", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		editMessageTextSpy.mockClear();

		createTelegramBot({
			token: "tok",
			config: {
				agents: {
					defaults: {
						model: "anthropic/shared-model",
						models: {
							"anthropic/shared-model": {},
							"openai/shared-model": {},
						},
					},
				},
				channels: {
					telegram: {
						dmPolicy: "open",
						allowFrom: ["*"],
					},
				},
			},
		});
		const callbackHandler = onSpy.mock.calls.find(
			(call) => call[0] === "callback_query",
		)?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
		expect(callbackHandler).toBeDefined();

		await callbackHandler({
			callbackQuery: {
				id: "cbq-model-compact-2",
				data: "mdl_sel/shared-model",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 15,
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).not.toHaveBeenCalled();
		expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
		expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
			'Could not resolve model "shared-model".',
		);
		expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
	});

	it("includes sender identity in group envelope headers", async () => {
		onSpy.mockClear();
		replySpy.mockClear();

		loadConfig.mockReturnValue({
			agents: {
				defaults: {
					envelopeTimezone: "utc",
				},
			},
			channels: {
				telegram: {
					groupPolicy: "open",
					groups: { "*": { requireMention: false } },
				},
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 42, type: "group", title: "Ops" },
				text: "hello",
				date: 1736380800,
				message_id: 2,
				from: {
					id: 99,
					first_name: "Ada",
					last_name: "Lovelace",
					username: "ada",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expectInboundContextContract(payload);
		const expectedTimestamp = formatEnvelopeTimestamp(
			new Date("2025-01-09T00:00:00Z"),
		);
		const timestampPattern = escapeRegExp(expectedTimestamp);
		expect(payload.Body).toMatch(
			new RegExp(
				`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`,
			),
		);
		expect(payload.SenderName).toBe("Ada Lovelace");
		expect(payload.SenderId).toBe("99");
		expect(payload.SenderUsername).toBe("ada");
	});

	it("uses quote text when a Telegram partial reply is received", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		replySpy.mockClear();

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 7, type: "private" },
				text: "Sure, see below",
				date: 1736380800,
				reply_to_message: {
					message_id: 9001,
					text: "Can you summarize this?",
					from: { first_name: "Ada" },
				},
				quote: {
					text: "summarize this",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.Body).toContain("[Quoting Ada id:9001]");
		expect(payload.Body).toContain('"summarize this"');
		expect(payload.ReplyToId).toBe("9001");
		expect(payload.ReplyToBody).toBe("summarize this");
		expect(payload.ReplyToSender).toBe("Ada");
	});

	it("includes replied image media in inbound context for text replies", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		getFileSpy.mockClear();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		try {
			createTelegramBot({ token: "tok" });
			const handler = getOnHandler("message") as (
				ctx: Record<string, unknown>,
			) => Promise<void>;

			await handler({
				message: {
					chat: { id: 7, type: "private" },
					text: "what is in this image?",
					date: 1736380800,
					reply_to_message: {
						message_id: 9001,
						photo: [{ file_id: "reply-photo-1" }],
						from: { first_name: "Ada" },
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({}),
			});

			expect(replySpy).toHaveBeenCalledTimes(1);
			const payload = replySpy.mock.calls[0][0] as {
				MediaPath?: string;
				MediaPaths?: string[];
				ReplyToBody?: string;
			};
			expect(payload.ReplyToBody).toBe("<media:image>");
			expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("does not fetch reply media for unauthorized DM replies", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		getFileSpy.mockClear();
		sendMessageSpy.mockClear();
		readChannelAllowFromStore.mockResolvedValue([]);
		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					dmPolicy: "pairing",
					allowFrom: [],
				},
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 7, type: "private" },
				text: "hey",
				date: 1736380800,
				from: { id: 999, first_name: "Eve" },
				reply_to_message: {
					message_id: 9001,
					photo: [{ file_id: "reply-photo-1" }],
					from: { first_name: "Ada" },
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({}),
		});

		expect(getFileSpy).not.toHaveBeenCalled();
		expect(replySpy).not.toHaveBeenCalled();
		expect(sendMessageSpy).toHaveBeenCalledTimes(1);
	});

	it("defers reply media download until debounce flush", async () => {
		const DEBOUNCE_MS = 4321;
		onSpy.mockClear();
		replySpy.mockClear();
		getFileSpy.mockClear();
		loadConfig.mockReturnValue({
			agents: {
				defaults: {
					envelopeTimezone: "utc",
				},
			},
			messages: {
				inbound: {
					debounceMs: DEBOUNCE_MS,
				},
			},
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
				},
			},
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			createTelegramBot({ token: "tok" });
			const handler = getOnHandler("message") as (
				ctx: Record<string, unknown>,
			) => Promise<void>;

			await handler({
				message: {
					chat: { id: 7, type: "private" },
					text: "first",
					date: 1736380800,
					message_id: 101,
					from: { id: 42, first_name: "Ada" },
					reply_to_message: {
						message_id: 9001,
						photo: [{ file_id: "reply-photo-1" }],
						from: { first_name: "Ada" },
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({}),
			});
			await handler({
				message: {
					chat: { id: 7, type: "private" },
					text: "second",
					date: 1736380801,
					message_id: 102,
					from: { id: 42, first_name: "Ada" },
					reply_to_message: {
						message_id: 9001,
						photo: [{ file_id: "reply-photo-1" }],
						from: { first_name: "Ada" },
					},
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({}),
			});

			expect(replySpy).not.toHaveBeenCalled();
			expect(getFileSpy).not.toHaveBeenCalled();

			const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
				(call) => call[1] === DEBOUNCE_MS,
			);
			const flushTimer =
				flushTimerCallIndex >= 0
					? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as
							| (() => unknown)
							| undefined)
					: undefined;
			if (flushTimerCallIndex >= 0) {
				clearTimeout(
					setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<
						typeof setTimeout
					>,
				);
			}
			expect(flushTimer).toBeTypeOf("function");
			await flushTimer?.();
			await vi.waitFor(() => {
				expect(replySpy).toHaveBeenCalledTimes(1);
			});

			expect(getFileSpy).toHaveBeenCalledTimes(1);
			expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
		} finally {
			setTimeoutSpy.mockRestore();
			fetchSpy.mockRestore();
		}
	});

	it("isolates inbound debounce by DM topic thread id", async () => {
		const DEBOUNCE_MS = 4321;
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			agents: {
				defaults: {
					envelopeTimezone: "utc",
				},
			},
			messages: {
				inbound: {
					debounceMs: DEBOUNCE_MS,
				},
			},
			channels: {
				telegram: {
					dmPolicy: "open",
					allowFrom: ["*"],
				},
			},
		});

		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			createTelegramBot({ token: "tok" });
			const handler = getOnHandler("message") as (
				ctx: Record<string, unknown>,
			) => Promise<void>;

			await handler({
				message: {
					chat: { id: 7, type: "private" },
					text: "topic-100",
					date: 1736380800,
					message_id: 201,
					message_thread_id: 100,
					from: { id: 42, first_name: "Ada" },
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({}),
			});
			await handler({
				message: {
					chat: { id: 7, type: "private" },
					text: "topic-200",
					date: 1736380801,
					message_id: 202,
					message_thread_id: 200,
					from: { id: 42, first_name: "Ada" },
				},
				me: { username: "openclaw_bot" },
				getFile: async () => ({}),
			});

			expect(replySpy).not.toHaveBeenCalled();

			const debounceTimerIndexes = setTimeoutSpy.mock.calls
				.map((call, index) => ({ index, delay: call[1] }))
				.filter((entry) => entry.delay === DEBOUNCE_MS)
				.map((entry) => entry.index);
			expect(debounceTimerIndexes.length).toBeGreaterThanOrEqual(2);

			for (const index of debounceTimerIndexes) {
				clearTimeout(
					setTimeoutSpy.mock.results[index]?.value as ReturnType<
						typeof setTimeout
					>,
				);
			}
			for (const index of debounceTimerIndexes) {
				const flushTimer = setTimeoutSpy.mock.calls[index]?.[0] as
					| (() => unknown)
					| undefined;
				await flushTimer?.();
			}

			await vi.waitFor(() => {
				expect(replySpy).toHaveBeenCalledTimes(2);
			});
			const threadIds = replySpy.mock.calls
				.map(
					(call: [unknown, ...unknown[]]) =>
						(call[0] as { MessageThreadId?: number }).MessageThreadId,
				)
				.toSorted(
					(a: number | undefined, b: number | undefined) => (a ?? 0) - (b ?? 0),
				);
			expect(threadIds).toEqual([100, 200]);
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it("handles quote-only replies without reply metadata", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		replySpy.mockClear();

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 7, type: "private" },
				text: "Sure, see below",
				date: 1736380800,
				quote: {
					text: "summarize this",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.Body).toContain("[Quoting unknown sender]");
		expect(payload.Body).toContain('"summarize this"');
		expect(payload.ReplyToId).toBeUndefined();
		expect(payload.ReplyToBody).toBe("summarize this");
		expect(payload.ReplyToSender).toBe("unknown sender");
	});

	it("uses external_reply quote text for partial replies", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		replySpy.mockClear();

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 7, type: "private" },
				text: "Sure, see below",
				date: 1736380800,
				external_reply: {
					message_id: 9002,
					text: "Can you summarize this?",
					from: { first_name: "Ada" },
					quote: {
						text: "summarize this",
					},
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.Body).toContain("[Quoting Ada id:9002]");
		expect(payload.Body).toContain('"summarize this"');
		expect(payload.ReplyToId).toBe("9002");
		expect(payload.ReplyToBody).toBe("summarize this");
		expect(payload.ReplyToSender).toBe("Ada");
	});

	it("propagates forwarded origin from external_reply targets", async () => {
		onSpy.mockReset();
		sendMessageSpy.mockReset();
		replySpy.mockReset();

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 7, type: "private" },
				text: "Thoughts?",
				date: 1736380800,
				external_reply: {
					message_id: 9003,
					text: "forwarded text",
					from: { first_name: "Ada" },
					quote: {
						text: "forwarded snippet",
					},
					forward_origin: {
						type: "user",
						sender_user: {
							id: 999,
							first_name: "Bob",
							last_name: "Smith",
							username: "bobsmith",
							is_bot: false,
						},
						date: 500,
					},
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
		expect(payload.ReplyToForwardedFromType).toBe("user");
		expect(payload.ReplyToForwardedFromId).toBe("999");
		expect(payload.ReplyToForwardedFromUsername).toBe("bobsmith");
		expect(payload.ReplyToForwardedFromTitle).toBe("Bob Smith");
		expect(payload.ReplyToForwardedDate).toBe(500000);
		expect(payload.Body).toContain(
			"[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]",
		);
	});

	it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			channels: {
				telegram: { groups: { "*": { requireMention: true } } },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: 456, type: "group", title: "Ops Chat" },
				text: "following up",
				date: 1736380800,
				reply_to_message: {
					message_id: 42,
					text: "original reply",
					from: { id: 999, first_name: "OpenClaw" },
				},
			},
			me: { id: 999, username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.WasMentioned).toBe(true);
	});

	it("inherits group allowlist + requireMention in topics", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					groupPolicy: "allowlist",
					groups: {
						"-1001234567890": {
							requireMention: false,
							allowFrom: ["123456789"],
							topics: {
								"99": {},
							},
						},
					},
				},
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: {
					id: -1001234567890,
					type: "supergroup",
					title: "Forum Group",
					is_forum: true,
				},
				from: { id: 123456789, username: "testuser" },
				text: "hello",
				date: 1736380800,
				message_thread_id: 99,
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("prefers topic allowFrom over group allowFrom", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					groupPolicy: "allowlist",
					groups: {
						"-1001234567890": {
							allowFrom: ["123456789"],
							topics: {
								"99": { allowFrom: ["999999999"] },
							},
						},
					},
				},
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: {
					id: -1001234567890,
					type: "supergroup",
					title: "Forum Group",
					is_forum: true,
				},
				from: { id: 123456789, username: "testuser" },
				text: "hello",
				date: 1736380800,
				message_thread_id: 99,
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(0);
	});

	it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					groupPolicy: "allowlist",
					groups: {
						"-100123456789": {
							groupPolicy: "open",
							requireMention: false,
						},
					},
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: -100123456789, type: "group", title: "Test Group" },
				from: { id: 999999, username: "random" },
				text: "hello",
				date: 1736380800,
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("blocks control commands from unauthorized senders in per-group open groups", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		loadConfig.mockReturnValue({
			channels: {
				telegram: {
					groupPolicy: "allowlist",
					groups: {
						"-100123456789": {
							groupPolicy: "open",
							requireMention: false,
						},
					},
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			message: {
				chat: { id: -100123456789, type: "group", title: "Test Group" },
				from: { id: 999999, username: "random" },
				text: "/status",
				date: 1736380800,
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(replySpy).not.toHaveBeenCalled();
	});

	it("routes plugin-owned callback namespaces before synthetic command fallback", async () => {
		onSpy.mockClear();
		replySpy.mockClear();
		editMessageTextSpy.mockClear();
		sendMessageSpy.mockClear();
		registerPluginInteractiveHandler("codex-plugin", {
			channel: "telegram",
			namespace: "codexapp",
			handler: async ({
				respond,
				callback,
			}: PluginInteractiveTelegramHandlerContext) => {
				await respond.editMessage({
					text: `Handled ${callback.payload}`,
				});
				return { handled: true };
			},
		});

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "open",
						allowFrom: ["*"],
					},
				},
			},
		});
		const callbackHandler = getOnHandler("callback_query") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await callbackHandler({
			callbackQuery: {
				id: "cbq-codex-1",
				data: "codexapp:resume:thread-1",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: 1234, type: "private" },
					date: 1736380800,
					message_id: 11,
					text: "Select a thread",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(editMessageTextSpy).toHaveBeenCalledWith(
			1234,
			11,
			"Handled resume:thread-1",
			undefined,
		);
		expect(replySpy).not.toHaveBeenCalled();
	});

	it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
		onSpy.mockClear();
		getChatSpy.mockResolvedValue({
			id: -100123456789,
			type: "supergroup",
			is_forum: true,
		});
		const handler = vi.fn(
			async ({
				respond,
				conversationId,
				threadId,
			}: PluginInteractiveTelegramHandlerContext) => {
				expect(conversationId).toBe("-100123456789:topic:1");
				expect(threadId).toBe(1);
				await respond.editMessage({
					text: `Handled ${conversationId}`,
				});
				return { handled: true };
			},
		);
		registerPluginInteractiveHandler("codex-plugin", {
			channel: "telegram",
			namespace: "codexapp",
			handler,
		});

		createTelegramBot({
			token: "tok",
			config: {
				channels: {
					telegram: {
						dmPolicy: "open",
						allowFrom: ["*"],
					},
				},
			},
		});
		const callbackHandler = getOnHandler("callback_query") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await callbackHandler({
			callbackQuery: {
				id: "cbq-codex-general",
				data: "codexapp:resume:thread-1",
				from: { id: 9, first_name: "Ada", username: "ada_bot" },
				message: {
					chat: { id: -100123456789, type: "supergroup", title: "Forum Group" },
					date: 1736380800,
					message_id: 11,
					text: "Select a thread",
				},
			},
			me: { username: "openclaw_bot" },
			getFile: async () => ({ download: async () => new Uint8Array() }),
		});

		expect(getChatSpy).toHaveBeenCalledWith(-100123456789);
		expect(handler).toHaveBeenCalledOnce();
		expect(editMessageTextSpy).toHaveBeenCalledWith(
			-100123456789,
			11,
			"Handled -100123456789:topic:1",
			undefined,
		);
	});
	it("sets command target session key for dm topic commands", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		commandSpy.mockClear();
		replySpy.mockClear();
		replySpy.mockResolvedValue({ text: "response" });

		loadConfig.mockReturnValue({
			commands: { native: true },
			channels: {
				telegram: {
					dmPolicy: "pairing",
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

		createTelegramBot({ token: "tok" });
		const handler = commandSpy.mock.calls.find(
			(call) => call[0] === "status",
		)?.[1] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
		if (!handler) {
			throw new Error("status command handler missing");
		}

		await handler({
			message: {
				chat: { id: 12345, type: "private" },
				from: { id: 12345, username: "testuser" },
				text: "/status",
				date: 1736380800,
				message_id: 42,
				message_thread_id: 99,
			},
			match: "",
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		const payload = replySpy.mock.calls[0][0];
		expect(payload.CommandTargetSessionKey).toBe(
			"agent:main:main:thread:12345:99",
		);
	});

	it("allows native DM commands for paired users", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		commandSpy.mockClear();
		replySpy.mockClear();
		replySpy.mockResolvedValue({ text: "response" });

		loadConfig.mockReturnValue({
			commands: { native: true },
			channels: {
				telegram: {
					dmPolicy: "pairing",
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

		createTelegramBot({ token: "tok" });
		const handler = commandSpy.mock.calls.find(
			(call) => call[0] === "status",
		)?.[1] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
		if (!handler) {
			throw new Error("status command handler missing");
		}

		await handler({
			message: {
				chat: { id: 12345, type: "private" },
				from: { id: 12345, username: "testuser" },
				text: "/status",
				date: 1736380800,
				message_id: 42,
			},
			match: "",
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
		expect(
			sendMessageSpy.mock.calls.some(
				(call) => call[1] === "You are not authorized to use this command.",
			),
		).toBe(false);
	});

	it("keeps native DM commands on the startup-resolved config when fresh reads contain SecretRefs", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		commandSpy.mockClear();
		replySpy.mockClear();
		replySpy.mockResolvedValue({ text: "response" });

		const startupConfig = {
			commands: { native: true },
			channels: {
				telegram: {
					dmPolicy: "pairing" as const,
					botToken: "resolved-token",
				},
			},
		};

		createTelegramBot({
			token: "tok",
			config: startupConfig,
		});
		loadConfig.mockReturnValue({
			commands: { native: true },
			channels: {
				telegram: {
					dmPolicy: "pairing",
					botToken: {
						source: "env",
						provider: "default",
						id: "TELEGRAM_BOT_TOKEN",
					},
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

		const handler = commandSpy.mock.calls.find(
			(call) => call[0] === "status",
		)?.[1] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
		if (!handler) {
			throw new Error("status command handler missing");
		}

		await handler({
			message: {
				chat: { id: 12345, type: "private" },
				from: { id: 12345, username: "testuser" },
				text: "/status",
				date: 1736380800,
				message_id: 42,
			},
			match: "",
		});

		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("blocks native DM commands for unpaired users", async () => {
		onSpy.mockClear();
		sendMessageSpy.mockClear();
		commandSpy.mockClear();
		replySpy.mockClear();

		loadConfig.mockReturnValue({
			commands: { native: true },
			channels: {
				telegram: {
					dmPolicy: "pairing",
				},
			},
		});
		readChannelAllowFromStore.mockResolvedValueOnce([]);

		createTelegramBot({ token: "tok" });
		const handler = commandSpy.mock.calls.find(
			(call) => call[0] === "status",
		)?.[1] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
		if (!handler) {
			throw new Error("status command handler missing");
		}

		await handler({
			message: {
				chat: { id: 12345, type: "private" },
				from: { id: 12345, username: "testuser" },
				text: "/status",
				date: 1736380800,
				message_id: 42,
			},
			match: "",
		});

		expect(replySpy).not.toHaveBeenCalled();
		expect(sendMessageSpy).toHaveBeenCalledWith(
			12345,
			"You are not authorized to use this command.",
			{},
		);
	});

	it("registers message_reaction handler", () => {
		onSpy.mockClear();
		createTelegramBot({ token: "tok" });
		const reactionHandler = onSpy.mock.calls.find(
			(call) => call[0] === "message_reaction",
		);
		expect(reactionHandler).toBeDefined();
	});

	it("enqueues system event for reaction", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 500 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada", username: "ada_bot" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
			"Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42",
			expect.objectContaining({
				contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
			}),
		);
	});

	it.each([
		{
			name: "blocks reaction when dmPolicy is disabled",
			updateId: 510,
			channelConfig: { dmPolicy: "disabled", reactionNotifications: "all" },
			reaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
			expectedEnqueueCalls: 0,
		},
		{
			name: "blocks reaction in allowlist mode for unauthorized direct sender",
			updateId: 511,
			channelConfig: {
				dmPolicy: "allowlist",
				allowFrom: ["12345"],
				reactionNotifications: "all",
			},
			reaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
			expectedEnqueueCalls: 0,
		},
		{
			name: "allows reaction in allowlist mode for authorized direct sender",
			updateId: 512,
			channelConfig: {
				dmPolicy: "allowlist",
				allowFrom: ["9"],
				reactionNotifications: "all",
			},
			reaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
			expectedEnqueueCalls: 1,
		},
		{
			name: "blocks reaction in group allowlist mode for unauthorized sender",
			updateId: 513,
			channelConfig: {
				dmPolicy: "open",
				groupPolicy: "allowlist",
				groupAllowFrom: ["12345"],
				reactionNotifications: "all",
			},
			reaction: {
				chat: { id: 9999, type: "supergroup" },
				message_id: 77,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🔥" }],
			},
			expectedEnqueueCalls: 0,
		},
	])("$name", async ({
		updateId,
		channelConfig,
		reaction,
		expectedEnqueueCalls,
	}) => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: channelConfig,
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: updateId },
			messageReaction: reaction,
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(expectedEnqueueCalls);
	});

	it("skips reaction when reactionNotifications is off", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(true);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "off" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 501 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
		});

		expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
	});

	it("defaults reactionNotifications to own", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(true);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 502 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 43,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👍" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
	});

	it("allows reaction in all mode regardless of message sender", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(false);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 503 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 99,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🎉" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
			"Telegram reaction added: 🎉 by Ada on msg 99",
			expect.any(Object),
		);
	});

	it("skips reaction in own mode when message is not sent by bot", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(false);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "own" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 503 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 99,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🎉" }],
			},
		});

		expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
	});

	it("allows reaction in own mode when message is sent by bot", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(true);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "own" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 503 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 99,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🎉" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
	});

	it("skips reaction from bot users", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();
		wasSentByBot.mockReturnValue(true);

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 503 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 99,
				user: { id: 9, first_name: "Bot", is_bot: true },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🎉" }],
			},
		});

		expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
	});

	it("skips reaction removal (only processes added reactions)", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 504 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [{ type: "emoji", emoji: "👍" }],
				new_reaction: [],
			},
		});

		expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
	});

	it("enqueues one event per added emoji reaction", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 505 },
			messageReaction: {
				chat: { id: 1234, type: "private" },
				message_id: 42,
				user: { id: 9, first_name: "Ada" },
				date: 1736380800,
				old_reaction: [{ type: "emoji", emoji: "👍" }],
				new_reaction: [
					{ type: "emoji", emoji: "👍" },
					{ type: "emoji", emoji: "🔥" },
					{ type: "emoji", emoji: "🎉" },
				],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
		expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
			"Telegram reaction added: 🔥 by Ada on msg 42",
			"Telegram reaction added: 🎉 by Ada on msg 42",
		]);
	});

	it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		// MessageReactionUpdated does not include message_thread_id in the Bot API,
		// so forum reactions always route to the general topic (1).
		await handler({
			update: { update_id: 505 },
			messageReaction: {
				chat: { id: 5678, type: "supergroup", is_forum: true },
				message_id: 100,
				user: { id: 10, first_name: "Bob", username: "bob_user" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "🔥" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
			"Telegram reaction added: 🔥 by Bob (@bob_user) on msg 100",
			expect.objectContaining({
				sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
				contextKey: expect.stringContaining(
					"telegram:reaction:add:5678:100:10",
				),
			}),
		);
	});

	it("uses correct session key for forum group reactions in general topic", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 506 },
			messageReaction: {
				chat: { id: 5678, type: "supergroup", is_forum: true },
				message_id: 101,
				// No message_thread_id - should default to general topic (1)
				user: { id: 10, first_name: "Bob" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "👀" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
			"Telegram reaction added: 👀 by Bob on msg 101",
			expect.objectContaining({
				sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
				contextKey: expect.stringContaining(
					"telegram:reaction:add:5678:101:10",
				),
			}),
		);
	});

	it("uses correct session key for regular group reactions without topic", async () => {
		onSpy.mockClear();
		enqueueSystemEventSpy.mockClear();

		loadConfig.mockReturnValue({
			channels: {
				telegram: { dmPolicy: "open", reactionNotifications: "all" },
			},
		});

		createTelegramBot({ token: "tok" });
		const handler = getOnHandler("message_reaction") as (
			ctx: Record<string, unknown>,
		) => Promise<void>;

		await handler({
			update: { update_id: 507 },
			messageReaction: {
				chat: { id: 9999, type: "group" },
				message_id: 200,
				user: { id: 11, first_name: "Charlie" },
				date: 1736380800,
				old_reaction: [],
				new_reaction: [{ type: "emoji", emoji: "❤️" }],
			},
		});

		expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
			"Telegram reaction added: ❤️ by Charlie on msg 200",
			expect.objectContaining({
				sessionKey: expect.stringContaining("telegram:group:9999"),
				contextKey: expect.stringContaining(
					"telegram:reaction:add:9999:200:11",
				),
			}),
		);
		// Verify session key does NOT contain :topic:
		const eventOptions = enqueueSystemEventSpy.mock.calls[0]?.[1] as {
			sessionKey?: string;
		};
		const sessionKey = eventOptions.sessionKey ?? "";
		expect(sessionKey).not.toContain(":topic:");
	});
});
