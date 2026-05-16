import { n as __reExport, t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { ApplicationCommandOptionType, ApplicationCommandType, ButtonStyle, ComponentType, GatewayDispatchEvents, InteractionContextType, InteractionResponseType, InteractionType, MessageFlags, Routes, TextInputStyle } from "discord-api-types/v10";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { inspect } from "node:util";
//#region extensions/discord/src/internal/api.commands.ts
async function listApplicationCommands(rest, clientId) {
	return await rest.get(Routes.applicationCommands(clientId));
}
async function createApplicationCommand(rest, clientId, body) {
	return await rest.post(Routes.applicationCommands(clientId), { body });
}
async function editApplicationCommand(rest, clientId, commandId, body) {
	return await rest.patch(Routes.applicationCommand(clientId, commandId), { body });
}
async function deleteApplicationCommand(rest, clientId, commandId) {
	await rest.delete(Routes.applicationCommand(clientId, commandId));
}
async function overwriteApplicationCommands(rest, clientId, body) {
	await rest.put(Routes.applicationCommands(clientId), { body });
}
async function overwriteGuildApplicationCommands(rest, clientId, guildId, body) {
	await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
}
//#endregion
//#region extensions/discord/src/internal/api.guild.ts
async function getGuild(rest, guildId) {
	return await rest.get(Routes.guild(guildId));
}
async function createGuildChannel(rest, guildId, data) {
	return await rest.post(Routes.guildChannels(guildId), data);
}
async function moveGuildChannels(rest, guildId, data) {
	await rest.patch(Routes.guildChannels(guildId), data);
}
async function getGuildMember(rest, guildId, userId) {
	return await rest.get(Routes.guildMember(guildId, userId));
}
async function listGuildRoles(rest, guildId) {
	return await rest.get(Routes.guildRoles(guildId));
}
async function listGuildChannels(rest, guildId) {
	return await rest.get(Routes.guildChannels(guildId));
}
async function putChannelPermission(rest, channelId, targetId, data) {
	await rest.put(Routes.channelPermission(channelId, targetId), data);
}
async function deleteChannelPermission(rest, channelId, targetId) {
	await rest.delete(Routes.channelPermission(channelId, targetId));
}
async function listGuildActiveThreads(rest, guildId) {
	return await rest.get(Routes.guildActiveThreads(guildId));
}
async function getGuildVoiceState(rest, guildId, userId) {
	return await rest.get(Routes.guildVoiceState(guildId, userId));
}
async function listGuildScheduledEvents(rest, guildId) {
	return await rest.get(Routes.guildScheduledEvents(guildId));
}
async function createGuildScheduledEvent(rest, guildId, body) {
	return await rest.post(Routes.guildScheduledEvents(guildId), { body });
}
async function timeoutGuildMember(rest, guildId, userId, data) {
	return await rest.patch(Routes.guildMember(guildId, userId), data);
}
async function addGuildMemberRole(rest, guildId, userId, roleId) {
	await rest.put(Routes.guildMemberRole(guildId, userId, roleId));
}
async function removeGuildMemberRole(rest, guildId, userId, roleId) {
	await rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
}
async function removeGuildMember(rest, guildId, userId, data) {
	await rest.delete(Routes.guildMember(guildId, userId), data);
}
async function createGuildBan(rest, guildId, userId, data) {
	await rest.put(Routes.guildBan(guildId, userId), data);
}
async function listGuildEmojis(rest, guildId) {
	return await rest.get(Routes.guildEmojis(guildId));
}
async function createGuildEmoji(rest, guildId, data) {
	return await rest.post(Routes.guildEmojis(guildId), data);
}
async function createGuildSticker(rest, guildId, data) {
	return await rest.post(Routes.guildStickers(guildId), data);
}
//#endregion
//#region extensions/discord/src/internal/api.interactions.ts
async function createInteractionCallback(rest, interactionId, token, body) {
	return await rest.post(Routes.interactionCallback(interactionId, token), { body });
}
async function editWebhookMessage(rest, applicationId, token, messageId, data, query) {
	return query ? await rest.patch(Routes.webhookMessage(applicationId, token, messageId), data, query) : await rest.patch(Routes.webhookMessage(applicationId, token, messageId), data);
}
async function deleteWebhookMessage(rest, applicationId, token, messageId) {
	return await rest.delete(Routes.webhookMessage(applicationId, token, messageId));
}
async function getWebhookMessage(rest, applicationId, token, messageId) {
	return await rest.get(Routes.webhookMessage(applicationId, token, messageId));
}
async function createWebhookMessage(rest, applicationId, token, data, query) {
	return await rest.post(Routes.webhook(applicationId, token), data, query);
}
//#endregion
//#region extensions/discord/src/internal/api.messages.ts
async function getChannel(rest, channelId) {
	return await rest.get(Routes.channel(channelId));
}
async function editChannel(rest, channelId, data) {
	return await rest.patch(Routes.channel(channelId), data);
}
async function deleteChannel(rest, channelId) {
	await rest.delete(Routes.channel(channelId));
}
async function listChannelMessages(rest, channelId, query) {
	return await rest.get(Routes.channelMessages(channelId), query);
}
async function getChannelMessage(rest, channelId, messageId) {
	return await rest.get(Routes.channelMessage(channelId, messageId));
}
async function createChannelMessage(rest, channelId, data) {
	return await rest.post(Routes.channelMessages(channelId), data);
}
async function editChannelMessage(rest, channelId, messageId, data) {
	return await rest.patch(Routes.channelMessage(channelId, messageId), data);
}
async function deleteChannelMessage(rest, channelId, messageId) {
	await rest.delete(Routes.channelMessage(channelId, messageId));
}
async function pinChannelMessage(rest, channelId, messageId) {
	await rest.put(Routes.channelPin(channelId, messageId));
}
async function unpinChannelMessage(rest, channelId, messageId) {
	await rest.delete(Routes.channelPin(channelId, messageId));
}
async function listChannelPins(rest, channelId) {
	return await rest.get(Routes.channelPins(channelId));
}
async function sendChannelTyping(rest, channelId) {
	await rest.post(Routes.channelTyping(channelId));
}
async function createThread(rest, channelId, data, messageId) {
	const route = messageId ? Routes.threads(channelId, messageId) : Routes.threads(channelId);
	return await rest.post(route, data);
}
async function listChannelArchivedThreads(rest, channelId, query) {
	return await rest.get(Routes.channelThreads(channelId, "public"), query);
}
async function searchGuildMessages(rest, guildId, params) {
	return await rest.get(`/guilds/${guildId}/messages/search?${params.toString()}`);
}
//#endregion
//#region extensions/discord/src/internal/api.reactions.ts
async function createOwnMessageReaction(rest, channelId, messageId, encodedEmoji) {
	await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}
async function deleteOwnMessageReaction(rest, channelId, messageId, encodedEmoji) {
	await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}
async function listMessageReactionUsers(rest, channelId, messageId, encodedEmoji, query) {
	return await rest.get(Routes.channelMessageReaction(channelId, messageId, encodedEmoji), query);
}
//#endregion
//#region extensions/discord/src/internal/api.users.ts
async function getCurrentUser(rest) {
	return await rest.get(Routes.user("@me"));
}
async function getUser(rest, userId) {
	return await rest.get(Routes.user(userId));
}
async function createUserDmChannel(rest, recipientId) {
	return await rest.post(Routes.userChannels(), { body: { recipient_id: recipientId } });
}
//#endregion
//#region extensions/discord/src/internal/api.webhooks.ts
async function createChannelWebhook(rest, channelId, data) {
	return await rest.post(Routes.channelWebhooks(channelId), data);
}
//#endregion
//#region extensions/discord/src/internal/command-deploy.ts
var DiscordCommandDeployer = class {
	constructor(params) {
		this.params = params;
		this.hashes = /* @__PURE__ */ new Map();
		this.hashesLoaded = false;
	}
	async getCommands() {
		return await listApplicationCommands(this.rest, this.params.clientId);
	}
	async deploy(options = {}) {
		const commands = this.params.commands.filter((command) => command.name !== "*");
		const serializedGlobal = commands.filter((command) => !command.guildIds).map((command) => command.serialize());
		for (const [guildId, entries] of groupGuildCommands(commands)) await this.putCommandSetIfChanged(`guild:${guildId}`, entries, async () => {
			await overwriteGuildApplicationCommands(this.rest, this.params.clientId, guildId, entries);
		}, options);
		if (this.params.devGuilds?.length) {
			for (const guildId of this.params.devGuilds) {
				const entries = commands.map((command) => command.serialize());
				await this.putCommandSetIfChanged(`dev-guild:${guildId}`, entries, async () => {
					await overwriteGuildApplicationCommands(this.rest, this.params.clientId, guildId, entries);
				}, options);
			}
			return {
				mode: options.mode ?? "reconcile",
				usedDevGuilds: true
			};
		}
		if (options.mode !== "overwrite") {
			await this.putCommandSetIfChanged("global:reconcile", serializedGlobal, async () => {
				await this.reconcileGlobalCommands(serializedGlobal);
			}, options);
			return {
				mode: "reconcile",
				usedDevGuilds: false
			};
		}
		await this.putCommandSetIfChanged("global:overwrite", serializedGlobal, async () => {
			await overwriteApplicationCommands(this.rest, this.params.clientId, serializedGlobal);
		}, options);
		return {
			mode: "overwrite",
			usedDevGuilds: false
		};
	}
	async reconcileGlobalCommands(desired) {
		const existing = await this.getCommands();
		const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
		const desiredKeys = /* @__PURE__ */ new Set();
		for (const command of desired) {
			const key = stableCommandKey(command);
			desiredKeys.add(key);
			const current = existingByKey.get(key);
			if (!current) {
				await createApplicationCommand(this.rest, this.params.clientId, command);
				continue;
			}
			if (!commandsEqual(current, command)) await editApplicationCommand(this.rest, this.params.clientId, current.id, command);
		}
		for (const command of existing) if (!desiredKeys.has(stableCommandKey(command))) await deleteApplicationCommand(this.rest, this.params.clientId, command.id);
	}
	async putCommandSetIfChanged(key, commands, deploy, options) {
		const hash = stableCommandSetHash(commands);
		await this.loadPersistedHashes();
		if (!options.force && this.hashes.get(key) === hash) return;
		await deploy();
		this.hashes.set(key, hash);
		await this.persistHashes();
	}
	async loadPersistedHashes() {
		if (this.hashesLoaded) return;
		this.hashesLoaded = true;
		const storePath = this.params.hashStorePath;
		if (!storePath) return;
		try {
			const raw = await fs.readFile(storePath, "utf8");
			const parsed = JSON.parse(raw);
			if (!parsed.hashes || typeof parsed.hashes !== "object") return;
			for (const [key, value] of Object.entries(parsed.hashes)) if (typeof value === "string" && key.trim() && value.trim()) this.hashes.set(key, value);
		} catch {}
	}
	async persistHashes() {
		const storePath = this.params.hashStorePath;
		if (!storePath) return;
		try {
			await fs.mkdir(path.dirname(storePath), { recursive: true });
			const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.writeFile(tmpPath, `${JSON.stringify({
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				hashes: Object.fromEntries([...this.hashes.entries()].toSorted(([left], [right]) => left.localeCompare(right)))
			}, null, 2)}\n`, "utf8");
			await fs.rename(tmpPath, storePath);
		} catch {}
	}
	get rest() {
		return this.params.rest();
	}
};
function groupGuildCommands(commands) {
	const guildCommands = /* @__PURE__ */ new Map();
	for (const command of commands.filter((entry) => entry.guildIds)) for (const guildId of command.guildIds ?? []) {
		const entries = guildCommands.get(guildId) ?? [];
		entries.push(command.serialize());
		guildCommands.set(guildId, entries);
	}
	return guildCommands;
}
function stableCommandKey(command) {
	return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}
function comparableCommand(value) {
	if (!value || typeof value !== "object") return value;
	const omit = new Set([
		"application_id",
		"description_localized",
		"dm_permission",
		"guild_id",
		"id",
		"name_localized",
		"nsfw",
		"version",
		"default_permission"
	]);
	return stableComparableObject(Object.fromEntries(Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== void 0)));
}
const unorderedCommandArrayFields = new Set([
	"channel_types",
	"contexts",
	"integration_types"
]);
const optionComparisonOmittedFields = new Set([
	"contexts",
	"default_member_permissions",
	"description_localized",
	"integration_types",
	"name_localized"
]);
const nullableLocalizationFields = new Set(["description_localizations", "name_localizations"]);
function stableComparableObject(value, path = []) {
	if (Array.isArray(value)) {
		const normalized = value.map((entry) => stableComparableObject(entry, path));
		const key = path.at(-1);
		if (key && unorderedCommandArrayFields.has(key) && normalized.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) return normalized.toSorted((left, right) => String(left).localeCompare(String(right)));
		return normalized;
	}
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).filter(([key, entry]) => {
		if (entry === void 0) return false;
		if (entry === null && nullableLocalizationFields.has(key)) return false;
		if (path.includes("options") && optionComparisonOmittedFields.has(key)) return false;
		if ((key === "required" || key === "autocomplete") && entry === false) return false;
		return true;
	}).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, shouldNormalizeDescriptionValue(path, key, entry) ? normalizeDescriptionForComparison(entry) : stableComparableObject(entry, [...path, key])]));
}
function shouldNormalizeDescriptionValue(path, key, entry) {
	return typeof entry === "string" && (key === "description" || path.at(-1) === "description_localizations");
}
/**
* Normalize a Discord command description for equality comparison.
*
* Discord's server-side storage performs two transformations that our local
* desired descriptors do not:
*
* 1. Consecutive whitespace (including `\n`) is collapsed to a single space.
* 2. Whitespace between two CJK (Chinese, Japanese, Korean) characters is
*    removed entirely. So a local description `"第一行。\n第二行。"` is stored
*    as `"第一行。第二行。"` on Discord and returned without the `\n`.
*
* Without this normalization every startup for any CJK-heavy deployment reads
* back Discord's collapsed form, computes a diff against the local `\n`-form,
* decides the command needs updating, and issues a `PATCH`. Under the global
* per-application rate limit this quickly produces 429 bursts and some
* commands silently fail to register (see the Discord deploy 429 reports).
*
* Applying the same transformation to both sides before comparison makes the
* equality check match Discord's storage semantics and prevents spurious
* reconcile writes on every startup.
*/
function normalizeDescriptionForComparison(description) {
	const collapsed = description.replace(/\s+/g, " ");
	const cjkBoundaryWhitespace = /([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g;
	return collapsed.replace(cjkBoundaryWhitespace, "$1$2").replace(cjkBoundaryWhitespace, "$1$2").trim();
}
function commandsEqual(a, b) {
	return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
}
function stableCommandSetHash(commands) {
	const stable = commands.map((command) => stableComparableObject(command)).toSorted((a, b) => stableCommandKey(a).localeCompare(stableCommandKey(b)));
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
//#endregion
//#region extensions/discord/src/internal/components.base.ts
function parseCustomId(id) {
	const [rawKey, ...parts] = id.split(";");
	const [keyPart, firstValue] = rawKey.split("=");
	const key = keyPart.includes(":") ? keyPart.split(":")[0] : keyPart;
	const data = {};
	const entries = firstValue === void 0 ? parts : [rawKey.slice(key.length + 1), ...parts];
	for (const entry of entries) {
		const index = entry.indexOf("=");
		if (index < 0) continue;
		const name = entry.slice(0, index).replace(/^[^:]+:/, "");
		const raw = entry.slice(index + 1);
		data[name] = raw === "true" ? true : raw === "false" ? false : raw;
	}
	return {
		key,
		data
	};
}
function clean$3(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function colorToNumber(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.replace(/^#/, ""), 16);
}
var BaseComponent = class {
	constructor() {
		this.isV2 = false;
	}
};
var BaseMessageInteractiveComponent = class extends BaseComponent {
	constructor(..._args) {
		super(..._args);
		this.isV2 = false;
		this.defer = false;
		this.ephemeral = false;
		this.customIdParser = parseCustomId;
	}
	run(_interaction, _data) {}
};
var BaseModalComponent = class extends BaseComponent {};
//#endregion
//#region extensions/discord/src/internal/components.message.ts
var BaseButton = class extends BaseMessageInteractiveComponent {
	constructor(..._args) {
		super(..._args);
		this.type = ComponentType.Button;
		this.style = ButtonStyle.Primary;
		this.disabled = false;
	}
};
var Button = class extends BaseButton {
	serialize() {
		return clean$3({
			type: this.type,
			style: this.style,
			custom_id: this.customId,
			label: this.label,
			emoji: this.emoji,
			disabled: this.disabled || void 0
		});
	}
};
var LinkButton = class extends BaseButton {
	constructor(..._args2) {
		super(..._args2);
		this.customId = "";
		this.style = ButtonStyle.Link;
	}
	async run() {
		throw new Error("Link buttons do not run handlers");
	}
	serialize() {
		return clean$3({
			type: this.type,
			style: this.style,
			label: this.label,
			emoji: this.emoji,
			disabled: this.disabled || void 0,
			url: this.url
		});
	}
};
var AnySelectMenu = class extends BaseMessageInteractiveComponent {
	constructor(..._args3) {
		super(..._args3);
		this.disabled = false;
	}
	serialize() {
		return clean$3({
			...this.serializeOptions(),
			custom_id: this.customId,
			placeholder: this.placeholder,
			min_values: this.minValues,
			max_values: this.maxValues,
			disabled: this.disabled || void 0,
			required: this.required
		});
	}
};
var StringSelectMenu = class extends AnySelectMenu {
	constructor(..._args4) {
		super(..._args4);
		this.type = ComponentType.StringSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			options: this.options
		};
	}
};
var UserSelectMenu = class extends AnySelectMenu {
	constructor(..._args5) {
		super(..._args5);
		this.type = ComponentType.UserSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var RoleSelectMenu = class extends AnySelectMenu {
	constructor(..._args6) {
		super(..._args6);
		this.type = ComponentType.RoleSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var MentionableSelectMenu = class extends AnySelectMenu {
	constructor(..._args7) {
		super(..._args7);
		this.type = ComponentType.MentionableSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues
		};
	}
};
var ChannelSelectMenu = class extends AnySelectMenu {
	constructor(..._args8) {
		super(..._args8);
		this.type = ComponentType.ChannelSelect;
	}
	serializeOptions() {
		return {
			type: this.type,
			default_values: this.defaultValues,
			channel_types: this.channelTypes
		};
	}
};
var Row = class extends BaseComponent {
	constructor(components = []) {
		super();
		this.type = ComponentType.ActionRow;
		this.isV2 = false;
		this.components = components;
	}
	addComponent(component) {
		this.components.push(component);
	}
	removeComponent(component) {
		this.components = this.components.filter((entry) => entry !== component);
	}
	removeAllComponents() {
		this.components = [];
	}
	serialize() {
		return {
			type: this.type,
			components: this.components.map((entry) => entry.serialize())
		};
	}
};
var TextDisplay = class extends BaseComponent {
	constructor(content) {
		super();
		this.content = content;
		this.type = ComponentType.TextDisplay;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			content: this.content
		});
	}
};
var Separator = class extends BaseComponent {
	constructor(options) {
		super();
		this.type = ComponentType.Separator;
		this.isV2 = true;
		this.divider = true;
		this.spacing = "small";
		this.spacing = options?.spacing ?? this.spacing;
		this.divider = options?.divider ?? this.divider;
	}
	serialize() {
		return clean$3({
			type: this.type,
			divider: this.divider,
			spacing: this.spacing === "large" ? 2 : this.spacing === "small" ? 1 : this.spacing
		});
	}
};
var Thumbnail = class extends BaseComponent {
	constructor(url) {
		super();
		this.url = url;
		this.type = ComponentType.Thumbnail;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			media: this.url ? { url: this.url } : void 0
		});
	}
};
var Section = class extends BaseComponent {
	constructor(components = [], accessory) {
		super();
		this.components = components;
		this.accessory = accessory;
		this.type = ComponentType.Section;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			components: this.components.map((entry) => entry.serialize()),
			accessory: this.accessory?.serialize()
		});
	}
};
var MediaGallery = class extends BaseComponent {
	constructor(items = []) {
		super();
		this.items = items;
		this.type = ComponentType.MediaGallery;
		this.isV2 = true;
	}
	serialize() {
		return {
			type: this.type,
			items: this.items.map((entry) => ({
				media: { url: entry.url },
				description: entry.description,
				spoiler: entry.spoiler
			}))
		};
	}
};
var File = class extends BaseComponent {
	constructor(file, spoiler = false) {
		super();
		this.file = file;
		this.spoiler = spoiler;
		this.type = ComponentType.File;
		this.isV2 = true;
	}
	serialize() {
		return clean$3({
			type: this.type,
			file: this.file ? { url: this.file } : void 0,
			spoiler: this.spoiler || void 0
		});
	}
};
var Container = class extends BaseComponent {
	constructor(components = [], options) {
		super();
		this.type = ComponentType.Container;
		this.isV2 = true;
		this.spoiler = false;
		this.components = components;
		this.accentColor = options?.accentColor;
		this.spoiler = options?.spoiler ?? false;
	}
	serialize() {
		return clean$3({
			type: this.type,
			components: this.components.map((entry) => entry.serialize()),
			accent_color: colorToNumber(this.accentColor),
			spoiler: this.spoiler || void 0
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/components.modal.ts
var TextInput = class extends BaseModalComponent {
	constructor(..._args) {
		super(..._args);
		this.type = ComponentType.TextInput;
		this.customIdParser = parseCustomId;
		this.style = TextInputStyle.Short;
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			style: this.style,
			min_length: this.minLength,
			max_length: this.maxLength,
			required: this.required,
			value: this.value,
			placeholder: this.placeholder
		});
	}
};
var CheckboxGroup = class extends BaseModalComponent {
	constructor(..._args2) {
		super(..._args2);
		this.type = 22;
		this.options = [];
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			options: this.options,
			required: this.required,
			min_values: this.minValues,
			max_values: this.maxValues
		});
	}
};
var RadioGroup = class extends BaseModalComponent {
	constructor(..._args3) {
		super(..._args3);
		this.type = 21;
		this.options = [];
	}
	serialize() {
		return clean$3({
			type: this.type,
			custom_id: this.customId,
			options: this.options,
			required: this.required,
			min_values: this.minValues,
			max_values: this.maxValues
		});
	}
};
var Label = class extends BaseModalComponent {
	constructor(component) {
		super();
		this.component = component;
		this.type = ComponentType.Label;
		this.customId = "";
	}
	serialize() {
		return clean$3({
			type: this.type,
			label: this.label,
			description: this.description,
			component: this.component?.serialize()
		});
	}
};
var Modal = class {
	constructor() {
		this.components = [];
		this.customIdParser = parseCustomId;
	}
	serialize() {
		return {
			title: this.title,
			custom_id: this.customId,
			components: this.components.map((entry) => entry.serialize())
		};
	}
};
//#endregion
//#region extensions/discord/src/internal/payload.ts
function clean$2(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function serializeAnyComponent(component) {
	return component.serialize();
}
function payloadHasV2Components(payload) {
	return Boolean(payload.components?.some((component) => component.isV2));
}
function normalizePayloadFlags(payload) {
	const flags = payload.ephemeral ? (payload.flags ?? 0) | MessageFlags.Ephemeral : payload.flags;
	if (!payloadHasV2Components(payload)) return flags;
	if (payload.content || payload.embeds?.length) throw new Error("Discord Components V2 payloads cannot include content or embeds");
	return (flags ?? 0) | MessageFlags.IsComponentsV2;
}
function serializePayload(payload) {
	if (typeof payload === "string") return { content: payload };
	const flags = normalizePayloadFlags(payload);
	return clean$2({
		content: payload.content,
		embeds: payload.embeds?.map((entry) => "serialize" in entry ? entry.serialize() : entry),
		components: payload.components?.map((entry) => serializeAnyComponent(entry)),
		allowed_mentions: payload.allowed_mentions ?? payload.allowedMentions,
		flags,
		tts: payload.tts,
		files: payload.files,
		poll: payload.poll,
		sticker_ids: payload.stickers
	});
}
//#endregion
//#region extensions/discord/src/internal/structures.ts
var Base = class {
	constructor(client) {
		this.client = client;
	}
};
var User = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get rawData() {
		if (!this._rawData) throw new Error("Partial Discord user has no raw data");
		return this._rawData;
	}
	get partial() {
		return this._rawData === null;
	}
	get username() {
		return this._rawData?.username ?? "";
	}
	get globalName() {
		return this._rawData?.global_name;
	}
	get discriminator() {
		return this._rawData?.discriminator;
	}
	get bot() {
		return this._rawData?.bot;
	}
	get avatar() {
		return this._rawData?.avatar;
	}
	get avatarUrl() {
		return this.avatar ? `https://cdn.discordapp.com/avatars/${this.id}/${this.avatar}.png` : null;
	}
	toString() {
		return `<@${this.id}>`;
	}
	async fetch() {
		return this.client.fetchUser(this.id);
	}
	async createDm() {
		return await createUserDmChannel(this.client.rest, this.id);
	}
	async send(data) {
		const dm = await this.createDm();
		const message = await createChannelMessage(this.client.rest, dm.id, { body: serializePayload(data) });
		return new Message(this.client, message);
	}
};
var Role = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get name() {
		return this._rawData?.name ?? "";
	}
};
var Guild = class extends Base {
	constructor(client, rawDataOrId) {
		super(client);
		this._rawData = typeof rawDataOrId === "string" ? null : rawDataOrId;
		this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
	}
	get name() {
		return this._rawData?.name ?? "";
	}
};
var GuildMember = class extends Base {
	constructor(client, rawData) {
		super(client);
		this.rawData = rawData;
	}
	get user() {
		return this.rawData.user ? new User(this.client, this.rawData.user) : null;
	}
	get roles() {
		return this.rawData.roles ?? [];
	}
	get nickname() {
		return this.rawData.nick ?? void 0;
	}
};
var Message = class Message extends Base {
	constructor(client, rawDataOrIds) {
		super(client);
		this._rawData = typeof rawDataOrIds === "string" || !("author" in rawDataOrIds) ? null : rawDataOrIds;
		this.id = typeof rawDataOrIds === "string" ? rawDataOrIds : rawDataOrIds.id;
		this.channelId = typeof rawDataOrIds === "string" ? "" : "channel_id" in rawDataOrIds ? rawDataOrIds.channel_id : rawDataOrIds.channelId ?? "";
	}
	get rawData() {
		if (!this._rawData) throw new Error("Partial Discord message has no raw data");
		return this._rawData;
	}
	get partial() {
		return this._rawData === null;
	}
	get message() {
		return this;
	}
	get channel_id() {
		return this.channelId;
	}
	get guild_id() {
		return this._rawData?.guild_id;
	}
	get guild() {
		return this.guild_id ? new Guild(this.client, this.guild_id) : null;
	}
	get webhookId() {
		return this.webhook_id;
	}
	get webhook_id() {
		return this._rawData?.webhook_id ?? null;
	}
	get member() {
		const member = this._rawData?.member;
		return member ? new GuildMember(this.client, member) : null;
	}
	get rawMember() {
		return this._rawData?.member;
	}
	get content() {
		return this._rawData?.content ?? "";
	}
	get author() {
		return this._rawData?.author ? new User(this.client, this._rawData.author) : null;
	}
	get embeds() {
		return this._rawData?.embeds ?? [];
	}
	get attachments() {
		return this._rawData?.attachments ?? [];
	}
	get stickers() {
		return this._rawData?.sticker_items ?? [];
	}
	get mentionedUsers() {
		return (this._rawData?.mentions ?? []).map((user) => new User(this.client, user));
	}
	get mentionedRoles() {
		return this._rawData?.mention_roles ?? [];
	}
	get mentionedEveryone() {
		return this._rawData?.mention_everyone ?? false;
	}
	get timestamp() {
		return this._rawData?.timestamp;
	}
	get type() {
		return this._rawData?.type;
	}
	get messageReference() {
		return this._rawData?.message_reference;
	}
	get referencedMessage() {
		return this._rawData?.referenced_message ? new Message(this.client, this._rawData.referenced_message) : null;
	}
	get thread() {
		return this._rawData?.thread ? channelFactory(this.client, this._rawData.thread) : null;
	}
	async fetch() {
		const raw = await getChannelMessage(this.client.rest, this.channelId, this.id);
		return new Message(this.client, raw);
	}
	async delete() {
		await deleteChannelMessage(this.client.rest, this.channelId, this.id);
	}
	async edit(data) {
		const raw = await editChannelMessage(this.client.rest, this.channelId, this.id, { body: serializePayload(data) });
		return new Message(this.client, raw);
	}
	async reply(data) {
		const raw = await createChannelMessage(this.client.rest, this.channelId, { body: {
			...serializePayload(data),
			message_reference: {
				message_id: this.id,
				fail_if_not_exists: false
			}
		} });
		return new Message(this.client, raw);
	}
	async pin() {
		await pinChannelMessage(this.client.rest, this.channelId, this.id);
	}
	async unpin() {
		await unpinChannelMessage(this.client.rest, this.channelId, this.id);
	}
};
function channelFactory(_client, channelData, _partial) {
	return {
		...channelData,
		rawData: channelData,
		guildId: "guild_id" in channelData ? channelData.guild_id : void 0,
		guild: "guild_id" in channelData && typeof channelData.guild_id === "string" ? new Guild(_client, channelData.guild_id) : void 0,
		parentId: "parent_id" in channelData ? channelData.parent_id : void 0,
		ownerId: "owner_id" in channelData ? channelData.owner_id : void 0
	};
}
//#endregion
//#region extensions/discord/src/internal/entity-cache.ts
const DEFAULT_REST_CACHE_TTL_MS = 3e4;
var DiscordEntityCache = class {
	constructor(params) {
		this.params = params;
		this.entries = /* @__PURE__ */ new Map();
	}
	async fetchUser(id) {
		return await this.fetchCached(`user:${id}`, async () => {
			const raw = await getUser(this.rest, id);
			return new User(this.params.client, raw);
		});
	}
	async fetchChannel(id) {
		return await this.fetchCached(`channel:${id}`, async () => {
			const raw = await getChannel(this.rest, id);
			return channelFactory(this.params.client, raw);
		});
	}
	async fetchGuild(id) {
		return await this.fetchCached(`guild:${id}`, async () => {
			const raw = await getGuild(this.rest, id);
			return new Guild(this.params.client, raw);
		});
	}
	async fetchMember(guildId, userId) {
		return await this.fetchCached(`member:${guildId}:${userId}`, async () => {
			const raw = await getGuildMember(this.rest, guildId, userId);
			return new GuildMember(this.params.client, raw);
		});
	}
	invalidateForGatewayEvent(type, data) {
		const raw = data && typeof data === "object" ? data : {};
		const channelUpdate = GatewayDispatchEvents.ChannelUpdate;
		const channelDelete = GatewayDispatchEvents.ChannelDelete;
		const guildUpdate = GatewayDispatchEvents.GuildUpdate;
		const guildMemberUpdate = GatewayDispatchEvents.GuildMemberUpdate;
		if (type === channelUpdate || type === channelDelete) this.deleteId("channel", raw.id);
		if (type === guildUpdate) this.deleteId("guild", raw.id);
		if (type === guildMemberUpdate) {
			const guildId = raw.guild_id;
			const user = raw.user && typeof raw.user === "object" ? raw.user : {};
			if (typeof guildId === "string" && typeof user.id === "string") {
				this.entries.delete(`member:${guildId}:${user.id}`);
				this.entries.delete(`user:${user.id}`);
			}
		}
	}
	deleteId(prefix, id) {
		if (typeof id === "string") this.entries.delete(`${prefix}:${id}`);
	}
	async fetchCached(key, fetcher) {
		const ttl = this.params.ttlMs ?? DEFAULT_REST_CACHE_TTL_MS;
		if (ttl > 0) {
			const cached = this.entries.get(key);
			if (cached && cached.expiresAt > Date.now()) return cached.value;
		}
		const value = await fetcher();
		if (ttl > 0) this.entries.set(key, {
			expiresAt: Date.now() + ttl,
			value
		});
		return value;
	}
	get rest() {
		return typeof this.params.rest === "function" ? this.params.rest() : this.params.rest;
	}
};
//#endregion
//#region extensions/discord/src/internal/event-queue.ts
const DEFAULT_MAX_QUEUE_SIZE = 1e4;
const DEFAULT_MAX_CONCURRENCY = 50;
const DEFAULT_LISTENER_TIMEOUT_MS = 12e4;
const DEFAULT_SLOW_LISTENER_THRESHOLD_MS = 3e4;
var DiscordEventQueue = class {
	constructor(options = {}) {
		this.queue = [];
		this.processing = 0;
		this.processedCount = 0;
		this.droppedCount = 0;
		this.timeoutCount = 0;
		this.options = {
			maxQueueSize: normalizePositiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
			maxConcurrency: normalizePositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
			listenerTimeout: normalizePositiveInteger(options.listenerTimeout, DEFAULT_LISTENER_TIMEOUT_MS),
			slowListenerThreshold: normalizePositiveInteger(options.slowListenerThreshold, DEFAULT_SLOW_LISTENER_THRESHOLD_MS)
		};
	}
	enqueue(params) {
		if (this.queue.length >= this.options.maxQueueSize) {
			this.droppedCount += 1;
			return Promise.reject(/* @__PURE__ */ new Error(`Discord event queue is full for ${params.eventType}; maxQueueSize=${this.options.maxQueueSize}`));
		}
		return new Promise((resolve, reject) => {
			this.queue.push({
				...params,
				resolve,
				reject
			});
			this.processNext();
		});
	}
	getMetrics() {
		return {
			queueSize: this.queue.length,
			processing: this.processing,
			processed: this.processedCount,
			dropped: this.droppedCount,
			timeouts: this.timeoutCount,
			maxQueueSize: this.options.maxQueueSize,
			maxConcurrency: this.options.maxConcurrency
		};
	}
	processNext() {
		while (this.processing < this.options.maxConcurrency && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) return;
			this.processing += 1;
			this.runJob(job).then(job.resolve, job.reject).finally(() => {
				this.processing -= 1;
				this.processedCount += 1;
				this.processNext();
			});
		}
	}
	async runJob(job) {
		const startedAt = Date.now();
		try {
			await this.runWithTimeout(job);
			this.logSlowListener(job, Date.now() - startedAt);
		} catch (error) {
			if (isListenerTimeoutError(error)) {
				this.timeoutCount += 1;
				console.error(`[EventQueue] Listener ${job.listenerName} timed out after ${this.options.listenerTimeout}ms for event ${job.eventType}`);
				return;
			}
			console.error(`[EventQueue] Listener ${job.listenerName} failed for event ${job.eventType}:`, error);
		}
	}
	async runWithTimeout(job) {
		let timeout;
		try {
			await Promise.race([job.run(), new Promise((_, reject) => {
				timeout = setTimeout(() => {
					reject(createListenerTimeoutError(this.options.listenerTimeout));
				}, this.options.listenerTimeout);
				timeout.unref?.();
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	logSlowListener(job, durationMs) {
		if (durationMs < this.options.slowListenerThreshold) return;
		console.warn(`[EventQueue] Slow listener detected: ${job.listenerName} took ${durationMs}ms for event ${job.eventType}`);
	}
};
function normalizePositiveInteger(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}
function createListenerTimeoutError(timeoutMs) {
	const error = /* @__PURE__ */ new Error(`Listener timeout after ${timeoutMs}ms`);
	error.name = "DiscordEventQueueListenerTimeoutError";
	return error;
}
function isListenerTimeoutError(error) {
	return error instanceof Error && error.name === "DiscordEventQueueListenerTimeoutError";
}
//#endregion
//#region extensions/discord/src/internal/commands.ts
function clean$1(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
function resolveConditionalCommandOption(value, interaction) {
	return typeof value === "function" ? value(interaction) : value;
}
async function deferCommandInteractionIfNeeded(command, interaction) {
	if (!resolveConditionalCommandOption(command.defer, interaction)) return;
	await interaction.defer({ ephemeral: resolveConditionalCommandOption(command.ephemeral, interaction) });
}
function readRawCommandOptions(interaction) {
	const options = interaction.rawData.data?.options;
	return Array.isArray(options) ? options : [];
}
function findSelectedSubcommand(subcommands, interaction) {
	const subcommandName = readRawCommandOptions(interaction).find((option) => option.type === ApplicationCommandOptionType.Subcommand)?.name;
	return typeof subcommandName === "string" ? subcommands.find((command) => command.name === subcommandName) : void 0;
}
function findCommandOption(options, name) {
	if (!name) return;
	return options?.find((option) => option.name === name);
}
function hasCommandOptions(command) {
	return "options" in command;
}
function resolveFocusedCommandOptionAutocompleteHandler(command, interaction) {
	const focusedName = interaction.options.getFocused()?.name;
	const autocomplete = findCommandOption("subcommands" in command && Array.isArray(command.subcommands) ? findSelectedSubcommand(command.subcommands, interaction)?.options : hasCommandOptions(command) ? command.options : void 0, focusedName)?.autocomplete;
	return typeof autocomplete === "function" ? autocomplete : void 0;
}
var BaseCommand = class {
	constructor() {
		this.defer = false;
		this.ephemeral = false;
		this.integrationTypes = [0, 1];
		this.contexts = [
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel
		];
	}
	serialize() {
		return clean$1({
			name: this.name,
			name_localizations: this.nameLocalizations,
			description: this.type === ApplicationCommandType.ChatInput ? this.description ?? "" : void 0,
			description_localizations: this.descriptionLocalizations,
			type: this.type,
			options: this.serializeOptions(),
			integration_types: this.integrationTypes,
			contexts: this.contexts,
			default_member_permissions: Array.isArray(this.permission) ? this.permission.reduce((sum, entry) => sum | entry, 0n).toString() : this.permission ? this.permission.toString() : null
		});
	}
};
var Command = class extends BaseCommand {
	constructor(..._args) {
		super(..._args);
		this.type = ApplicationCommandType.ChatInput;
	}
	async autocomplete(interaction) {
		throw new Error(`The ${interaction.rawData?.data?.name ?? this.name} command does not support autocomplete`);
	}
	async preCheck(interaction) {
		return Boolean(interaction) || true;
	}
	serializeOptions() {
		return this.options?.map((option) => {
			if (typeof option.autocomplete === "function") {
				const { autocomplete: _autocomplete, ...rest } = option;
				return {
					...rest,
					autocomplete: true
				};
			}
			return option;
		});
	}
};
var CommandWithSubcommands = class extends BaseCommand {
	constructor(..._args2) {
		super(..._args2);
		this.type = ApplicationCommandType.ChatInput;
	}
	async run(interaction) {
		const subcommand = findSelectedSubcommand(this.subcommands, interaction);
		if (!subcommand) {
			const subcommandName = readRawCommandOptions(interaction).find((option) => option.type === ApplicationCommandOptionType.Subcommand)?.name;
			throw new Error(`Unknown Discord subcommand: ${typeof subcommandName === "string" ? subcommandName : "<missing>"}`);
		}
		await deferCommandInteractionIfNeeded(subcommand, interaction);
		return await subcommand.run(interaction);
	}
	serializeOptions() {
		return this.subcommands.map((command) => clean$1({
			name: command.name,
			name_localizations: command.nameLocalizations,
			description: command.description ?? "",
			description_localizations: command.descriptionLocalizations,
			type: ApplicationCommandOptionType.Subcommand,
			options: command.serializeOptions()
		}));
	}
};
//#endregion
//#region extensions/discord/src/internal/interaction-options.ts
function readFocusedOption(options) {
	for (const option of options ?? []) {
		if ("focused" in option && option.focused) return option;
		const child = readFocusedOption(readChildOptions(option));
		if (child) return child;
	}
}
function findOption(options, name) {
	for (const option of options ?? []) {
		if (option.name === name) return option;
		const child = findOption(readChildOptions(option), name);
		if (child) return child;
	}
}
function readChildOptions(option) {
	if (!("options" in option) || !Array.isArray(option.options)) return;
	return option.options;
}
var OptionsHandler = class {
	constructor(rawOptions, client, resolvedChannels) {
		this.rawOptions = rawOptions;
		this.client = client;
		this.resolvedChannels = resolvedChannels;
	}
	getString(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "string" ? value : null;
	}
	getNumber(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "number" ? value : null;
	}
	getBoolean(name) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		return typeof value === "boolean" ? value : null;
	}
	async getChannel(name, required = false) {
		const option = findOption(this.rawOptions, name);
		const value = option && "value" in option ? option.value : void 0;
		const id = typeof value === "string" ? value : void 0;
		const resolved = id ? this.resolvedChannels?.[id] : void 0;
		if (resolved) return channelFactory(this.client, resolved);
		if (id) return await this.client.fetchChannel(id);
		if (required) throw new Error(`Missing required channel option ${name}`);
		return null;
	}
	getFocused() {
		return readFocusedOption(this.rawOptions);
	}
};
//#endregion
//#region extensions/discord/src/internal/interaction-response.ts
var InteractionResponseController = class {
	constructor() {
		this.state = "unacknowledged";
	}
	get acknowledged() {
		return this.state !== "unacknowledged";
	}
	recordCallback(type) {
		if (type === InteractionResponseType.DeferredChannelMessageWithSource) {
			this.state = "deferred";
			return;
		}
		if (type === InteractionResponseType.DeferredMessageUpdate) {
			this.state = "deferred-update";
			return;
		}
		this.state = "replied";
	}
	nextReplyAction() {
		if (this.state === "deferred" || this.state === "deferred-update") return "edit";
		if (this.state === "unacknowledged") return "initial";
		return "follow-up";
	}
	recordReplyEdit() {
		this.state = "replied";
	}
};
function needsComponentsV2Query(body) {
	return body !== null && typeof body === "object" && "flags" in body && typeof body.flags === "number" && (body.flags & MessageFlags.IsComponentsV2) !== 0;
}
//#endregion
//#region extensions/discord/src/internal/modal-fields.ts
function extractModalFields(components) {
	const out = {};
	for (const component of flattenModalComponents(components)) {
		const raw = component;
		if (typeof raw.custom_id !== "string") continue;
		if (Array.isArray(raw.values)) out[raw.custom_id] = raw.values.map(String);
		else if (typeof raw.value === "string" || typeof raw.value === "number" || typeof raw.value === "boolean") out[raw.custom_id] = String(raw.value);
	}
	return out;
}
function flattenModalComponents(components) {
	const out = [];
	for (const entry of components) {
		if (!entry || typeof entry !== "object") continue;
		const component = entry;
		if (component.component && typeof component.component === "object") out.push(component.component);
		if (Array.isArray(component.components)) out.push(...flattenModalComponents(component.components));
		out.push(entry);
	}
	return out;
}
var ModalFields = class {
	constructor(values, resolved, client) {
		this.values = values;
		this.resolved = resolved;
		this.client = client;
	}
	value(id, required) {
		const value = this.values[id];
		if (required && (value === void 0 || Array.isArray(value) && value.length === 0)) throw new Error(`Missing required modal field ${id}`);
		return value;
	}
	getText(id, required = false) {
		const value = this.value(id, required);
		return typeof value === "string" ? value : null;
	}
	getStringSelect(id, required = false) {
		const value = this.value(id, required);
		if (Array.isArray(value)) return value;
		return typeof value === "string" ? [value] : [];
	}
	getRoleSelect(id, required = false) {
		return this.getStringSelect(id, required).map((roleId) => {
			const raw = this.resolved?.roles?.[roleId];
			return raw ? new Role(this.client, {
				id: roleId,
				name: raw.name ?? ""
			}) : new Role(this.client, roleId);
		});
	}
	getUserSelect(id, required = false) {
		return this.getStringSelect(id, required).map((userId) => {
			const raw = this.resolved?.users?.[userId];
			return new User(this.client, {
				id: userId,
				username: raw?.username ?? ""
			});
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/schemas.ts
const discordInteractionPayloadSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	token: Type.String({ minLength: 1 }),
	type: Type.Number()
}, { additionalProperties: true });
const discordRateLimitBodySchema = Type.Object({
	message: Type.Optional(Type.String()),
	retry_after: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	global: Type.Optional(Type.Boolean()),
	code: Type.Optional(Type.Union([Type.Number(), Type.String()]))
}, { additionalProperties: true });
function assertDiscordInteractionPayload(value) {
	if (!Check(discordInteractionPayloadSchema, value)) throw new Error("Invalid Discord interaction payload");
}
function isDiscordRateLimitBody(value) {
	return Check(discordRateLimitBodySchema, value);
}
//#endregion
//#region extensions/discord/src/internal/interactions.ts
function toCommandRawInteraction(rawData) {
	return rawData;
}
function toMessageComponentRawInteraction(rawData) {
	return rawData;
}
function toModalSubmitRawInteraction(rawData) {
	return rawData;
}
function readInteractionUser(rawData, client) {
	const directUser = "user" in rawData ? rawData.user : void 0;
	if (directUser && typeof directUser === "object" && "id" in directUser) return new User(client, directUser);
	const memberUser = rawData.member?.user;
	if (memberUser && typeof memberUser === "object" && typeof memberUser.id === "string") {
		const user = { ...memberUser };
		if (typeof user.username !== "string") user.username = "";
		return new User(client, user);
	}
	return null;
}
var BaseInteraction = class {
	constructor(client, rawData) {
		this.client = client;
		this.rawData = rawData;
		this.message = null;
		this.response = new InteractionResponseController();
		this.id = rawData.id;
		this.token = rawData.token;
		this.user = readInteractionUser(rawData, client);
		this.userId = this.user?.id ?? "";
		this.guild = rawData.guild_id ? new Guild(client, rawData.guild_id) : null;
		this.channel = "channel" in rawData && rawData.channel ? channelFactory(client, rawData.channel) : null;
	}
	get acknowledged() {
		return this.response.acknowledged;
	}
	get responseState() {
		return this.response.state;
	}
	set responseState(nextState) {
		this.response.state = nextState;
	}
	async callback(type, data) {
		this.response.recordCallback(type);
		return await createInteractionCallback(this.client.rest, this.id, this.token, data === void 0 ? { type } : {
			type,
			data
		});
	}
	async reply(payload) {
		const action = this.response.nextReplyAction();
		if (action === "edit") return await this.editReply(payload);
		if (action === "follow-up") return await this.followUp(payload);
		return await this.callback(InteractionResponseType.ChannelMessageWithSource, serializePayload(payload));
	}
	async defer(options) {
		return await this.callback(InteractionResponseType.DeferredChannelMessageWithSource, options?.ephemeral ? { flags: 64 } : void 0);
	}
	async acknowledge() {
		return await this.defer();
	}
	async editReply(payload) {
		const body = serializePayload(payload);
		const query = needsComponentsV2Query(body) ? { with_components: true } : void 0;
		const result = query ? await editWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original", { body }, query) : await editWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original", { body });
		this.response.recordReplyEdit();
		return result;
	}
	async deleteReply() {
		return await deleteWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original");
	}
	async fetchReply() {
		return await getWebhookMessage(this.client.rest, this.client.options.clientId, this.token, "@original");
	}
	async replyAndWaitForComponent(payload, timeoutMs = 3e5) {
		const result = await this.reply(payload);
		const rawMessage = isRawMessage(result) ? result : await this.fetchReply();
		if (!isRawMessage(rawMessage)) throw new Error("Discord interaction reply did not return a message");
		const message = new Message(this.client, rawMessage);
		return await this.client.componentHandler.waitForMessageComponent(message, timeoutMs);
	}
	async followUp(payload) {
		const body = serializePayload(payload);
		return await createWebhookMessage(this.client.rest, this.client.options.clientId, this.token, { body }, needsComponentsV2Query(body) ? { with_components: true } : void 0);
	}
};
var CommandInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.options = new OptionsHandler(rawData.data.options, client, rawData.data.resolved?.channels);
	}
};
var AutocompleteInteraction = class extends CommandInteraction {
	async respond(choices) {
		return await this.callback(InteractionResponseType.ApplicationCommandAutocompleteResult, { choices });
	}
};
var BaseComponentInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.message = rawData.message && typeof rawData.message === "object" ? new Message(client, rawData.message) : null;
		this.values = Array.isArray(rawData.data.values) ? rawData.data.values.map(String) : [];
	}
	async update(payload) {
		return await this.callback(InteractionResponseType.UpdateMessage, serializePayload(payload));
	}
	async acknowledge() {
		return await this.callback(InteractionResponseType.DeferredMessageUpdate);
	}
	async showModal(modal) {
		return await this.callback(InteractionResponseType.Modal, modal.serialize());
	}
	async editAndWaitForComponent(payload, message = this.message, timeoutMs = 3e5) {
		if (!message) return null;
		const editedMessage = await message.edit(payload);
		return await this.client.componentHandler.waitForMessageComponent(editedMessage, timeoutMs);
	}
};
var ButtonInteraction = class extends BaseComponentInteraction {};
var StringSelectMenuInteraction = class extends BaseComponentInteraction {};
var UserSelectMenuInteraction = class extends BaseComponentInteraction {};
var RoleSelectMenuInteraction = class extends BaseComponentInteraction {};
var MentionableSelectMenuInteraction = class extends BaseComponentInteraction {};
var ChannelSelectMenuInteraction = class extends BaseComponentInteraction {};
var ModalInteraction = class extends BaseInteraction {
	constructor(client, rawData) {
		super(client, rawData);
		this.fields = new ModalFields(extractModalFields(rawData.data.components ?? []), rawData.data.resolved, client);
	}
	async acknowledge() {
		return await this.callback(InteractionResponseType.DeferredMessageUpdate);
	}
};
function createInteraction(client, rawData) {
	assertDiscordInteractionPayload(rawData);
	if (rawData.type === InteractionType.ApplicationCommandAutocomplete) return new AutocompleteInteraction(client, toCommandRawInteraction(rawData));
	if (rawData.type === InteractionType.ApplicationCommand) return new CommandInteraction(client, toCommandRawInteraction(rawData));
	if (rawData.type === InteractionType.ModalSubmit) return new ModalInteraction(client, toModalSubmitRawInteraction(rawData));
	if (rawData.type === InteractionType.MessageComponent) {
		const componentRawData = toMessageComponentRawInteraction(rawData);
		switch (rawData.data?.component_type) {
			case ComponentType.Button: return new ButtonInteraction(client, componentRawData);
			case ComponentType.StringSelect: return new StringSelectMenuInteraction(client, componentRawData);
			case ComponentType.UserSelect: return new UserSelectMenuInteraction(client, componentRawData);
			case ComponentType.RoleSelect: return new RoleSelectMenuInteraction(client, componentRawData);
			case ComponentType.MentionableSelect: return new MentionableSelectMenuInteraction(client, componentRawData);
			case ComponentType.ChannelSelect: return new ChannelSelectMenuInteraction(client, componentRawData);
			default: return new BaseComponentInteraction(client, componentRawData);
		}
	}
	return new BaseInteraction(client, rawData);
}
function parseComponentInteractionData(component, customId) {
	return component.customIdParser(customId).data;
}
function isRawMessage(value) {
	return Boolean(value) && typeof value === "object" && typeof value.id === "string" && typeof value.channel_id === "string";
}
//#endregion
//#region extensions/discord/src/internal/interaction-dispatch.ts
async function dispatchInteraction(client, rawData) {
	const interaction = createInteraction(client, rawData);
	if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
		const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
		if (!command) return;
		const autocompleteInteraction = interaction;
		const optionAutocomplete = resolveFocusedCommandOptionAutocompleteHandler(command, autocompleteInteraction);
		if (optionAutocomplete) {
			await optionAutocomplete(autocompleteInteraction);
			return;
		}
		if ("autocomplete" in command) await command.autocomplete(autocompleteInteraction);
		return;
	}
	if (rawData.type === InteractionType.ApplicationCommand) {
		const command = client.commands.find((entry) => entry.name === readInteractionName(rawData));
		if (command && "run" in command) {
			await deferCommandInteractionIfNeeded(command, interaction);
			await command.run(interaction);
		}
		return;
	}
	if (rawData.type === InteractionType.MessageComponent) {
		const customId = readCustomId(rawData);
		if (!customId) return;
		const componentInteraction = interaction;
		if (client.componentHandler.resolveOneOffComponent({
			channelId: readMessageChannelId(rawData),
			customId,
			messageId: readMessageId(rawData),
			values: readComponentValues(rawData)
		})) {
			await componentInteraction.acknowledge();
			return;
		}
		const component = client.componentHandler.resolve(customId, { componentType: rawData.data?.component_type });
		if (component) {
			await deferComponentInteractionIfNeeded(component, componentInteraction);
			await component.run(componentInteraction, parseComponentInteractionData(component, customId));
		}
		return;
	}
	if (rawData.type === InteractionType.ModalSubmit) {
		const customId = readCustomId(rawData);
		if (!customId) return;
		const modal = client.modalHandler.resolve(customId);
		if (modal) await modal.run(interaction, modal.customIdParser(customId).data);
	}
}
function resolveConditionalComponentOption(value, interaction) {
	return typeof value === "function" ? value(interaction) : value;
}
async function deferComponentInteractionIfNeeded(component, interaction) {
	if (!resolveConditionalComponentOption(component.defer, interaction)) return;
	if (resolveConditionalComponentOption(component.ephemeral, interaction)) {
		await interaction.defer({ ephemeral: true });
		return;
	}
	await interaction.acknowledge();
}
function readInteractionName(rawData) {
	return rawData.data?.name;
}
function readCustomId(rawData) {
	return rawData.data?.custom_id;
}
function readComponentValues(rawData) {
	const values = rawData.data?.values;
	return Array.isArray(values) ? values.map(String) : void 0;
}
function readMessageId(rawData) {
	const messageId = rawData.message?.id;
	return typeof messageId === "string" ? messageId : void 0;
}
function readMessageChannelId(rawData) {
	const channelId = rawData.message?.channel_id;
	return typeof channelId === "string" ? channelId : void 0;
}
//#endregion
//#region extensions/discord/src/internal/rest-body.ts
function serializeRequestBody(data, headers) {
	if (data?.headers) for (const [key, value] of Object.entries(data.headers)) headers.set(key, value);
	if (data?.body == null) return;
	if (typeof data.body === "object") {
		const bodyObject = data.body;
		const topLevelFiles = Array.isArray(bodyObject.files) ? bodyObject.files : void 0;
		const nestedData = bodyObject.data && typeof bodyObject.data === "object" ? bodyObject.data : void 0;
		const nestedFiles = nestedData && Array.isArray(nestedData.files) ? nestedData.files : void 0;
		const files = topLevelFiles ?? nestedFiles;
		const filesContainer = topLevelFiles ? bodyObject : nestedFiles ? nestedData : void 0;
		if (files?.length && filesContainer) {
			if (data.multipartStyle === "form") {
				const formData = new FormData();
				for (const [key, value] of Object.entries(filesContainer)) {
					if (key === "files" || value === void 0 || value === null) continue;
					formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
				}
				for (const file of files) {
					const item = file;
					const name = typeof item.name === "string" && item.name ? item.name : "file";
					const blob = item.data instanceof Blob ? item.data : new Blob([item.data], { type: typeof item.contentType === "string" ? item.contentType : void 0 });
					formData.append(typeof item.fieldName === "string" && item.fieldName ? item.fieldName : "file", blob, name);
				}
				return formData;
			}
			const payloadJson = topLevelFiles ? { ...bodyObject } : {
				...bodyObject,
				data: { ...nestedData }
			};
			const payloadFilesContainer = topLevelFiles ? payloadJson : payloadJson.data ?? {};
			const formData = new FormData();
			const existingAttachments = Array.isArray(payloadFilesContainer.attachments) ? [...payloadFilesContainer.attachments] : [];
			const uploaded = files.map((file, index) => {
				const item = file;
				const name = typeof item.name === "string" && item.name ? item.name : `file-${index}`;
				const blob = item.data instanceof Blob ? item.data : new Blob([item.data], { type: typeof item.contentType === "string" ? item.contentType : void 0 });
				const id = existingAttachments.length + index;
				formData.append(`files[${id}]`, blob, name);
				const attachment = {
					id,
					filename: name
				};
				if (typeof item.description === "string") attachment.description = item.description;
				if (typeof item.duration_secs === "number") attachment.duration_secs = item.duration_secs;
				if (typeof item.waveform === "string") attachment.waveform = item.waveform;
				return attachment;
			});
			payloadFilesContainer.attachments = [...existingAttachments, ...uploaded];
			delete payloadFilesContainer.files;
			formData.append("payload_json", JSON.stringify(payloadJson));
			return formData;
		}
	}
	if (!data.rawBody) headers.set("Content-Type", "application/json");
	return data.rawBody ? data.body : JSON.stringify(data.body);
}
//#endregion
//#region extensions/discord/src/internal/rest-errors.ts
function readDiscordCode(body) {
	const value = body && typeof body === "object" && "code" in body ? body.code : void 0;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
}
function readDiscordMessage(body, fallback) {
	const value = body && typeof body === "object" && "message" in body ? body.message : void 0;
	return typeof value === "string" && value.trim() ? value : fallback;
}
function readRetryAfterHeader(value, now = Date.now()) {
	if (!value) return;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return seconds;
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt) ? (retryAt - now) / 1e3 : void 0;
}
function coerceRetryAfterSeconds(value) {
	if (typeof value !== "number" && typeof value !== "string") return;
	const seconds = typeof value === "number" ? value : Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.max(0, seconds) : void 0;
}
function readRetryAfter(body, response, fallbackSeconds = 0) {
	return coerceRetryAfterSeconds(body && typeof body === "object" && "retry_after" in body ? body.retry_after : void 0) ?? coerceRetryAfterSeconds(readRetryAfterHeader(response.headers.get("Retry-After"))) ?? fallbackSeconds;
}
var DiscordError = class extends Error {
	constructor(response, body) {
		super(readDiscordMessage(body, `Discord API request failed (${response.status})`));
		this.name = "DiscordError";
		this.status = response.status;
		this.statusCode = response.status;
		this.rawBody = body;
		this.rawError = body;
		this.discordCode = readDiscordCode(body);
	}
};
var RateLimitError = class extends DiscordError {
	constructor(response, body) {
		super(response, body);
		this.name = "RateLimitError";
		this.retryAfter = readRetryAfter(body, response, 1);
		this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
		this.bucket = response.headers.get("X-RateLimit-Bucket");
	}
};
//#endregion
//#region extensions/discord/src/internal/rest-routes.ts
function createRouteKey(method, path) {
	return `${method.toUpperCase()} ${path.split("?")[0] ?? path}`;
}
function readTopLevelRouteKey(path) {
	const [pathname = path] = path.split("?");
	const [first, id, token] = pathname.replace(/^\/+/, "").split("/");
	if (!first || !id) return pathname;
	if (first === "channels" || first === "guilds" || first === "webhooks") return first === "webhooks" && token ? `${first}/${id}/${token}` : `${first}/${id}`;
	return first;
}
function createBucketKey(bucket, path) {
	return `${bucket}:${readTopLevelRouteKey(path)}`;
}
function readHeaderNumber(headers, name) {
	const value = headers.get(name);
	if (!value) return;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function readResetAt(response) {
	const resetAfter = readHeaderNumber(response.headers, "X-RateLimit-Reset-After");
	if (resetAfter !== void 0) return Date.now() + Math.max(0, resetAfter * 1e3);
	const reset = readHeaderNumber(response.headers, "X-RateLimit-Reset");
	return reset !== void 0 ? reset * 1e3 : void 0;
}
function appendQuery(path, query) {
	if (!query || Object.keys(query).length === 0) return path;
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) search.set(key, String(value));
	return `${path}?${search.toString()}`;
}
//#endregion
//#region extensions/discord/src/internal/rest-scheduler.ts
const INVALID_REQUEST_WINDOW_MS = 10 * 6e4;
const requestPriorities = [
	"critical",
	"standard",
	"background"
];
function createLaneQueues() {
	return {
		critical: [],
		standard: [],
		background: []
	};
}
function countPending(bucket) {
	return requestPriorities.reduce((count, lane) => count + bucket.pending[lane].length, 0);
}
var RestScheduler = class {
	constructor(options, executor) {
		this.options = options;
		this.executor = executor;
		this.activeWorkers = 0;
		this.buckets = /* @__PURE__ */ new Map();
		this.globalRateLimitUntil = 0;
		this.invalidRequestTimestamps = [];
		this.laneCursor = 0;
		this.laneDropped = {
			critical: 0,
			standard: 0,
			background: 0
		};
		this.queuedByLane = {
			critical: 0,
			standard: 0,
			background: 0
		};
		this.queueGeneration = 0;
		this.queuedRequests = 0;
		this.routeBuckets = /* @__PURE__ */ new Map();
		this.laneSchedule = this.buildLaneSchedule(options.lanes);
	}
	enqueue(params) {
		if (this.queuedRequests >= this.options.maxQueueSize) throw new Error("Discord request queue is full");
		const laneOptions = this.options.lanes[params.priority];
		if (this.queuedByLane[params.priority] >= laneOptions.maxQueueSize) {
			this.laneDropped[params.priority] += 1;
			throw new Error(`Discord ${params.priority} request queue is full (${this.queuedByLane[params.priority]} / ${laneOptions.maxQueueSize})`);
		}
		const routeKey = createRouteKey(params.method, params.path);
		const bucket = this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
		return new Promise((resolve, reject) => {
			this.queuedRequests += 1;
			this.queuedByLane[params.priority] += 1;
			bucket.pending[params.priority].push({
				...params,
				enqueuedAt: Date.now(),
				generation: this.queueGeneration,
				routeKey,
				retryCount: 0,
				resolve,
				reject
			});
			this.drainQueues();
		});
	}
	recordResponse(routeKey, path, response, parsed) {
		this.updateRateLimitState(routeKey, path, response, parsed);
		this.recordInvalidRequest(routeKey, path, response);
	}
	clearQueue() {
		this.queueGeneration += 1;
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = void 0;
		}
		this.rejectPending(/* @__PURE__ */ new Error("Discord request queue cleared"));
	}
	abortPending() {
		this.queueGeneration += 1;
		this.rejectPending(new DOMException("Aborted", "AbortError"));
	}
	get queueSize() {
		return this.queuedRequests;
	}
	getMetrics() {
		this.pruneInvalidRequests();
		return {
			globalRateLimitUntil: this.globalRateLimitUntil,
			activeBuckets: this.buckets.size,
			routeBucketMappings: this.routeBuckets.size,
			buckets: Array.from(this.buckets.entries()).map(([key, bucket]) => ({
				key,
				active: bucket.active,
				bucket: bucket.bucket,
				invalidRequests: bucket.invalidRequests,
				pending: countPending(bucket),
				pendingByLane: Object.fromEntries(requestPriorities.map((lane) => [lane, bucket.pending[lane].length])),
				rateLimitHits: bucket.rateLimitHits,
				remaining: bucket.remaining,
				resetAt: bucket.resetAt,
				routeKeyCount: bucket.routeKeys.size
			})),
			invalidRequestCount: this.invalidRequestTimestamps.length,
			invalidRequestCountByStatus: this.invalidRequestTimestamps.reduce((counts, entry) => {
				counts[entry.status] = (counts[entry.status] ?? 0) + 1;
				return counts;
			}, {}),
			queueSize: this.queueSize,
			queueSizeByLane: { ...this.queuedByLane },
			droppedByLane: { ...this.laneDropped },
			oldestQueuedByLane: Object.fromEntries(requestPriorities.map((lane) => [lane, this.getOldestQueuedAge(lane)])),
			activeWorkers: this.activeWorkers,
			maxConcurrentWorkers: this.maxConcurrentWorkers
		};
	}
	get maxConcurrentWorkers() {
		return Math.max(1, Math.floor(this.options.maxConcurrency));
	}
	get maxRateLimitRetries() {
		return Math.max(0, Math.floor(this.options.maxRateLimitRetries));
	}
	getBucket(key) {
		const existing = this.buckets.get(key);
		if (existing) return existing;
		const bucket = {
			active: 0,
			invalidRequests: 0,
			pending: createLaneQueues(),
			rateLimitHits: 0,
			resetAt: 0,
			routeKeys: new Set([key])
		};
		this.buckets.set(key, bucket);
		return bucket;
	}
	hasBucketReference(key) {
		for (const bucketKey of this.routeBuckets.values()) if (bucketKey === key) return true;
		return false;
	}
	isBucketRateLimited(bucket, now = Date.now()) {
		return bucket.remaining === 0 && bucket.resetAt > now;
	}
	pruneRouteMapping(routeKey) {
		const bucketKey = this.routeBuckets.get(routeKey);
		if (!bucketKey) return;
		this.routeBuckets.delete(routeKey);
		this.buckets.get(bucketKey)?.routeKeys.delete(routeKey);
	}
	pruneIdleRouteMappings(bucketKey, bucket, now = Date.now()) {
		if (bucket.active > 0 || countPending(bucket) > 0 || this.isBucketRateLimited(bucket, now)) return;
		for (const routeKey of Array.from(bucket.routeKeys)) if (this.routeBuckets.get(routeKey) === bucketKey) this.pruneRouteMapping(routeKey);
	}
	shouldPruneIdleBucket(key) {
		return this.routeBuckets.get(key) !== key && !this.hasBucketReference(key);
	}
	bindRouteToBucket(routeKey, bucketKey) {
		const target = this.getBucket(bucketKey);
		target.routeKeys.add(routeKey);
		this.routeBuckets.set(routeKey, bucketKey);
		const routeBucket = this.buckets.get(routeKey);
		if (routeBucket && routeBucket !== target) {
			for (const lane of requestPriorities) {
				target.pending[lane].push(...routeBucket.pending[lane]);
				routeBucket.pending[lane] = [];
			}
			if (routeBucket.active === 0) this.buckets.delete(routeKey);
		}
		return target;
	}
	updateRateLimitState(routeKey, path, response, parsed) {
		const bucketHeader = response.headers.get("X-RateLimit-Bucket");
		const bucket = bucketHeader ? this.bindRouteToBucket(routeKey, createBucketKey(bucketHeader, path)) : this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
		bucket.bucket = bucketHeader ?? bucket.bucket;
		const limit = readHeaderNumber(response.headers, "X-RateLimit-Limit");
		if (limit !== void 0) bucket.limit = limit;
		const remaining = readHeaderNumber(response.headers, "X-RateLimit-Remaining");
		if (remaining !== void 0) bucket.remaining = remaining;
		const resetAt = readResetAt(response);
		if (resetAt !== void 0) bucket.resetAt = resetAt;
		if (response.status !== 429) return;
		bucket.rateLimitHits += 1;
		const retryAfterMs = Math.max(0, readRetryAfter(parsed, response, 1) * 1e3);
		const retryAt = Date.now() + retryAfterMs;
		if (response.headers.get("X-RateLimit-Global") === "true" || isGlobalRateLimit(parsed)) {
			this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, retryAt);
			return;
		}
		bucket.remaining = 0;
		bucket.resetAt = Math.max(bucket.resetAt, retryAt);
	}
	recordInvalidRequest(routeKey, path, response) {
		if (response.status !== 401 && response.status !== 403 && response.status !== 429) return;
		if (response.status === 429 && response.headers.get("X-RateLimit-Scope") === "shared") return;
		const now = Date.now();
		this.invalidRequestTimestamps.push({
			at: now,
			status: response.status
		});
		this.pruneInvalidRequests(now);
		const bucketHeader = response.headers.get("X-RateLimit-Bucket");
		const bucketKey = bucketHeader ? createBucketKey(bucketHeader, path) : this.routeBuckets.get(routeKey) ?? routeKey;
		const bucket = this.buckets.get(bucketKey);
		if (bucket) bucket.invalidRequests += 1;
	}
	pruneInvalidRequests(now = Date.now()) {
		const cutoff = now - INVALID_REQUEST_WINDOW_MS;
		while (this.invalidRequestTimestamps.length > 0 && (this.invalidRequestTimestamps[0]?.at ?? 0) <= cutoff) this.invalidRequestTimestamps.shift();
	}
	getBucketWaitMs(bucket, now) {
		if (bucket.remaining === 0 && bucket.resetAt > now) return bucket.resetAt - now;
		if (bucket.remaining === 0 && bucket.resetAt <= now) bucket.remaining = bucket.limit;
		return 0;
	}
	scheduleDrain(delayMs = 0) {
		if (this.drainTimer) return;
		this.drainTimer = setTimeout(() => {
			this.drainTimer = void 0;
			this.drainQueues();
		}, Math.max(0, delayMs));
		this.drainTimer.unref?.();
	}
	drainQueues() {
		let nextDelayMs = Number.POSITIVE_INFINITY;
		while (this.activeWorkers < this.maxConcurrentWorkers) {
			const next = this.takeNextQueuedRequest();
			if (!next.queued) {
				if (next.waitMs !== void 0) nextDelayMs = Math.min(nextDelayMs, next.waitMs);
				break;
			}
			const { bucket, queued } = next;
			if (bucket.remaining !== void 0 && bucket.remaining > 0) bucket.remaining -= 1;
			bucket.active += 1;
			this.activeWorkers += 1;
			this.runQueuedRequest(queued, bucket);
		}
		if (Number.isFinite(nextDelayMs)) this.scheduleDrain(nextDelayMs);
	}
	takeNextQueuedRequest() {
		const now = Date.now();
		if (this.globalRateLimitUntil > now) return { waitMs: this.globalRateLimitUntil - now };
		this.pruneIdleBuckets(now);
		let nextDelayMs;
		const buckets = Array.from(this.buckets.values()).filter((bucket) => countPending(bucket) > 0);
		if (buckets.length === 0) return {};
		for (let laneOffset = 0; laneOffset < this.laneSchedule.length; laneOffset += 1) {
			const lane = this.laneSchedule[(this.laneCursor + laneOffset) % this.laneSchedule.length];
			if (!lane || this.queuedByLane[lane] <= 0) continue;
			for (const bucket of buckets) {
				const queue = bucket.pending[lane];
				this.dropStaleHeadRequests(queue, lane, now);
				if (queue.length === 0) continue;
				if (bucket.active > 0) continue;
				const waitMs = this.getBucketWaitMs(bucket, now);
				if (waitMs > 0) {
					nextDelayMs = Math.min(nextDelayMs ?? waitMs, waitMs);
					continue;
				}
				const queued = queue.shift();
				if (!queued) continue;
				this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
				this.laneCursor = (this.laneCursor + laneOffset + 1) % this.laneSchedule.length;
				return {
					bucket,
					queued
				};
			}
		}
		return { waitMs: nextDelayMs };
	}
	dropStaleHeadRequests(queue, lane, now) {
		if (lane !== "background") return;
		const staleAfterMs = this.options.lanes[lane].staleAfterMs;
		if (!staleAfterMs || staleAfterMs <= 0) return;
		while (queue.length > 0 && now - (queue[0]?.enqueuedAt ?? now) > staleAfterMs) {
			const stale = queue.shift();
			if (!stale) continue;
			this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
			this.laneDropped[lane] += 1;
			stale.reject(/* @__PURE__ */ new Error(`Dropped stale ${lane} request after ${now - stale.enqueuedAt}ms`));
		}
	}
	pruneIdleBuckets(now = Date.now()) {
		for (const [key, bucket] of this.buckets) {
			if (bucket.active !== 0 || countPending(bucket) > 0) continue;
			if (this.isBucketRateLimited(bucket, now)) continue;
			this.pruneIdleRouteMappings(key, bucket, now);
			if (this.shouldPruneIdleBucket(key)) this.buckets.delete(key);
		}
	}
	async runQueuedRequest(queued, bucket) {
		let requeued = false;
		try {
			queued.resolve(await this.executor(queued));
		} catch (error) {
			if (error instanceof RateLimitError && this.requeueRateLimitedRequest(queued)) {
				requeued = true;
				return;
			}
			queued.reject(error);
		} finally {
			bucket.active = Math.max(0, bucket.active - 1);
			this.activeWorkers = Math.max(0, this.activeWorkers - 1);
			if (!requeued) this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			if (bucket.active === 0 && countPending(bucket) === 0) {
				for (const routeKey of bucket.routeKeys) if (this.routeBuckets.get(routeKey) === routeKey) this.routeBuckets.delete(routeKey);
			}
			this.drainQueues();
		}
	}
	requeueRateLimitedRequest(queued) {
		if (queued.generation !== this.queueGeneration || queued.retryCount >= this.maxRateLimitRetries) return false;
		const bucketKey = this.routeBuckets.get(queued.routeKey) ?? queued.routeKey;
		this.getBucket(bucketKey).pending[queued.priority].push({
			...queued,
			enqueuedAt: Date.now(),
			retryCount: queued.retryCount + 1
		});
		this.queuedByLane[queued.priority] += 1;
		return true;
	}
	rejectPending(error) {
		for (const bucket of this.buckets.values()) for (const lane of requestPriorities) for (const queued of bucket.pending[lane].splice(0)) {
			queued.reject(error);
			this.queuedRequests = Math.max(0, this.queuedRequests - 1);
			this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
		}
	}
	buildLaneSchedule(lanes) {
		const schedule = [];
		for (const lane of requestPriorities) {
			const weight = Math.max(1, Math.floor(lanes[lane].weight));
			for (let i = 0; i < weight; i += 1) schedule.push(lane);
		}
		return schedule.length > 0 ? schedule : [...requestPriorities];
	}
	getOldestQueuedAge(lane) {
		const now = Date.now();
		let oldest = 0;
		for (const bucket of this.buckets.values()) {
			const queued = bucket.pending[lane][0];
			if (!queued) continue;
			oldest = Math.max(oldest, now - queued.enqueuedAt);
		}
		return oldest;
	}
};
function isGlobalRateLimit(parsed) {
	return parsed && typeof parsed === "object" && "global" in parsed ? Boolean(parsed.global) : false;
}
//#endregion
//#region extensions/discord/src/internal/rest.ts
const defaultOptions = {
	tokenHeader: "Bot",
	baseUrl: "https://discord.com/api",
	apiVersion: 10,
	userAgent: "OpenClaw Discord",
	timeout: 15e3,
	queueRequests: true,
	maxQueueSize: 1e3,
	runtimeProfile: "persistent"
};
const DEFAULT_MAX_CONCURRENT_WORKERS = 4;
const defaultLaneOptions = {
	critical: { weight: 6 },
	standard: { weight: 3 },
	background: {
		staleAfterMs: 2e4,
		weight: 1
	}
};
function coerceResponseBody(raw) {
	if (!raw) return;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
function escapeMultipartQuotedValue(value) {
	return value.replace(/["\r\n]/g, (ch) => ch === "\"" ? "%22" : ch === "\r" ? "%0D" : "%0A");
}
async function formDataToMultipartBody(body, headers) {
	const boundary = `----openclaw-discord-${randomBytes(12).toString("hex")}`;
	headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
	const chunks = [];
	const push = (value) => {
		chunks.push(typeof value === "string" ? Buffer.from(value) : value);
	};
	for (const [key, value] of body.entries()) {
		push(`--${boundary}\r\n`);
		const escapedKey = escapeMultipartQuotedValue(key);
		if (typeof value === "string") {
			push(`Content-Disposition: form-data; name="${escapedKey}"\r\n\r\n`);
			push(value);
			push("\r\n");
			continue;
		}
		const filename = value.name;
		push(`Content-Disposition: form-data; name="${escapedKey}"; filename="${escapeMultipartQuotedValue(typeof filename === "string" && filename.length > 0 ? filename : "blob")}"\r\n`);
		if (value.type) push(`Content-Type: ${value.type}\r\n`);
		push("\r\n");
		push(Buffer.from(await value.arrayBuffer()));
		push("\r\n");
	}
	push(`--${boundary}--\r\n`);
	return Buffer.concat(chunks);
}
async function normalizeFetchBody(body, headers) {
	if (body instanceof FormData) return await formDataToMultipartBody(body, headers);
	return body;
}
var RequestClient = class {
	constructor(token, options) {
		this.requestControllers = /* @__PURE__ */ new Set();
		this.token = token.replace(/^Bot\s+/i, "");
		this.customFetch = options?.fetch;
		this.options = {
			...defaultOptions,
			...options
		};
		this.scheduler = new RestScheduler({
			lanes: normalizeSchedulerLanes(this.options.maxQueueSize ?? defaultOptions.maxQueueSize, this.options.scheduler?.lanes),
			maxConcurrency: this.options.scheduler?.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_WORKERS,
			maxQueueSize: this.options.maxQueueSize ?? defaultOptions.maxQueueSize,
			maxRateLimitRetries: this.options.scheduler?.maxRateLimitRetries ?? 3
		}, async (request) => await this.executeRequest(request.method, request.path, {
			data: request.data,
			query: request.query
		}, request.routeKey));
	}
	async get(path, query) {
		return await this.request("GET", path, { query });
	}
	async post(path, data, query) {
		return await this.request("POST", path, {
			data,
			query
		});
	}
	async patch(path, data, query) {
		return await this.request("PATCH", path, {
			data,
			query
		});
	}
	async put(path, data, query) {
		return await this.request("PUT", path, {
			data,
			query
		});
	}
	async delete(path, data, query) {
		return await this.request("DELETE", path, {
			data,
			query
		});
	}
	async request(method, path, params) {
		const routeKey = createRouteKey(method, path);
		if (!this.options.queueRequests) return await this.executeRequest(method, path, params, routeKey);
		return await this.scheduler.enqueue({
			method,
			path,
			priority: getRequestPriority(method, path),
			...params
		});
	}
	async executeRequest(method, path, params, routeKey = createRouteKey(method, path)) {
		const url = `${this.options.baseUrl}/v${this.options.apiVersion}${appendQuery(path, params.query)}`;
		const headers = new Headers({ "User-Agent": this.options.userAgent ?? defaultOptions.userAgent });
		if (this.token !== "webhook") headers.set("Authorization", `${this.options.tokenHeader ?? "Bot"} ${this.token}`);
		const body = serializeRequestBody(params.data, headers);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeout ?? 15e3);
		timeout.unref?.();
		this.requestControllers.add(controller);
		try {
			const response = await (this.customFetch ?? fetch)(url, {
				method,
				headers,
				body: await normalizeFetchBody(body, headers),
				signal: controller.signal
			});
			const parsed = coerceResponseBody(await response.text());
			this.scheduler.recordResponse(routeKey, path, response, parsed);
			if (response.status === 204) return;
			if (response.status === 429) {
				const rateLimitBody = isDiscordRateLimitBody(parsed) ? parsed : void 0;
				throw new RateLimitError(response, {
					message: readDiscordMessage(rateLimitBody, "Rate limited"),
					retry_after: readRetryAfter(rateLimitBody, response, 1),
					code: readDiscordCode(rateLimitBody),
					global: Boolean(rateLimitBody?.global)
				});
			}
			if (!response.ok) throw new DiscordError(response, parsed);
			return parsed;
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			if (error instanceof Error) throw error;
			throw new Error(`Discord request failed: ${inspect(error)}`, { cause: error });
		} finally {
			clearTimeout(timeout);
			this.requestControllers.delete(controller);
		}
	}
	clearQueue() {
		this.scheduler.clearQueue();
	}
	get queueSize() {
		return this.scheduler.queueSize;
	}
	getSchedulerMetrics() {
		return this.scheduler.getMetrics();
	}
	abortAllRequests() {
		this.scheduler.abortPending();
		for (const controller of this.requestControllers) controller.abort();
		this.requestControllers.clear();
	}
};
function normalizeSchedulerLanes(maxQueueSize, lanes) {
	const fallbackMaxQueueSize = Math.max(1, Math.floor(maxQueueSize));
	return {
		critical: normalizeSchedulerLane("critical", fallbackMaxQueueSize, lanes?.critical),
		standard: normalizeSchedulerLane("standard", fallbackMaxQueueSize, lanes?.standard),
		background: normalizeSchedulerLane("background", fallbackMaxQueueSize, lanes?.background)
	};
}
function normalizeSchedulerLane(lane, maxQueueSize, options) {
	const defaults = defaultLaneOptions[lane];
	return {
		maxQueueSize: options?.maxQueueSize !== void 0 ? Math.max(1, Math.floor(options.maxQueueSize)) : maxQueueSize,
		staleAfterMs: options?.staleAfterMs !== void 0 ? Math.max(0, Math.floor(options.staleAfterMs)) : defaults.staleAfterMs,
		weight: options?.weight !== void 0 ? Math.max(1, Math.floor(options.weight)) : defaults.weight
	};
}
function getRequestPriority(method, path) {
	const normalizedMethod = method.toUpperCase();
	const normalizedPath = path.toLowerCase();
	if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(normalizedPath)) return "critical";
	return normalizedMethod === "GET" ? "background" : "standard";
}
//#endregion
//#region extensions/discord/src/internal/client.ts
var Plugin = class {};
var ComponentRegistry = class {
	constructor() {
		this.entries = /* @__PURE__ */ new Map();
		this.oneOffComponents = /* @__PURE__ */ new Map();
		this.wildcardEntries = [];
	}
	register(entry) {
		const key = parseRegistryKey(entry.customId, entry.customIdParser);
		if (key === "*") {
			if (!this.wildcardEntries.includes(entry)) this.wildcardEntries.push(entry);
			return;
		}
		const entries = this.entries.get(key) ?? [];
		if (!entries.includes(entry)) {
			entries.push(entry);
			this.entries.set(key, entries);
		}
	}
	resolve(customId, options) {
		for (const entries of this.entries.values()) {
			const match = entries.find((entry) => {
				if (options?.componentType !== void 0 && entry.type !== options.componentType) return false;
				const parser = entry.customIdParser ?? parseCustomId;
				return parseRegistryKey(entry.customId, parser) === parseRegistryKey(customId, parser);
			});
			if (match) return match;
		}
		return this.wildcardEntries.find((entry) => {
			if (options?.componentType !== void 0 && entry.type !== options.componentType) return false;
			return true;
		});
	}
	waitForMessageComponent(message, timeoutMs) {
		const key = createOneOffComponentKey(message.id, message.channelId);
		return new Promise((resolve) => {
			const existing = this.oneOffComponents.get(key);
			if (existing) {
				clearTimeout(existing.timer);
				existing.resolve({
					success: false,
					message,
					reason: "timed out"
				});
			}
			const timer = setTimeout(() => {
				this.oneOffComponents.delete(key);
				resolve({
					success: false,
					message,
					reason: "timed out"
				});
			}, Math.max(0, timeoutMs));
			timer.unref?.();
			this.oneOffComponents.set(key, {
				message,
				timer,
				resolve
			});
		});
	}
	resolveOneOffComponent(params) {
		if (!params.messageId || !params.channelId) return false;
		const entry = this.oneOffComponents.get(createOneOffComponentKey(params.messageId, params.channelId));
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.oneOffComponents.delete(createOneOffComponentKey(params.messageId, params.channelId));
		entry.resolve({
			success: true,
			customId: params.customId,
			message: entry.message,
			values: params.values
		});
		return true;
	}
};
function parseRegistryKey(customId, parser = parseCustomId) {
	return parser(customId).key;
}
function createOneOffComponentKey(messageId, channelId) {
	return `${messageId}:${channelId}`;
}
var Client = class {
	constructor(options, handlers, plugins = []) {
		this.routes = [];
		this.plugins = [];
		this.componentHandler = new ComponentRegistry();
		this.modalHandler = new ComponentRegistry();
		if (!options.clientId) throw new Error("Missing Discord application ID");
		if (!options.token) throw new Error("Missing Discord bot token");
		this.options = {
			...options,
			baseUrl: options.baseUrl.replace(/\/+$/, "")
		};
		this.commands = handlers.commands ?? [];
		this.listeners = handlers.listeners ?? [];
		this.rest = new RequestClient(options.token, options.requestOptions);
		this.eventQueue = this.options.eventQueue ? new DiscordEventQueue(this.options.eventQueue) : void 0;
		this.entityCache = new DiscordEntityCache({
			client: this,
			rest: () => this.rest,
			ttlMs: this.options.restCacheTtlMs
		});
		this.commandDeployer = new DiscordCommandDeployer({
			clientId: this.options.clientId,
			commands: this.commands,
			devGuilds: this.options.devGuilds,
			hashStorePath: this.options.commandDeployHashStorePath,
			rest: () => this.rest
		});
		for (const component of handlers.components ?? []) this.componentHandler.register(component);
		for (const command of this.commands) for (const component of command.components ?? []) this.componentHandler.register(component);
		for (const modal of handlers.modals ?? []) this.modalHandler.register(modal);
		for (const plugin of plugins) {
			plugin.registerClient?.(this);
			plugin.registerRoutes?.(this);
			this.plugins.push({
				id: plugin.id,
				plugin
			});
		}
	}
	getPlugin(id) {
		return this.plugins.find((entry) => entry.id === id)?.plugin;
	}
	registerListener(listener) {
		if (!this.listeners.includes(listener)) this.listeners.push(listener);
		return listener;
	}
	unregisterListener(listener) {
		const index = this.listeners.indexOf(listener);
		if (index < 0) return false;
		this.listeners.splice(index, 1);
		return true;
	}
	getRuntimeMetrics() {
		return {
			request: this.rest.getSchedulerMetrics(),
			eventQueue: this.eventQueue?.getMetrics()
		};
	}
	async fetchUser(id) {
		return await this.entityCache.fetchUser(id);
	}
	async fetchChannel(id) {
		return await this.entityCache.fetchChannel(id);
	}
	async fetchGuild(id) {
		return await this.entityCache.fetchGuild(id);
	}
	async fetchMember(guildId, userId) {
		return await this.entityCache.fetchMember(guildId, userId);
	}
	async getDiscordCommands() {
		return await this.commandDeployer.getCommands();
	}
	async deployCommands(options = {}) {
		return await this.commandDeployer.deploy(options);
	}
	async reconcileCommands() {
		return await this.deployCommands({ mode: "reconcile" });
	}
	async handleInteraction(rawData, _ctx) {
		await dispatchInteraction(this, rawData);
	}
	async dispatchGatewayEvent(type, data) {
		this.entityCache.invalidateForGatewayEvent(type, data);
		const listeners = this.listeners.filter((entry) => entry.type === type);
		if (!this.eventQueue) {
			for (const listener of listeners) await listener.handle(data, this);
			return;
		}
		await Promise.all(listeners.map((listener) => this.eventQueue.enqueue({
			eventType: type,
			listenerName: listener.constructor.name || "AnonymousListener",
			run: async () => {
				await listener.handle(data, this);
			}
		})));
	}
};
//#endregion
//#region extensions/discord/src/internal/embeds.ts
function clean(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
}
var Embed = class {
	constructor(embed) {
		Object.assign(this, embed);
	}
	serialize() {
		return clean({
			title: this.title,
			description: this.description,
			url: this.url,
			timestamp: this.timestamp,
			color: this.color,
			footer: this.footer,
			image: typeof this.image === "string" ? { url: this.image } : this.image,
			thumbnail: typeof this.thumbnail === "string" ? { url: this.thumbnail } : this.thumbnail,
			author: this.author,
			fields: this.fields
		});
	}
};
//#endregion
//#region extensions/discord/src/internal/listeners.ts
var BaseListener = class {};
var ReadyListener = class extends BaseListener {
	constructor(..._args) {
		super(..._args);
		this.type = GatewayDispatchEvents.Ready;
	}
};
var ResumedListener = class extends BaseListener {
	constructor(..._args2) {
		super(..._args2);
		this.type = GatewayDispatchEvents.Resumed;
	}
};
var MessageCreateListener = class extends BaseListener {
	constructor(..._args3) {
		super(..._args3);
		this.type = GatewayDispatchEvents.MessageCreate;
	}
};
var InteractionCreateListener = class extends BaseListener {
	constructor(..._args4) {
		super(..._args4);
		this.type = GatewayDispatchEvents.InteractionCreate;
	}
};
var MessageReactionAddListener = class extends BaseListener {
	constructor(..._args5) {
		super(..._args5);
		this.type = GatewayDispatchEvents.MessageReactionAdd;
	}
};
var MessageReactionRemoveListener = class extends BaseListener {
	constructor(..._args6) {
		super(..._args6);
		this.type = GatewayDispatchEvents.MessageReactionRemove;
	}
};
var PresenceUpdateListener = class extends BaseListener {
	constructor(..._args7) {
		super(..._args7);
		this.type = GatewayDispatchEvents.PresenceUpdate;
	}
};
var ThreadUpdateListener = class extends BaseListener {
	constructor(..._args8) {
		super(..._args8);
		this.type = GatewayDispatchEvents.ThreadUpdate;
	}
};
//#endregion
//#region extensions/discord/src/internal/discord.ts
var discord_exports = /* @__PURE__ */ __exportAll({
	AnySelectMenu: () => AnySelectMenu,
	AutocompleteInteraction: () => AutocompleteInteraction,
	Base: () => Base,
	BaseCommand: () => BaseCommand,
	BaseComponent: () => BaseComponent,
	BaseComponentInteraction: () => BaseComponentInteraction,
	BaseInteraction: () => BaseInteraction,
	BaseListener: () => BaseListener,
	BaseMessageInteractiveComponent: () => BaseMessageInteractiveComponent,
	BaseModalComponent: () => BaseModalComponent,
	Button: () => Button,
	ButtonInteraction: () => ButtonInteraction,
	ChannelSelectMenu: () => ChannelSelectMenu,
	ChannelSelectMenuInteraction: () => ChannelSelectMenuInteraction,
	CheckboxGroup: () => CheckboxGroup,
	Client: () => Client,
	Command: () => Command,
	CommandInteraction: () => CommandInteraction,
	CommandWithSubcommands: () => CommandWithSubcommands,
	ComponentRegistry: () => ComponentRegistry,
	Container: () => Container,
	DiscordError: () => DiscordError,
	Embed: () => Embed,
	File: () => File,
	Guild: () => Guild,
	GuildMember: () => GuildMember,
	InteractionCreateListener: () => InteractionCreateListener,
	Label: () => Label,
	LinkButton: () => LinkButton,
	MediaGallery: () => MediaGallery,
	MentionableSelectMenu: () => MentionableSelectMenu,
	MentionableSelectMenuInteraction: () => MentionableSelectMenuInteraction,
	Message: () => Message,
	MessageCreateListener: () => MessageCreateListener,
	MessageReactionAddListener: () => MessageReactionAddListener,
	MessageReactionRemoveListener: () => MessageReactionRemoveListener,
	Modal: () => Modal,
	ModalFields: () => ModalFields,
	ModalInteraction: () => ModalInteraction,
	OptionsHandler: () => OptionsHandler,
	Plugin: () => Plugin,
	PresenceUpdateListener: () => PresenceUpdateListener,
	RadioGroup: () => RadioGroup,
	RateLimitError: () => RateLimitError,
	ReadyListener: () => ReadyListener,
	RequestClient: () => RequestClient,
	ResumedListener: () => ResumedListener,
	Role: () => Role,
	RoleSelectMenu: () => RoleSelectMenu,
	RoleSelectMenuInteraction: () => RoleSelectMenuInteraction,
	Row: () => Row,
	Section: () => Section,
	Separator: () => Separator,
	StringSelectMenu: () => StringSelectMenu,
	StringSelectMenuInteraction: () => StringSelectMenuInteraction,
	TextDisplay: () => TextDisplay,
	TextInput: () => TextInput,
	ThreadUpdateListener: () => ThreadUpdateListener,
	Thumbnail: () => Thumbnail,
	User: () => User,
	UserSelectMenu: () => UserSelectMenu,
	UserSelectMenuInteraction: () => UserSelectMenuInteraction,
	addGuildMemberRole: () => addGuildMemberRole,
	channelFactory: () => channelFactory,
	clean: () => clean$3,
	colorToNumber: () => colorToNumber,
	createApplicationCommand: () => createApplicationCommand,
	createChannelMessage: () => createChannelMessage,
	createChannelWebhook: () => createChannelWebhook,
	createGuildBan: () => createGuildBan,
	createGuildChannel: () => createGuildChannel,
	createGuildEmoji: () => createGuildEmoji,
	createGuildScheduledEvent: () => createGuildScheduledEvent,
	createGuildSticker: () => createGuildSticker,
	createInteraction: () => createInteraction,
	createInteractionCallback: () => createInteractionCallback,
	createOwnMessageReaction: () => createOwnMessageReaction,
	createThread: () => createThread,
	createUserDmChannel: () => createUserDmChannel,
	createWebhookMessage: () => createWebhookMessage,
	deferCommandInteractionIfNeeded: () => deferCommandInteractionIfNeeded,
	deleteApplicationCommand: () => deleteApplicationCommand,
	deleteChannel: () => deleteChannel,
	deleteChannelMessage: () => deleteChannelMessage,
	deleteChannelPermission: () => deleteChannelPermission,
	deleteOwnMessageReaction: () => deleteOwnMessageReaction,
	deleteWebhookMessage: () => deleteWebhookMessage,
	editApplicationCommand: () => editApplicationCommand,
	editChannel: () => editChannel,
	editChannelMessage: () => editChannelMessage,
	editWebhookMessage: () => editWebhookMessage,
	getChannel: () => getChannel,
	getChannelMessage: () => getChannelMessage,
	getCurrentUser: () => getCurrentUser,
	getGuild: () => getGuild,
	getGuildMember: () => getGuildMember,
	getGuildVoiceState: () => getGuildVoiceState,
	getUser: () => getUser,
	getWebhookMessage: () => getWebhookMessage,
	listApplicationCommands: () => listApplicationCommands,
	listChannelArchivedThreads: () => listChannelArchivedThreads,
	listChannelMessages: () => listChannelMessages,
	listChannelPins: () => listChannelPins,
	listGuildActiveThreads: () => listGuildActiveThreads,
	listGuildChannels: () => listGuildChannels,
	listGuildEmojis: () => listGuildEmojis,
	listGuildRoles: () => listGuildRoles,
	listGuildScheduledEvents: () => listGuildScheduledEvents,
	listMessageReactionUsers: () => listMessageReactionUsers,
	moveGuildChannels: () => moveGuildChannels,
	overwriteApplicationCommands: () => overwriteApplicationCommands,
	overwriteGuildApplicationCommands: () => overwriteGuildApplicationCommands,
	parseComponentInteractionData: () => parseComponentInteractionData,
	parseCustomId: () => parseCustomId,
	pinChannelMessage: () => pinChannelMessage,
	putChannelPermission: () => putChannelPermission,
	removeGuildMember: () => removeGuildMember,
	removeGuildMemberRole: () => removeGuildMemberRole,
	resolveFocusedCommandOptionAutocompleteHandler: () => resolveFocusedCommandOptionAutocompleteHandler,
	searchGuildMessages: () => searchGuildMessages,
	sendChannelTyping: () => sendChannelTyping,
	serializePayload: () => serializePayload,
	timeoutGuildMember: () => timeoutGuildMember,
	unpinChannelMessage: () => unpinChannelMessage
});
import * as import_discord_api_types_v10 from "discord-api-types/v10";
__reExport(discord_exports, import_discord_api_types_v10);
//#endregion
export { createChannelMessage as $, Button as A, putChannelPermission as At, Separator as B, User as C, getGuildVoiceState as Ct, Modal as D, listGuildRoles as Dt, Label as E, listGuildEmojis as Et, MediaGallery as F, BaseMessageInteractiveComponent as G, TextDisplay as H, MentionableSelectMenu as I, createUserDmChannel as J, parseCustomId as K, RoleSelectMenu as L, Container as M, removeGuildMemberRole as Mt, File as N, timeoutGuildMember as Nt, RadioGroup as O, listGuildScheduledEvents as Ot, LinkButton as P, listMessageReactionUsers as Q, Row as R, Message as S, getGuildMember as St, CheckboxGroup as T, listGuildChannels as Tt, Thumbnail as U, StringSelectMenu as V, UserSelectMenu as W, createOwnMessageReaction as X, getCurrentUser as Y, deleteOwnMessageReaction as Z, readDiscordMessage as _, createGuildEmoji as _t, MessageReactionRemoveListener as a, getChannel as at, CommandWithSubcommands as b, deleteChannelPermission as bt, ResumedListener as c, listChannelMessages as ct, Client as d, searchGuildMessages as dt, createThread as et, Plugin as f, sendChannelTyping as ft, readDiscordCode as g, createGuildChannel as gt, RateLimitError as h, createGuildBan as ht, MessageReactionAddListener as i, editChannelMessage as it, ChannelSelectMenu as j, removeGuildMember as jt, TextInput as k, moveGuildChannels as kt, ThreadUpdateListener as l, listChannelPins as lt, DiscordError as m, addGuildMemberRole as mt, InteractionCreateListener as n, deleteChannelMessage as nt, PresenceUpdateListener as o, getChannelMessage as ot, RequestClient as p, unpinChannelMessage as pt, createChannelWebhook as q, MessageCreateListener as r, editChannel as rt, ReadyListener as s, listChannelArchivedThreads as st, discord_exports as t, deleteChannel as tt, Embed as u, pinChannelMessage as ut, readRetryAfter as v, createGuildScheduledEvent as vt, serializePayload as w, listGuildActiveThreads as wt, Guild as x, getGuild as xt, Command as y, createGuildSticker as yt, Section as z };
