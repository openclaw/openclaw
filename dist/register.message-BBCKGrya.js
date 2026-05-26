import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { r as setVerbose } from "./global-state-BAD7XgmL.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { n as CHANNEL_TARGET_DESCRIPTION, t as CHANNEL_TARGETS_DESCRIPTION } from "./channel-target-Nug_hTy8.js";
import { o as runGlobalGatewayStopSafely } from "./hook-runner-global-BkXXy1ub.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { n as CHANNEL_MESSAGE_ACTION_NAMES, t as resolveMessageSecretScope } from "./message-secret-scope-NhV1S-c7.js";
import { d as getScopedChannelsCommandSecretTargets } from "./command-secret-targets-UUlaHEu2.js";
import { n as runMessageAction } from "./message-action-runner-B4oH5EYj.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { t as formatHelpExamples } from "./help-format-DXVAk021.js";
import { t as collectOption } from "./helpers-BNXNWxTW.js";
import { t as createDefaultDeps } from "./deps-C1bdn-NA.js";
import { t as createOutboundSendDeps } from "./outbound-send-deps-fPP8XU6h.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-QySEqFLr.js";
import { t as ensurePluginRegistryLoaded } from "./runtime-registry-loader-CW8fFOJd.js";
import "./plugin-registry-B_uPldHa.js";
//#region src/commands/message.ts
function extractMessageId(payload) {
	if (!payload || typeof payload !== "object") return;
	const record = payload;
	const direct = normalizeOptionalString(record.messageId);
	if (direct) return direct;
	const result = record.result;
	if (result && typeof result === "object") {
		const nested = normalizeOptionalString(result.messageId);
		if (nested) return nested;
	}
}
function buildMessageCliJson(result) {
	const messageId = extractMessageId(result.payload);
	return {
		action: result.action,
		channel: result.channel,
		dryRun: result.dryRun,
		handledBy: result.handledBy,
		...messageId ? { messageId } : {},
		payload: result.payload
	};
}
async function messageCommand(opts, deps, runtime) {
	const loadedRaw = getRuntimeConfig();
	const scope = resolveMessageSecretScope({
		channel: opts.channel,
		target: opts.target,
		targets: opts.targets,
		accountId: opts.accountId
	});
	const scopedTargets = getScopedChannelsCommandSecretTargets({
		config: loadedRaw,
		channel: scope.channel,
		accountId: scope.accountId
	});
	const { effectiveConfig: cfg } = await resolveCommandConfigWithSecrets({
		config: loadedRaw,
		commandName: "message",
		targetIds: scopedTargets.targetIds,
		...scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {},
		runtime,
		autoEnable: true
	});
	const actionInput = (normalizeOptionalString(opts.action) ?? "") || "send";
	const normalizedActionInput = normalizeLowercaseStringOrEmpty(actionInput);
	const actionMatch = CHANNEL_MESSAGE_ACTION_NAMES.find((name) => normalizeLowercaseStringOrEmpty(name) === normalizedActionInput);
	if (!actionMatch) throw new Error(`Unknown message action "${actionInput}". Use one of ${CHANNEL_MESSAGE_ACTION_NAMES.join(", ")}. Example: ${formatCliCommand("openclaw message send --channel <channel> --target <id> --text <message>")}.`);
	const action = actionMatch;
	const outboundDeps = createOutboundSendDeps(deps);
	const run = async () => await runMessageAction({
		cfg,
		action,
		params: opts,
		deps: outboundDeps,
		agentId: resolveDefaultAgentId(cfg),
		senderIsOwner: opts.senderIsOwner !== false,
		gateway: {
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			mode: GATEWAY_CLIENT_MODES.CLI
		}
	});
	const json = opts.json === true;
	const dryRun = opts.dryRun === true;
	const result = !json && !dryRun && (action === "send" || action === "poll") ? await withProgress({
		label: action === "poll" ? "Sending poll..." : "Sending...",
		indeterminate: true,
		enabled: true
	}, run) : await run();
	if (json) {
		writeRuntimeJson(runtime, buildMessageCliJson(result));
		return;
	}
	const { formatMessageCliText } = await import("./message-format-mpClHA72.js");
	for (const line of formatMessageCliText(result)) runtime.log(line);
}
//#endregion
//#region src/cli/program/message/helpers.ts
const GATEWAY_STOP_TIMEOUT_MS = 2500;
const ACTIONS_WITHOUT_STOP_HOOKS = new Set(["read"]);
const ACTIONS_REQUIRING_CONFIGURED_CHANNEL_PRELOAD = new Set(["broadcast"]);
const CHANNEL_MESSAGE_ACTION_NAME_SET = new Set(CHANNEL_MESSAGE_ACTION_NAMES);
function normalizeMessageOptions(opts) {
	const { account, ...rest } = opts;
	return {
		...rest,
		accountId: typeof account === "string" ? account : void 0
	};
}
async function runPluginStopHooks() {
	let timeout = null;
	const hookRun = runGlobalGatewayStopSafely({
		event: { reason: "cli message action complete" },
		ctx: {},
		onError: (err) => defaultRuntime.error(danger(`gateway_stop hook failed: ${String(err)}`))
	});
	const bounded = new Promise((resolve) => {
		timeout = setTimeout(() => resolve("timeout"), GATEWAY_STOP_TIMEOUT_MS);
		timeout.unref?.();
	});
	const result = await Promise.race([hookRun.then(() => "done"), bounded]);
	if (timeout) clearTimeout(timeout);
	if (result === "timeout") defaultRuntime.error(danger(`gateway_stop hook exceeded ${GATEWAY_STOP_TIMEOUT_MS}ms; continuing`));
}
function resolveScopedMessageChannel(opts) {
	return resolveMessageSecretScope({
		channel: opts.channel,
		target: opts.target,
		targets: opts.targets
	}).channel;
}
function asChannelMessageActionName(action) {
	return CHANNEL_MESSAGE_ACTION_NAME_SET.has(action) ? action : void 0;
}
function isGatewayOwnedMessageAction(action, scopedChannel) {
	const messageAction = asChannelMessageActionName(action);
	if (!messageAction || !scopedChannel) return false;
	return getChannelPlugin(scopedChannel)?.actions?.resolveExecutionMode?.({ action: messageAction }) === "gateway";
}
function resolveMessagePluginPreloadPlan(action, opts) {
	const scopedChannel = resolveScopedMessageChannel(opts);
	const loadOptions = scopedChannel ? {
		scope: "configured-channels",
		onlyChannelIds: [scopedChannel]
	} : { scope: "configured-channels" };
	if (opts.dryRun === true || ACTIONS_REQUIRING_CONFIGURED_CHANNEL_PRELOAD.has(action) || !isGatewayOwnedMessageAction(action, scopedChannel)) return {
		preload: true,
		loadOptions
	};
	return { preload: false };
}
function createMessageCliHelpers(message, messageChannelOptions) {
	const withMessageBase = (command) => command.option("--channel <channel>", `Channel: ${messageChannelOptions}`).option("--account <id>", "Channel account id (accountId)").option("--json", "Output result as JSON", false).option("--dry-run", "Print payload and skip sending", false).option("--verbose", "Verbose logging", false);
	const withMessageTarget = (command) => command.option("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
	const withRequiredMessageTarget = (command) => command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
	const runMessageAction = async (action, opts) => {
		setVerbose(Boolean(opts.verbose));
		let failed = false;
		await runCommandWithRuntime(defaultRuntime, async () => {
			const preloadPlan = resolveMessagePluginPreloadPlan(action, opts);
			if (preloadPlan.preload) ensurePluginRegistryLoaded(preloadPlan.loadOptions);
			const deps = createDefaultDeps();
			await messageCommand({
				...normalizeMessageOptions(opts),
				action
			}, deps, defaultRuntime);
		}, (err) => {
			failed = true;
			defaultRuntime.error(danger(String(err)));
		});
		if (!ACTIONS_WITHOUT_STOP_HOOKS.has(action)) await runPluginStopHooks();
		defaultRuntime.exit(failed ? 1 : 0);
	};
	return {
		withMessageBase,
		withMessageTarget,
		withRequiredMessageTarget,
		runMessageAction
	};
}
//#endregion
//#region src/cli/program/message/register.broadcast.ts
function registerMessageBroadcastCommand(message, helpers) {
	helpers.withMessageBase(message.command("broadcast").description("Broadcast a message to multiple targets")).requiredOption("--targets <target...>", CHANNEL_TARGETS_DESCRIPTION).option("--message <text>", "Message to send").option("--media <url>", "Media URL").action(async (options) => {
		await helpers.runMessageAction("broadcast", options);
	});
}
//#endregion
//#region src/cli/program/message/register.discord-admin.ts
function registerMessageDiscordAdminCommands(message, helpers) {
	const role = message.command("role").description("Role actions");
	helpers.withMessageBase(role.command("info").description("List roles").requiredOption("--guild-id <id>", "Guild id")).action(async (opts) => {
		await helpers.runMessageAction("role-info", opts);
	});
	helpers.withMessageBase(role.command("add").description("Add role to a member").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id").requiredOption("--role-id <id>", "Role id")).action(async (opts) => {
		await helpers.runMessageAction("role-add", opts);
	});
	helpers.withMessageBase(role.command("remove").description("Remove role from a member").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id").requiredOption("--role-id <id>", "Role id")).action(async (opts) => {
		await helpers.runMessageAction("role-remove", opts);
	});
	const channel = message.command("channel").description("Channel actions");
	helpers.withMessageBase(helpers.withRequiredMessageTarget(channel.command("info").description("Fetch channel info"))).action(async (opts) => {
		await helpers.runMessageAction("channel-info", opts);
	});
	helpers.withMessageBase(channel.command("list").description("List channels").requiredOption("--guild-id <id>", "Guild id")).action(async (opts) => {
		await helpers.runMessageAction("channel-list", opts);
	});
	const member = message.command("member").description("Member actions");
	helpers.withMessageBase(member.command("info").description("Fetch member info").requiredOption("--user-id <id>", "User id")).option("--guild-id <id>", "Guild id (Discord)").action(async (opts) => {
		await helpers.runMessageAction("member-info", opts);
	});
	const voice = message.command("voice").description("Voice actions");
	helpers.withMessageBase(voice.command("status").description("Fetch voice status").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id")).action(async (opts) => {
		await helpers.runMessageAction("voice-status", opts);
	});
	const event = message.command("event").description("Event actions");
	helpers.withMessageBase(event.command("list").description("List scheduled events").requiredOption("--guild-id <id>", "Guild id")).action(async (opts) => {
		await helpers.runMessageAction("event-list", opts);
	});
	helpers.withMessageBase(event.command("create").description("Create a scheduled event").requiredOption("--guild-id <id>", "Guild id").requiredOption("--event-name <name>", "Event name").requiredOption("--start-time <iso>", "Event start time")).option("--end-time <iso>", "Event end time").option("--desc <text>", "Event description").option("--channel-id <id>", "Channel id").option("--location <text>", "Event location").option("--event-type <stage|external|voice>", "Event type").option("--image <url>", "Cover image URL or local file path").action(async (opts) => {
		await helpers.runMessageAction("event-create", opts);
	});
	helpers.withMessageBase(message.command("timeout").description("Timeout a member").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id")).option("--duration-min <n>", "Timeout duration minutes").option("--until <iso>", "Timeout until").option("--reason <text>", "Moderation reason").action(async (opts) => {
		await helpers.runMessageAction("timeout", opts);
	});
	helpers.withMessageBase(message.command("kick").description("Kick a member").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id")).option("--reason <text>", "Moderation reason").action(async (opts) => {
		await helpers.runMessageAction("kick", opts);
	});
	helpers.withMessageBase(message.command("ban").description("Ban a member").requiredOption("--guild-id <id>", "Guild id").requiredOption("--user-id <id>", "User id")).option("--reason <text>", "Moderation reason").option("--delete-days <n>", "Ban delete message days").action(async (opts) => {
		await helpers.runMessageAction("ban", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.emoji-sticker.ts
function registerMessageEmojiCommands(message, helpers) {
	const emoji = message.command("emoji").description("Emoji actions");
	helpers.withMessageBase(emoji.command("list").description("List emojis")).option("--guild-id <id>", "Guild id (Discord)").action(async (opts) => {
		await helpers.runMessageAction("emoji-list", opts);
	});
	helpers.withMessageBase(emoji.command("upload").description("Upload an emoji").requiredOption("--guild-id <id>", "Guild id")).requiredOption("--emoji-name <name>", "Emoji name").requiredOption("--media <path-or-url>", "Emoji media (path or URL)").option("--role-ids <id>", "Role id (repeat)", collectOption, []).action(async (opts) => {
		await helpers.runMessageAction("emoji-upload", opts);
	});
}
function registerMessageStickerCommands(message, helpers) {
	const sticker = message.command("sticker").description("Sticker actions");
	helpers.withMessageBase(helpers.withRequiredMessageTarget(sticker.command("send").description("Send stickers"))).requiredOption("--sticker-id <id>", "Sticker id (repeat)", collectOption).option("-m, --message <text>", "Optional message body").action(async (opts) => {
		await helpers.runMessageAction("sticker", opts);
	});
	helpers.withMessageBase(sticker.command("upload").description("Upload a sticker").requiredOption("--guild-id <id>", "Guild id")).requiredOption("--sticker-name <name>", "Sticker name").requiredOption("--sticker-desc <text>", "Sticker description").requiredOption("--sticker-tags <tags>", "Sticker tags").requiredOption("--media <path-or-url>", "Sticker media (path or URL)").action(async (opts) => {
		await helpers.runMessageAction("sticker-upload", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.permissions-search.ts
function registerMessagePermissionsCommand(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("permissions").description("Fetch channel permissions"))).action(async (opts) => {
		await helpers.runMessageAction("permissions", opts);
	});
}
function registerMessageSearchCommand(message, helpers) {
	helpers.withMessageBase(message.command("search").description("Search Discord messages")).requiredOption("--guild-id <id>", "Guild id").requiredOption("--query <text>", "Search query").option("--channel-id <id>", "Channel id").option("--channel-ids <id>", "Channel id (repeat)", collectOption, []).option("--author-id <id>", "Author id").option("--author-ids <id>", "Author id (repeat)", collectOption, []).option("--limit <n>", "Result limit").action(async (opts) => {
		await helpers.runMessageAction("search", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.pins.ts
function registerMessagePinCommands(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("pin").description("Pin a message"))).requiredOption("--message-id <id>", "Message id").action(async (opts) => {
		await helpers.runMessageAction("pin", opts);
	}), helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("unpin").description("Unpin a message"))).requiredOption("--message-id <id>", "Message id (or pinned message resource id for MSTeams)").option("--pinned-message-id <id>", "Pinned message resource id (MSTeams: from pin or list-pins, not the chat message id)").action(async (opts) => {
		await helpers.runMessageAction("unpin", opts);
	}), helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("pins").description("List pinned messages"))).option("--limit <n>", "Result limit").action(async (opts) => {
		await helpers.runMessageAction("list-pins", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.poll.ts
function registerMessagePollCommand(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("poll").description("Send a poll"))).requiredOption("--poll-question <text>", "Poll question").option("--poll-option <choice>", "Poll option (repeat 2-12 times)", collectOption, []).option("--poll-multi", "Allow multiple selections", false).option("--poll-duration-hours <n>", "Poll duration in hours (Discord)").option("--poll-duration-seconds <n>", "Poll duration in seconds (Telegram; 5-600)").option("--poll-anonymous", "Send an anonymous poll (Telegram)", false).option("--poll-public", "Send a non-anonymous poll (Telegram)", false).option("-m, --message <text>", "Optional message body").option("--silent", "Send poll silently without notification (Telegram + Discord where supported)", false).option("--thread-id <id>", "Thread id (Telegram forum topic / Slack thread ts)").action(async (opts) => {
		await helpers.runMessageAction("poll", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.reactions.ts
function registerMessageReactionsCommands(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("react").description("Add or remove a reaction"))).requiredOption("--message-id <id>", "Message id").option("--emoji <emoji>", "Emoji for reactions").option("--remove", "Remove reaction", false).option("--participant <id>", "WhatsApp reaction participant").option("--from-me", "WhatsApp reaction fromMe", false).option("--target-author <id>", "Signal reaction target author (uuid or phone)").option("--target-author-uuid <uuid>", "Signal reaction target author uuid").action(async (opts) => {
		await helpers.runMessageAction("react", opts);
	});
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("reactions").description("List reactions on a message"))).requiredOption("--message-id <id>", "Message id").option("--limit <n>", "Result limit").action(async (opts) => {
		await helpers.runMessageAction("reactions", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.read-edit-delete.ts
function registerMessageReadEditDeleteCommands(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("read").description("Read recent messages"))).option("--limit <n>", "Result limit").option("--message-id <id>", "Read a specific message id").option("--before <id>", "Read/search before id").option("--after <id>", "Read/search after id").option("--around <id>", "Read around id").option("--thread-id <id>", "Thread id (Slack thread timestamp)").option("--include-thread", "Include thread replies (Discord)", false).action(async (opts) => {
		await helpers.runMessageAction("read", opts);
	});
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("edit").description("Edit a message").requiredOption("--message-id <id>", "Message id").requiredOption("-m, --message <text>", "Message body"))).option("--thread-id <id>", "Thread id (Telegram forum thread)").action(async (opts) => {
		await helpers.runMessageAction("edit", opts);
	});
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("delete").description("Delete a message").requiredOption("--message-id <id>", "Message id"))).action(async (opts) => {
		await helpers.runMessageAction("delete", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.send.ts
function registerMessageSendCommand(message, helpers) {
	helpers.withMessageBase(helpers.withRequiredMessageTarget(message.command("send").description("Send a message").option("-m, --message <text>", "Message body (required unless --media is set)")).option("--media <path-or-url>", "Attach media (image/audio/video/document). Accepts local paths or URLs.").option("--presentation <json>", "Shared presentation payload as JSON (text, context, dividers, buttons, selects)").option("--delivery <json>", "Shared delivery preferences as JSON").option("--pin", "Request that the delivered message be pinned when supported", false).option("--reply-to <id>", "Reply-to message id").option("--thread-id <id>", "Thread id (Telegram forum thread)").option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false).option("--force-document", "Send media as document to avoid channel compression (Telegram, WhatsApp). Applies to images, GIFs, and videos.", false).option("--silent", "Send message silently without notification (Telegram + Discord)", false)).action(async (opts) => {
		await helpers.runMessageAction("send", opts);
	});
}
//#endregion
//#region src/cli/program/message/register.thread.ts
function resolveThreadCreateRequest(opts) {
	const channel = normalizeLowercaseStringOrEmpty(opts.channel);
	if (channel) {
		const request = getChannelPlugin(channel)?.actions?.resolveCliActionRequest?.({
			action: "thread-create",
			args: opts
		});
		if (request) return {
			action: request.action,
			params: request.args
		};
	}
	return {
		action: "thread-create",
		params: opts
	};
}
function registerMessageThreadCommands(message, helpers) {
	const thread = message.command("thread").description("Thread actions");
	helpers.withMessageBase(helpers.withRequiredMessageTarget(thread.command("create").description("Create a thread").requiredOption("--thread-name <name>", "Thread name"))).option("--message-id <id>", "Message id (optional)").option("-m, --message <text>", "Initial thread message text").option("--auto-archive-min <n>", "Thread auto-archive minutes").action(async (opts) => {
		const request = resolveThreadCreateRequest(opts);
		await helpers.runMessageAction(request.action, request.params);
	});
	helpers.withMessageBase(thread.command("list").description("List threads").requiredOption("--guild-id <id>", "Guild id")).option("--channel-id <id>", "Channel id").option("--include-archived", "Include archived threads", false).option("--before <id>", "Read/search before id").option("--limit <n>", "Result limit").action(async (opts) => {
		await helpers.runMessageAction("thread-list", opts);
	});
	helpers.withMessageBase(helpers.withRequiredMessageTarget(thread.command("reply").description("Reply in a thread").requiredOption("-m, --message <text>", "Message body"))).option("--media <path-or-url>", "Attach media (image/audio/video/document). Accepts local paths or URLs.").option("--reply-to <id>", "Reply-to message id").action(async (opts) => {
		await helpers.runMessageAction("thread-reply", opts);
	});
}
//#endregion
//#region src/cli/program/register.message.ts
function registerMessageCommands(program, ctx) {
	const message = program.command("message").description("Send, read, and manage messages and channel actions").addHelpText("after", () => `
${theme.heading("Examples:")}
${formatHelpExamples([
		["openclaw message send --target +15555550123 --message \"Hi\"", "Send a text message."],
		["openclaw message send --target +15555550123 --message \"Hi\" --media photo.jpg", "Send a message with media."],
		["openclaw message poll --channel discord --target channel:123 --poll-question \"Snack?\" --poll-option Pizza --poll-option Sushi", "Create a Discord poll."],
		["openclaw message react --channel discord --target 123 --message-id 456 --emoji \"✅\"", "React to a message."]
	])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/message", "docs.openclaw.ai/cli/message")}`).action(() => {
		message.help({ error: true });
	});
	const helpers = createMessageCliHelpers(message, ctx.messageChannelOptions);
	registerMessageSendCommand(message, helpers);
	registerMessageBroadcastCommand(message, helpers);
	registerMessagePollCommand(message, helpers);
	registerMessageReactionsCommands(message, helpers);
	registerMessageReadEditDeleteCommands(message, helpers);
	registerMessagePinCommands(message, helpers);
	registerMessagePermissionsCommand(message, helpers);
	registerMessageSearchCommand(message, helpers);
	registerMessageThreadCommands(message, helpers);
	registerMessageEmojiCommands(message, helpers);
	registerMessageStickerCommands(message, helpers);
	registerMessageDiscordAdminCommands(message, helpers);
}
//#endregion
export { registerMessageCommands };
