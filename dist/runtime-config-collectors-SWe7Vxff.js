import { C as isNonEmptyString, T as parseDotPath, lt as secretRefKey, w as isRecord } from "./auth-profiles-C39jSzPb.js";
import { A as coerceSecretRef, L as resolveSecretInputRef, j as hasConfiguredSecretInput } from "./registry-DTmGzx3d.js";
import { isDeepStrictEqual } from "node:util";

//#region src/secrets/path-utils.ts
function isArrayIndexSegment(segment) {
	return /^\d+$/.test(segment);
}
function expectedContainer(nextSegment) {
	return isArrayIndexSegment(nextSegment) ? "array" : "object";
}
function getPath(root, segments) {
	if (segments.length === 0) return;
	let cursor = root;
	for (const segment of segments) {
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) return;
			cursor = cursor[Number.parseInt(segment, 10)];
			continue;
		}
		if (!isRecord(cursor)) return;
		cursor = cursor[segment];
	}
	return cursor;
}
function setPathCreateStrict(root, segments, value) {
	if (segments.length === 0) throw new Error("Target path is empty.");
	let cursor = root;
	let changed = false;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index] ?? "";
		const needs = expectedContainer(segments[index + 1] ?? "");
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
			const arrayIndex = Number.parseInt(segment, 10);
			const existing = cursor[arrayIndex];
			if (existing === void 0 || existing === null) {
				cursor[arrayIndex] = needs === "array" ? [] : {};
				changed = true;
			} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
		const existing = cursor[segment];
		if (existing === void 0 || existing === null) {
			cursor[segment] = needs === "array" ? [] : {};
			changed = true;
		} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	if (Array.isArray(cursor)) {
		if (!isArrayIndexSegment(leaf)) throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
		const arrayIndex = Number.parseInt(leaf, 10);
		if (!isDeepStrictEqual(cursor[arrayIndex], value)) {
			cursor[arrayIndex] = value;
			changed = true;
		}
		return changed;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		changed = true;
	}
	return changed;
}
function setPathExistingStrict(root, segments, value) {
	if (segments.length === 0) throw new Error("Target path is empty.");
	let cursor = root;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
			const arrayIndex = Number.parseInt(segment, 10);
			if (arrayIndex < 0 || arrayIndex >= cursor.length) throw new Error(`Path segment does not exist at ${segments.slice(0, index + 1).join(".")}.`);
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
		if (!Object.prototype.hasOwnProperty.call(cursor, segment)) throw new Error(`Path segment does not exist at ${segments.slice(0, index + 1).join(".")}.`);
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	if (Array.isArray(cursor)) {
		if (!isArrayIndexSegment(leaf)) throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
		const arrayIndex = Number.parseInt(leaf, 10);
		if (arrayIndex < 0 || arrayIndex >= cursor.length) throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
		if (!isDeepStrictEqual(cursor[arrayIndex], value)) {
			cursor[arrayIndex] = value;
			return true;
		}
		return false;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		return true;
	}
	return false;
}
function deletePathStrict(root, segments) {
	if (segments.length === 0) throw new Error("Target path is empty.");
	let cursor = root;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
			cursor = cursor[Number.parseInt(segment, 10)];
			continue;
		}
		if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	if (Array.isArray(cursor)) {
		if (!isArrayIndexSegment(leaf)) throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
		const arrayIndex = Number.parseInt(leaf, 10);
		if (arrayIndex < 0 || arrayIndex >= cursor.length) return false;
		cursor.splice(arrayIndex, 1);
		return true;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
	delete cursor[leaf];
	return true;
}

//#endregion
//#region src/secrets/secret-value.ts
function isExpectedResolvedSecretValue(value, expected) {
	if (expected === "string") return isNonEmptyString(value);
	return isNonEmptyString(value) || isRecord(value);
}
function hasConfiguredPlaintextSecretValue(value, expected) {
	if (expected === "string") return isNonEmptyString(value);
	return isNonEmptyString(value) || isRecord(value) && Object.keys(value).length > 0;
}
function assertExpectedResolvedSecretValue(params) {
	if (!isExpectedResolvedSecretValue(params.value, params.expected)) throw new Error(params.errorMessage);
}

//#endregion
//#region src/secrets/target-registry-data.ts
const SECRET_TARGET_REGISTRY = [
	{
		id: "auth-profiles.api_key.key",
		targetType: "auth-profiles.api_key.key",
		configFile: "auth-profiles.json",
		pathPattern: "profiles.*.key",
		refPathPattern: "profiles.*.keyRef",
		secretShape: "sibling_ref",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		authProfileType: "api_key"
	},
	{
		id: "auth-profiles.token.token",
		targetType: "auth-profiles.token.token",
		configFile: "auth-profiles.json",
		pathPattern: "profiles.*.token",
		refPathPattern: "profiles.*.tokenRef",
		secretShape: "sibling_ref",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		authProfileType: "token"
	},
	{
		id: "agents.defaults.memorySearch.remote.apiKey",
		targetType: "agents.defaults.memorySearch.remote.apiKey",
		configFile: "openclaw.json",
		pathPattern: "agents.defaults.memorySearch.remote.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "agents.list[].memorySearch.remote.apiKey",
		targetType: "agents.list[].memorySearch.remote.apiKey",
		configFile: "openclaw.json",
		pathPattern: "agents.list[].memorySearch.remote.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.bluebubbles.accounts.*.password",
		targetType: "channels.bluebubbles.accounts.*.password",
		configFile: "openclaw.json",
		pathPattern: "channels.bluebubbles.accounts.*.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.bluebubbles.password",
		targetType: "channels.bluebubbles.password",
		configFile: "openclaw.json",
		pathPattern: "channels.bluebubbles.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.pluralkit.token",
		targetType: "channels.discord.accounts.*.pluralkit.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.pluralkit.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.token",
		targetType: "channels.discord.accounts.*.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.voice.tts.elevenlabs.apiKey",
		targetType: "channels.discord.accounts.*.voice.tts.elevenlabs.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.voice.tts.elevenlabs.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.voice.tts.openai.apiKey",
		targetType: "channels.discord.accounts.*.voice.tts.openai.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.voice.tts.openai.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.pluralkit.token",
		targetType: "channels.discord.pluralkit.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.pluralkit.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.token",
		targetType: "channels.discord.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.voice.tts.elevenlabs.apiKey",
		targetType: "channels.discord.voice.tts.elevenlabs.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.voice.tts.elevenlabs.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.voice.tts.openai.apiKey",
		targetType: "channels.discord.voice.tts.openai.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.voice.tts.openai.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.accounts.*.appSecret",
		targetType: "channels.feishu.accounts.*.appSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.appSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.accounts.*.verificationToken",
		targetType: "channels.feishu.accounts.*.verificationToken",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.verificationToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.appSecret",
		targetType: "channels.feishu.appSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.appSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.verificationToken",
		targetType: "channels.feishu.verificationToken",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.verificationToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.googlechat.accounts.*.serviceAccount",
		targetType: "channels.googlechat.serviceAccount",
		targetTypeAliases: ["channels.googlechat.accounts.*.serviceAccount"],
		configFile: "openclaw.json",
		pathPattern: "channels.googlechat.accounts.*.serviceAccount",
		refPathPattern: "channels.googlechat.accounts.*.serviceAccountRef",
		secretShape: "sibling_ref",
		expectedResolvedValue: "string-or-object",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		accountIdPathSegmentIndex: 3
	},
	{
		id: "channels.googlechat.serviceAccount",
		targetType: "channels.googlechat.serviceAccount",
		configFile: "openclaw.json",
		pathPattern: "channels.googlechat.serviceAccount",
		refPathPattern: "channels.googlechat.serviceAccountRef",
		secretShape: "sibling_ref",
		expectedResolvedValue: "string-or-object",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.accounts.*.nickserv.password",
		targetType: "channels.irc.accounts.*.nickserv.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.accounts.*.nickserv.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.accounts.*.password",
		targetType: "channels.irc.accounts.*.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.accounts.*.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.nickserv.password",
		targetType: "channels.irc.nickserv.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.nickserv.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.password",
		targetType: "channels.irc.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.mattermost.accounts.*.botToken",
		targetType: "channels.mattermost.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.mattermost.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.mattermost.botToken",
		targetType: "channels.mattermost.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.mattermost.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.matrix.accounts.*.password",
		targetType: "channels.matrix.accounts.*.password",
		configFile: "openclaw.json",
		pathPattern: "channels.matrix.accounts.*.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.matrix.password",
		targetType: "channels.matrix.password",
		configFile: "openclaw.json",
		pathPattern: "channels.matrix.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.msteams.appPassword",
		targetType: "channels.msteams.appPassword",
		configFile: "openclaw.json",
		pathPattern: "channels.msteams.appPassword",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.accounts.*.apiPassword",
		targetType: "channels.nextcloud-talk.accounts.*.apiPassword",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.accounts.*.apiPassword",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.accounts.*.botSecret",
		targetType: "channels.nextcloud-talk.accounts.*.botSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.accounts.*.botSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.apiPassword",
		targetType: "channels.nextcloud-talk.apiPassword",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.apiPassword",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.nextcloud-talk.botSecret",
		targetType: "channels.nextcloud-talk.botSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.nextcloud-talk.botSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.appToken",
		targetType: "channels.slack.accounts.*.appToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.appToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.botToken",
		targetType: "channels.slack.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.signingSecret",
		targetType: "channels.slack.accounts.*.signingSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.signingSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.accounts.*.userToken",
		targetType: "channels.slack.accounts.*.userToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.accounts.*.userToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.appToken",
		targetType: "channels.slack.appToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.appToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.botToken",
		targetType: "channels.slack.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.signingSecret",
		targetType: "channels.slack.signingSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.signingSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.slack.userToken",
		targetType: "channels.slack.userToken",
		configFile: "openclaw.json",
		pathPattern: "channels.slack.userToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.accounts.*.botToken",
		targetType: "channels.telegram.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.accounts.*.webhookSecret",
		targetType: "channels.telegram.accounts.*.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.accounts.*.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.botToken",
		targetType: "channels.telegram.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.telegram.webhookSecret",
		targetType: "channels.telegram.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.telegram.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.accounts.*.botToken",
		targetType: "channels.zalo.accounts.*.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.accounts.*.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.accounts.*.webhookSecret",
		targetType: "channels.zalo.accounts.*.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.accounts.*.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.botToken",
		targetType: "channels.zalo.botToken",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.botToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.zalo.webhookSecret",
		targetType: "channels.zalo.webhookSecret",
		configFile: "openclaw.json",
		pathPattern: "channels.zalo.webhookSecret",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "cron.webhookToken",
		targetType: "cron.webhookToken",
		configFile: "openclaw.json",
		pathPattern: "cron.webhookToken",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.auth.token",
		targetType: "gateway.auth.token",
		configFile: "openclaw.json",
		pathPattern: "gateway.auth.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.auth.password",
		targetType: "gateway.auth.password",
		configFile: "openclaw.json",
		pathPattern: "gateway.auth.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.remote.password",
		targetType: "gateway.remote.password",
		configFile: "openclaw.json",
		pathPattern: "gateway.remote.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.remote.token",
		targetType: "gateway.remote.token",
		configFile: "openclaw.json",
		pathPattern: "gateway.remote.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "messages.tts.elevenlabs.apiKey",
		targetType: "messages.tts.elevenlabs.apiKey",
		configFile: "openclaw.json",
		pathPattern: "messages.tts.elevenlabs.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "messages.tts.openai.apiKey",
		targetType: "messages.tts.openai.apiKey",
		configFile: "openclaw.json",
		pathPattern: "messages.tts.openai.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "models.providers.*.apiKey",
		targetType: "models.providers.apiKey",
		targetTypeAliases: ["models.providers.*.apiKey"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2,
		trackProviderShadowing: true
	},
	{
		id: "skills.entries.*.apiKey",
		targetType: "skills.entries.apiKey",
		targetTypeAliases: ["skills.entries.*.apiKey"],
		configFile: "openclaw.json",
		pathPattern: "skills.entries.*.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "talk.apiKey",
		targetType: "talk.apiKey",
		configFile: "openclaw.json",
		pathPattern: "talk.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "talk.providers.*.apiKey",
		targetType: "talk.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "talk.providers.*.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.apiKey",
		targetType: "tools.web.search.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.gemini.apiKey",
		targetType: "tools.web.search.gemini.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.gemini.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.grok.apiKey",
		targetType: "tools.web.search.grok.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.grok.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.kimi.apiKey",
		targetType: "tools.web.search.kimi.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.kimi.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.perplexity.apiKey",
		targetType: "tools.web.search.perplexity.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.perplexity.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];

//#endregion
//#region src/secrets/target-registry-pattern.ts
function countDynamicPatternTokens(tokens) {
	return tokens.filter((token) => token.kind === "wildcard" || token.kind === "array").length;
}
function parsePathPattern(pathPattern) {
	return parseDotPath(pathPattern).map((segment) => {
		if (segment === "*") return { kind: "wildcard" };
		if (segment.endsWith("[]")) {
			const field = segment.slice(0, -2).trim();
			if (!field) throw new Error(`Invalid target path pattern: ${pathPattern}`);
			return {
				kind: "array",
				field
			};
		}
		return {
			kind: "literal",
			value: segment
		};
	});
}
function compileTargetRegistryEntry(entry) {
	const pathTokens = parsePathPattern(entry.pathPattern);
	const pathDynamicTokenCount = countDynamicPatternTokens(pathTokens);
	const refPathTokens = entry.refPathPattern ? parsePathPattern(entry.refPathPattern) : void 0;
	const refPathDynamicTokenCount = refPathTokens ? countDynamicPatternTokens(refPathTokens) : 0;
	if (entry.secretShape === "sibling_ref" && !refPathTokens) throw new Error(`Missing refPathPattern for sibling_ref target: ${entry.id}`);
	if (refPathTokens && refPathDynamicTokenCount !== pathDynamicTokenCount) throw new Error(`Mismatched wildcard shape for target ref path: ${entry.id}`);
	return {
		...entry,
		pathTokens,
		pathDynamicTokenCount,
		refPathTokens,
		refPathDynamicTokenCount
	};
}
function matchPathTokens(segments, tokens) {
	const captures = [];
	let index = 0;
	for (const token of tokens) {
		if (token.kind === "literal") {
			if (segments[index] !== token.value) return null;
			index += 1;
			continue;
		}
		if (token.kind === "wildcard") {
			const value = segments[index];
			if (!value) return null;
			captures.push(value);
			index += 1;
			continue;
		}
		if (segments[index] !== token.field) return null;
		const next = segments[index + 1];
		if (!next || !/^\d+$/.test(next)) return null;
		captures.push(next);
		index += 2;
	}
	return index === segments.length ? { captures } : null;
}
function materializePathTokens(tokens, captures) {
	const out = [];
	let captureIndex = 0;
	for (const token of tokens) {
		if (token.kind === "literal") {
			out.push(token.value);
			continue;
		}
		if (token.kind === "wildcard") {
			const value = captures[captureIndex];
			if (!value) return null;
			out.push(value);
			captureIndex += 1;
			continue;
		}
		const arrayIndex = captures[captureIndex];
		if (!arrayIndex || !/^\d+$/.test(arrayIndex)) return null;
		out.push(token.field, arrayIndex);
		captureIndex += 1;
	}
	return captureIndex === captures.length ? out : null;
}
function expandPathTokens(root, tokens) {
	const out = [];
	const walk = (node, tokenIndex, segments, captures) => {
		const token = tokens[tokenIndex];
		if (!token) {
			out.push({
				segments,
				captures,
				value: node
			});
			return;
		}
		const isLeaf = tokenIndex === tokens.length - 1;
		if (token.kind === "literal") {
			if (!isRecord(node)) return;
			if (isLeaf) {
				out.push({
					segments: [...segments, token.value],
					captures,
					value: node[token.value]
				});
				return;
			}
			if (!Object.prototype.hasOwnProperty.call(node, token.value)) return;
			walk(node[token.value], tokenIndex + 1, [...segments, token.value], captures);
			return;
		}
		if (token.kind === "wildcard") {
			if (!isRecord(node)) return;
			for (const [key, value] of Object.entries(node)) {
				if (isLeaf) {
					out.push({
						segments: [...segments, key],
						captures: [...captures, key],
						value
					});
					continue;
				}
				walk(value, tokenIndex + 1, [...segments, key], [...captures, key]);
			}
			return;
		}
		if (!isRecord(node)) return;
		const items = node[token.field];
		if (!Array.isArray(items)) return;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			const indexString = String(index);
			if (isLeaf) {
				out.push({
					segments: [
						...segments,
						token.field,
						indexString
					],
					captures: [...captures, indexString],
					value: item
				});
				continue;
			}
			walk(item, tokenIndex + 1, [
				...segments,
				token.field,
				indexString
			], [...captures, indexString]);
		}
	};
	walk(root, 0, [], []);
	return out;
}

//#endregion
//#region src/secrets/target-registry-query.ts
const COMPILED_SECRET_TARGET_REGISTRY = SECRET_TARGET_REGISTRY.map(compileTargetRegistryEntry);
const OPENCLAW_COMPILED_SECRET_TARGETS = COMPILED_SECRET_TARGET_REGISTRY.filter((entry) => entry.configFile === "openclaw.json");
const AUTH_PROFILES_COMPILED_SECRET_TARGETS = COMPILED_SECRET_TARGET_REGISTRY.filter((entry) => entry.configFile === "auth-profiles.json");
function buildTargetTypeIndex() {
	const byType = /* @__PURE__ */ new Map();
	const append = (type, entry) => {
		const existing = byType.get(type);
		if (existing) {
			existing.push(entry);
			return;
		}
		byType.set(type, [entry]);
	};
	for (const entry of COMPILED_SECRET_TARGET_REGISTRY) {
		append(entry.targetType, entry);
		for (const alias of entry.targetTypeAliases ?? []) append(alias, entry);
	}
	return byType;
}
const TARGETS_BY_TYPE = buildTargetTypeIndex();
const KNOWN_TARGET_IDS = new Set(COMPILED_SECRET_TARGET_REGISTRY.map((entry) => entry.id));
function buildConfigTargetIdIndex() {
	const byId = /* @__PURE__ */ new Map();
	for (const entry of OPENCLAW_COMPILED_SECRET_TARGETS) {
		const existing = byId.get(entry.id);
		if (existing) {
			existing.push(entry);
			continue;
		}
		byId.set(entry.id, [entry]);
	}
	return byId;
}
const OPENCLAW_TARGETS_BY_ID = buildConfigTargetIdIndex();
function buildAuthProfileTargetIdIndex() {
	const byId = /* @__PURE__ */ new Map();
	for (const entry of AUTH_PROFILES_COMPILED_SECRET_TARGETS) {
		const existing = byId.get(entry.id);
		if (existing) {
			existing.push(entry);
			continue;
		}
		byId.set(entry.id, [entry]);
	}
	return byId;
}
const AUTH_PROFILES_TARGETS_BY_ID = buildAuthProfileTargetIdIndex();
function toResolvedPlanTarget(entry, pathSegments, captures) {
	const providerId = entry.providerIdPathSegmentIndex !== void 0 ? pathSegments[entry.providerIdPathSegmentIndex] : void 0;
	const accountId = entry.accountIdPathSegmentIndex !== void 0 ? pathSegments[entry.accountIdPathSegmentIndex] : void 0;
	const refPathSegments = entry.refPathTokens ? materializePathTokens(entry.refPathTokens, captures) : void 0;
	if (entry.refPathTokens && !refPathSegments) return null;
	return {
		entry,
		pathSegments,
		...refPathSegments ? { refPathSegments } : {},
		...providerId ? { providerId } : {},
		...accountId ? { accountId } : {}
	};
}
function listSecretTargetRegistryEntries() {
	return COMPILED_SECRET_TARGET_REGISTRY.map((entry) => ({
		id: entry.id,
		targetType: entry.targetType,
		...entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {},
		configFile: entry.configFile,
		pathPattern: entry.pathPattern,
		...entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {},
		secretShape: entry.secretShape,
		expectedResolvedValue: entry.expectedResolvedValue,
		includeInPlan: entry.includeInPlan,
		includeInConfigure: entry.includeInConfigure,
		includeInAudit: entry.includeInAudit,
		...entry.providerIdPathSegmentIndex !== void 0 ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex } : {},
		...entry.accountIdPathSegmentIndex !== void 0 ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex } : {},
		...entry.authProfileType ? { authProfileType: entry.authProfileType } : {},
		...entry.trackProviderShadowing ? { trackProviderShadowing: true } : {}
	}));
}
function isKnownSecretTargetType(value) {
	return typeof value === "string" && TARGETS_BY_TYPE.has(value);
}
function isKnownSecretTargetId(value) {
	return typeof value === "string" && KNOWN_TARGET_IDS.has(value);
}
function resolvePlanTargetAgainstRegistry(candidate) {
	const entries = TARGETS_BY_TYPE.get(candidate.type);
	if (!entries || entries.length === 0) return null;
	for (const entry of entries) {
		if (!entry.includeInPlan) continue;
		const matched = matchPathTokens(candidate.pathSegments, entry.pathTokens);
		if (!matched) continue;
		const resolved = toResolvedPlanTarget(entry, candidate.pathSegments, matched.captures);
		if (!resolved) continue;
		if (candidate.providerId && candidate.providerId.trim().length > 0) {
			if (!resolved.providerId || resolved.providerId !== candidate.providerId) continue;
		}
		if (candidate.accountId && candidate.accountId.trim().length > 0) {
			if (!resolved.accountId || resolved.accountId !== candidate.accountId) continue;
		}
		return resolved;
	}
	return null;
}
function discoverConfigSecretTargets(config) {
	return discoverConfigSecretTargetsByIds(config);
}
function discoverConfigSecretTargetsByIds(config, targetIds) {
	const allowedTargetIds = targetIds === void 0 ? null : new Set(Array.from(targetIds).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const discoveryEntries = allowedTargetIds === null ? OPENCLAW_COMPILED_SECRET_TARGETS : Array.from(allowedTargetIds).flatMap((targetId) => OPENCLAW_TARGETS_BY_ID.get(targetId) ?? []);
	for (const entry of discoveryEntries) {
		const expanded = expandPathTokens(config, entry.pathTokens);
		for (const match of expanded) {
			const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
			if (!resolved) continue;
			const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const refValue = resolved.refPathSegments ? getPath(config, resolved.refPathSegments) : void 0;
			out.push({
				entry,
				path: resolved.pathSegments.join("."),
				pathSegments: resolved.pathSegments,
				...resolved.refPathSegments ? {
					refPathSegments: resolved.refPathSegments,
					refPath: resolved.refPathSegments.join(".")
				} : {},
				value: match.value,
				...resolved.providerId ? { providerId: resolved.providerId } : {},
				...resolved.accountId ? { accountId: resolved.accountId } : {},
				...resolved.refPathSegments ? { refValue } : {}
			});
		}
	}
	return out;
}
function discoverAuthProfileSecretTargets(store) {
	return discoverAuthProfileSecretTargetsByIds(store);
}
function discoverAuthProfileSecretTargetsByIds(store, targetIds) {
	const allowedTargetIds = targetIds === void 0 ? null : new Set(Array.from(targetIds).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const discoveryEntries = allowedTargetIds === null ? AUTH_PROFILES_COMPILED_SECRET_TARGETS : Array.from(allowedTargetIds).flatMap((targetId) => AUTH_PROFILES_TARGETS_BY_ID.get(targetId) ?? []);
	for (const entry of discoveryEntries) {
		const expanded = expandPathTokens(store, entry.pathTokens);
		for (const match of expanded) {
			const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
			if (!resolved) continue;
			const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const refValue = resolved.refPathSegments ? getPath(store, resolved.refPathSegments) : void 0;
			out.push({
				entry,
				path: resolved.pathSegments.join("."),
				pathSegments: resolved.pathSegments,
				...resolved.refPathSegments ? {
					refPathSegments: resolved.refPathSegments,
					refPath: resolved.refPathSegments.join(".")
				} : {},
				value: match.value,
				...resolved.providerId ? { providerId: resolved.providerId } : {},
				...resolved.accountId ? { accountId: resolved.accountId } : {},
				...resolved.refPathSegments ? { refValue } : {}
			});
		}
	}
	return out;
}
function listAuthProfileSecretTargetEntries() {
	return COMPILED_SECRET_TARGET_REGISTRY.filter((entry) => entry.configFile === "auth-profiles.json" && entry.includeInAudit);
}

//#endregion
//#region src/secrets/command-config.ts
function collectCommandSecretAssignmentsFromSnapshot(params) {
	const defaults = params.sourceConfig.secrets?.defaults;
	const assignments = [];
	const diagnostics = [];
	for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
		const { explicitRef, ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		const inlineCandidateRef = explicitRef ? coerceSecretRef(target.value, defaults) : null;
		if (!ref) continue;
		const resolved = getPath(params.resolvedConfig, target.pathSegments);
		if (!isExpectedResolvedSecretValue(resolved, target.entry.expectedResolvedValue)) {
			if (params.inactiveRefPaths?.has(target.path)) {
				diagnostics.push(`${target.path}: secret ref is configured on an inactive surface; skipping command-time assignment.`);
				continue;
			}
			throw new Error(`${params.commandName}: ${target.path} is unresolved in the active runtime snapshot.`);
		}
		assignments.push({
			path: target.path,
			pathSegments: [...target.pathSegments],
			value: resolved
		});
		if (target.entry.secretShape === "sibling_ref" && explicitRef && inlineCandidateRef) diagnostics.push(`${target.path}: both inline and sibling ref were present; sibling ref took precedence.`);
	}
	return {
		assignments,
		diagnostics
	};
}

//#endregion
//#region src/secrets/runtime-shared.ts
function createResolverContext(params) {
	return {
		sourceConfig: params.sourceConfig,
		env: params.env,
		cache: {},
		warnings: [],
		warningKeys: /* @__PURE__ */ new Set(),
		assignments: []
	};
}
function pushAssignment(context, assignment) {
	context.assignments.push(assignment);
}
function pushWarning(context, warning) {
	const warningKey = `${warning.code}:${warning.path}:${warning.message}`;
	if (context.warningKeys.has(warningKey)) return;
	context.warningKeys.add(warningKey);
	context.warnings.push(warning);
}
function pushInactiveSurfaceWarning(params) {
	pushWarning(params.context, {
		code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
		path: params.path,
		message: params.details && params.details.trim().length > 0 ? `${params.path}: ${params.details}` : `${params.path}: secret ref is configured on an inactive surface; skipping resolution until it becomes active.`
	});
}
function collectSecretInputAssignment(params) {
	const ref = coerceSecretRef(params.value, params.defaults);
	if (!ref) return;
	if (params.active === false) {
		pushInactiveSurfaceWarning({
			context: params.context,
			path: params.path,
			details: params.inactiveReason
		});
		return;
	}
	pushAssignment(params.context, {
		ref,
		path: params.path,
		expected: params.expected,
		apply: params.apply
	});
}
function applyResolvedAssignments(params) {
	for (const assignment of params.assignments) {
		const key = secretRefKey(assignment.ref);
		if (!params.resolved.has(key)) throw new Error(`Secret reference "${key}" resolved to no value.`);
		const value = params.resolved.get(key);
		assertExpectedResolvedSecretValue({
			value,
			expected: assignment.expected,
			errorMessage: assignment.expected === "string" ? `${assignment.path} resolved to a non-string or empty value.` : `${assignment.path} resolved to an unsupported value type.`
		});
		assignment.apply(value);
	}
}
function hasOwnProperty(record, key) {
	return Object.prototype.hasOwnProperty.call(record, key);
}
function isEnabledFlag(value) {
	if (!isRecord(value)) return true;
	return value.enabled !== false;
}
function isChannelAccountEffectivelyEnabled(channel, account) {
	return isEnabledFlag(channel) && isEnabledFlag(account);
}

//#endregion
//#region src/secrets/runtime-config-collectors-tts.ts
function collectTtsApiKeyAssignments(params) {
	const elevenlabs = params.tts.elevenlabs;
	if (isRecord(elevenlabs)) collectSecretInputAssignment({
		value: elevenlabs.apiKey,
		path: `${params.pathPrefix}.elevenlabs.apiKey`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: params.active,
		inactiveReason: params.inactiveReason,
		apply: (value) => {
			elevenlabs.apiKey = value;
		}
	});
	const openai = params.tts.openai;
	if (isRecord(openai)) collectSecretInputAssignment({
		value: openai.apiKey,
		path: `${params.pathPrefix}.openai.apiKey`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: params.active,
		inactiveReason: params.inactiveReason,
		apply: (value) => {
			openai.apiKey = value;
		}
	});
}

//#endregion
//#region src/secrets/runtime-config-collectors-channels.ts
function resolveChannelAccountSurface(channel) {
	const channelEnabled = isEnabledFlag(channel);
	const accounts = channel.accounts;
	if (!isRecord(accounts) || Object.keys(accounts).length === 0) return {
		hasExplicitAccounts: false,
		channelEnabled,
		accounts: [{
			accountId: "default",
			account: channel,
			enabled: channelEnabled
		}]
	};
	const accountEntries = [];
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!isRecord(account)) continue;
		accountEntries.push({
			accountId,
			account,
			enabled: isChannelAccountEffectivelyEnabled(channel, account)
		});
	}
	return {
		hasExplicitAccounts: true,
		channelEnabled,
		accounts: accountEntries
	};
}
function isBaseFieldActiveForChannelSurface(surface, rootKey) {
	if (!surface.channelEnabled) return false;
	if (!surface.hasExplicitAccounts) return true;
	return surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, rootKey));
}
function normalizeSecretStringValue(value) {
	return typeof value === "string" ? value.trim() : "";
}
function hasConfiguredSecretInputValue(value, defaults) {
	return normalizeSecretStringValue(value).length > 0 || coerceSecretRef(value, defaults) !== null;
}
function collectSimpleChannelFieldAssignments(params) {
	collectSecretInputAssignment({
		value: params.channel[params.field],
		path: `channels.${params.channelKey}.${params.field}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: isBaseFieldActiveForChannelSurface(params.surface, params.field),
		inactiveReason: params.topInactiveReason,
		apply: (value) => {
			params.channel[params.field] = value;
		}
	});
	if (!params.surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of params.surface.accounts) {
		if (!hasOwnProperty(account, params.field)) continue;
		collectSecretInputAssignment({
			value: account[params.field],
			path: `channels.${params.channelKey}.accounts.${accountId}.${params.field}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: params.accountInactiveReason,
			apply: (value) => {
				account[params.field] = value;
			}
		});
	}
}
function collectTelegramAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const telegram = channels.telegram;
	if (!isRecord(telegram)) return;
	const surface = resolveChannelAccountSurface(telegram);
	const baseTokenFile = typeof telegram.tokenFile === "string" ? telegram.tokenFile.trim() : "";
	const topLevelBotTokenActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseTokenFile.length === 0 : surface.accounts.some(({ account, enabled }) => {
		if (!enabled || baseTokenFile.length > 0) return false;
		const accountBotTokenConfigured = hasConfiguredSecretInputValue(account.botToken, params.defaults);
		const accountTokenFileConfigured = typeof account.tokenFile === "string" && account.tokenFile.trim().length > 0;
		return !accountBotTokenConfigured && !accountTokenFileConfigured;
	});
	collectSecretInputAssignment({
		value: telegram.botToken,
		path: "channels.telegram.botToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelBotTokenActive,
		inactiveReason: "no enabled Telegram surface inherits this top-level botToken (tokenFile is configured).",
		apply: (value) => {
			telegram.botToken = value;
		}
	});
	if (surface.hasExplicitAccounts) for (const { accountId, account, enabled } of surface.accounts) {
		if (!hasOwnProperty(account, "botToken")) continue;
		const accountTokenFile = typeof account.tokenFile === "string" ? account.tokenFile.trim() : "";
		collectSecretInputAssignment({
			value: account.botToken,
			path: `channels.telegram.accounts.${accountId}.botToken`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && accountTokenFile.length === 0,
			inactiveReason: "Telegram account is disabled or tokenFile is configured.",
			apply: (value) => {
				account.botToken = value;
			}
		});
	}
	const baseWebhookUrl = typeof telegram.webhookUrl === "string" ? telegram.webhookUrl.trim() : "";
	const topLevelWebhookSecretActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseWebhookUrl.length > 0 : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "webhookSecret") && (hasOwnProperty(account, "webhookUrl") ? typeof account.webhookUrl === "string" && account.webhookUrl.trim().length > 0 : baseWebhookUrl.length > 0));
	collectSecretInputAssignment({
		value: telegram.webhookSecret,
		path: "channels.telegram.webhookSecret",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelWebhookSecretActive,
		inactiveReason: "no enabled Telegram webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
		apply: (value) => {
			telegram.webhookSecret = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (!hasOwnProperty(account, "webhookSecret")) continue;
		const accountWebhookUrl = hasOwnProperty(account, "webhookUrl") ? typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "" : baseWebhookUrl;
		collectSecretInputAssignment({
			value: account.webhookSecret,
			path: `channels.telegram.accounts.${accountId}.webhookSecret`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && accountWebhookUrl.length > 0,
			inactiveReason: "Telegram account is disabled or webhook mode is not active for this account.",
			apply: (value) => {
				account.webhookSecret = value;
			}
		});
	}
}
function collectSlackAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const slack = channels.slack;
	if (!isRecord(slack)) return;
	const surface = resolveChannelAccountSurface(slack);
	const baseMode = slack.mode === "http" || slack.mode === "socket" ? slack.mode : "socket";
	for (const field of ["botToken", "userToken"]) collectSimpleChannelFieldAssignments({
		channelKey: "slack",
		field,
		channel: slack,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
		accountInactiveReason: "Slack account is disabled."
	});
	const topLevelAppTokenActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseMode !== "http" : surface.accounts.some(({ account, enabled }) => {
		if (!enabled || hasOwnProperty(account, "appToken")) return false;
		return (account.mode === "http" || account.mode === "socket" ? account.mode : baseMode) !== "http";
	});
	collectSecretInputAssignment({
		value: slack.appToken,
		path: "channels.slack.appToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelAppTokenActive,
		inactiveReason: "no enabled Slack socket-mode surface inherits this top-level appToken.",
		apply: (value) => {
			slack.appToken = value;
		}
	});
	const topLevelSigningSecretActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseMode === "http" : surface.accounts.some(({ account, enabled }) => {
		if (!enabled || hasOwnProperty(account, "signingSecret")) return false;
		return (account.mode === "http" || account.mode === "socket" ? account.mode : baseMode) === "http";
	});
	collectSecretInputAssignment({
		value: slack.signingSecret,
		path: "channels.slack.signingSecret",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelSigningSecretActive,
		inactiveReason: "no enabled Slack HTTP-mode surface inherits this top-level signingSecret.",
		apply: (value) => {
			slack.signingSecret = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		const accountMode = account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
		if (hasOwnProperty(account, "appToken")) collectSecretInputAssignment({
			value: account.appToken,
			path: `channels.slack.accounts.${accountId}.appToken`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && accountMode !== "http",
			inactiveReason: "Slack account is disabled or not running in socket mode.",
			apply: (value) => {
				account.appToken = value;
			}
		});
		if (!hasOwnProperty(account, "signingSecret")) continue;
		collectSecretInputAssignment({
			value: account.signingSecret,
			path: `channels.slack.accounts.${accountId}.signingSecret`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && accountMode === "http",
			inactiveReason: "Slack account is disabled or not running in HTTP mode.",
			apply: (value) => {
				account.signingSecret = value;
			}
		});
	}
}
function collectDiscordAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const discord = channels.discord;
	if (!isRecord(discord)) return;
	const surface = resolveChannelAccountSurface(discord);
	collectSimpleChannelFieldAssignments({
		channelKey: "discord",
		field: "token",
		channel: discord,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Discord token.",
		accountInactiveReason: "Discord account is disabled."
	});
	if (isRecord(discord.pluralkit)) {
		const pluralkit = discord.pluralkit;
		collectSecretInputAssignment({
			value: pluralkit.token,
			path: "channels.discord.pluralkit.token",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: isBaseFieldActiveForChannelSurface(surface, "pluralkit") && isEnabledFlag(pluralkit),
			inactiveReason: "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
			apply: (value) => {
				pluralkit.token = value;
			}
		});
	}
	if (isRecord(discord.voice) && isRecord(discord.voice.tts)) collectTtsApiKeyAssignments({
		tts: discord.voice.tts,
		pathPrefix: "channels.discord.voice.tts",
		defaults: params.defaults,
		context: params.context,
		active: isBaseFieldActiveForChannelSurface(surface, "voice") && isEnabledFlag(discord.voice),
		inactiveReason: "no enabled Discord surface inherits this top-level voice config or voice is disabled."
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (hasOwnProperty(account, "pluralkit") && isRecord(account.pluralkit)) {
			const pluralkit = account.pluralkit;
			collectSecretInputAssignment({
				value: pluralkit.token,
				path: `channels.discord.accounts.${accountId}.pluralkit.token`,
				expected: "string",
				defaults: params.defaults,
				context: params.context,
				active: enabled && isEnabledFlag(pluralkit),
				inactiveReason: "Discord account is disabled or PluralKit is disabled for this account.",
				apply: (value) => {
					pluralkit.token = value;
				}
			});
		}
		if (hasOwnProperty(account, "voice") && isRecord(account.voice) && isRecord(account.voice.tts)) collectTtsApiKeyAssignments({
			tts: account.voice.tts,
			pathPrefix: `channels.discord.accounts.${accountId}.voice.tts`,
			defaults: params.defaults,
			context: params.context,
			active: enabled && isEnabledFlag(account.voice),
			inactiveReason: "Discord account is disabled or voice is disabled for this account."
		});
	}
}
function collectIrcAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const irc = channels.irc;
	if (!isRecord(irc)) return;
	const surface = resolveChannelAccountSurface(irc);
	collectSimpleChannelFieldAssignments({
		channelKey: "irc",
		field: "password",
		channel: irc,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level IRC password.",
		accountInactiveReason: "IRC account is disabled."
	});
	if (isRecord(irc.nickserv)) {
		const nickserv = irc.nickserv;
		collectSecretInputAssignment({
			value: nickserv.password,
			path: "channels.irc.nickserv.password",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: isBaseFieldActiveForChannelSurface(surface, "nickserv") && isEnabledFlag(nickserv),
			inactiveReason: "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
			apply: (value) => {
				nickserv.password = value;
			}
		});
	}
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) if (hasOwnProperty(account, "nickserv") && isRecord(account.nickserv)) {
		const nickserv = account.nickserv;
		collectSecretInputAssignment({
			value: nickserv.password,
			path: `channels.irc.accounts.${accountId}.nickserv.password`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && isEnabledFlag(nickserv),
			inactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
			apply: (value) => {
				nickserv.password = value;
			}
		});
	}
}
function collectBlueBubblesAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const bluebubbles = channels.bluebubbles;
	if (!isRecord(bluebubbles)) return;
	collectSimpleChannelFieldAssignments({
		channelKey: "bluebubbles",
		field: "password",
		channel: bluebubbles,
		surface: resolveChannelAccountSurface(bluebubbles),
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
		accountInactiveReason: "BlueBubbles account is disabled."
	});
}
function collectMSTeamsAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const msteams = channels.msteams;
	if (!isRecord(msteams)) return;
	collectSecretInputAssignment({
		value: msteams.appPassword,
		path: "channels.msteams.appPassword",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: msteams.enabled !== false,
		inactiveReason: "Microsoft Teams channel is disabled.",
		apply: (value) => {
			msteams.appPassword = value;
		}
	});
}
function collectMattermostAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const mattermost = channels.mattermost;
	if (!isRecord(mattermost)) return;
	collectSimpleChannelFieldAssignments({
		channelKey: "mattermost",
		field: "botToken",
		channel: mattermost,
		surface: resolveChannelAccountSurface(mattermost),
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
		accountInactiveReason: "Mattermost account is disabled."
	});
}
function collectMatrixAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const matrix = channels.matrix;
	if (!isRecord(matrix)) return;
	const surface = resolveChannelAccountSurface(matrix);
	const envAccessTokenConfigured = normalizeSecretStringValue(params.context.env.MATRIX_ACCESS_TOKEN).length > 0;
	const baseAccessTokenConfigured = hasConfiguredSecretInputValue(matrix.accessToken, params.defaults);
	const topLevelPasswordActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? !(baseAccessTokenConfigured || envAccessTokenConfigured) : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "password") && !hasConfiguredSecretInputValue(account.accessToken, params.defaults) && !(baseAccessTokenConfigured || envAccessTokenConfigured));
	collectSecretInputAssignment({
		value: matrix.password,
		path: "channels.matrix.password",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelPasswordActive,
		inactiveReason: "no enabled Matrix surface inherits this top-level password (an accessToken is configured).",
		apply: (value) => {
			matrix.password = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (!hasOwnProperty(account, "password")) continue;
		const accountAccessTokenConfigured = hasConfiguredSecretInputValue(account.accessToken, params.defaults);
		const inheritedAccessTokenConfigured = !hasOwnProperty(account, "accessToken") && (baseAccessTokenConfigured || envAccessTokenConfigured);
		collectSecretInputAssignment({
			value: account.password,
			path: `channels.matrix.accounts.${accountId}.password`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && !(accountAccessTokenConfigured || inheritedAccessTokenConfigured),
			inactiveReason: "Matrix account is disabled or an accessToken is configured.",
			apply: (value) => {
				account.password = value;
			}
		});
	}
}
function collectZaloAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const zalo = channels.zalo;
	if (!isRecord(zalo)) return;
	const surface = resolveChannelAccountSurface(zalo);
	const topLevelBotTokenActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? true : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "botToken"));
	collectSecretInputAssignment({
		value: zalo.botToken,
		path: "channels.zalo.botToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelBotTokenActive,
		inactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
		apply: (value) => {
			zalo.botToken = value;
		}
	});
	const baseWebhookUrl = normalizeSecretStringValue(zalo.webhookUrl);
	const topLevelWebhookSecretActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseWebhookUrl.length > 0 : surface.accounts.some(({ account, enabled }) => {
		if (!enabled || hasOwnProperty(account, "webhookSecret")) return false;
		return (hasOwnProperty(account, "webhookUrl") ? normalizeSecretStringValue(account.webhookUrl) : baseWebhookUrl).length > 0;
	});
	collectSecretInputAssignment({
		value: zalo.webhookSecret,
		path: "channels.zalo.webhookSecret",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelWebhookSecretActive,
		inactiveReason: "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
		apply: (value) => {
			zalo.webhookSecret = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (hasOwnProperty(account, "botToken")) collectSecretInputAssignment({
			value: account.botToken,
			path: `channels.zalo.accounts.${accountId}.botToken`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "Zalo account is disabled.",
			apply: (value) => {
				account.botToken = value;
			}
		});
		if (hasOwnProperty(account, "webhookSecret")) {
			const accountWebhookUrl = hasOwnProperty(account, "webhookUrl") ? normalizeSecretStringValue(account.webhookUrl) : baseWebhookUrl;
			collectSecretInputAssignment({
				value: account.webhookSecret,
				path: `channels.zalo.accounts.${accountId}.webhookSecret`,
				expected: "string",
				defaults: params.defaults,
				context: params.context,
				active: enabled && accountWebhookUrl.length > 0,
				inactiveReason: "Zalo account is disabled or webhook mode is not active for this account.",
				apply: (value) => {
					account.webhookSecret = value;
				}
			});
		}
	}
}
function collectFeishuAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const feishu = channels.feishu;
	if (!isRecord(feishu)) return;
	const surface = resolveChannelAccountSurface(feishu);
	collectSimpleChannelFieldAssignments({
		channelKey: "feishu",
		field: "appSecret",
		channel: feishu,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
		accountInactiveReason: "Feishu account is disabled."
	});
	const baseConnectionMode = normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
	const topLevelVerificationTokenActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? baseConnectionMode === "webhook" : surface.accounts.some(({ account, enabled }) => {
		if (!enabled || hasOwnProperty(account, "verificationToken")) return false;
		return (hasOwnProperty(account, "connectionMode") ? normalizeSecretStringValue(account.connectionMode) : baseConnectionMode) === "webhook";
	});
	collectSecretInputAssignment({
		value: feishu.verificationToken,
		path: "channels.feishu.verificationToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelVerificationTokenActive,
		inactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
		apply: (value) => {
			feishu.verificationToken = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (!hasOwnProperty(account, "verificationToken")) continue;
		const accountMode = hasOwnProperty(account, "connectionMode") ? normalizeSecretStringValue(account.connectionMode) : baseConnectionMode;
		collectSecretInputAssignment({
			value: account.verificationToken,
			path: `channels.feishu.accounts.${accountId}.verificationToken`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled && accountMode === "webhook",
			inactiveReason: "Feishu account is disabled or not running in webhook mode.",
			apply: (value) => {
				account.verificationToken = value;
			}
		});
	}
}
function collectNextcloudTalkAssignments(params) {
	const channels = params.config.channels;
	if (!isRecord(channels)) return;
	const nextcloudTalk = channels["nextcloud-talk"];
	if (!isRecord(nextcloudTalk)) return;
	const surface = resolveChannelAccountSurface(nextcloudTalk);
	const topLevelBotSecretActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? true : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "botSecret"));
	collectSecretInputAssignment({
		value: nextcloudTalk.botSecret,
		path: "channels.nextcloud-talk.botSecret",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelBotSecretActive,
		inactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
		apply: (value) => {
			nextcloudTalk.botSecret = value;
		}
	});
	const topLevelApiPasswordActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? true : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "apiPassword"));
	collectSecretInputAssignment({
		value: nextcloudTalk.apiPassword,
		path: "channels.nextcloud-talk.apiPassword",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: topLevelApiPasswordActive,
		inactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
		apply: (value) => {
			nextcloudTalk.apiPassword = value;
		}
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (hasOwnProperty(account, "botSecret")) collectSecretInputAssignment({
			value: account.botSecret,
			path: `channels.nextcloud-talk.accounts.${accountId}.botSecret`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "Nextcloud Talk account is disabled.",
			apply: (value) => {
				account.botSecret = value;
			}
		});
		if (hasOwnProperty(account, "apiPassword")) collectSecretInputAssignment({
			value: account.apiPassword,
			path: `channels.nextcloud-talk.accounts.${accountId}.apiPassword`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "Nextcloud Talk account is disabled.",
			apply: (value) => {
				account.apiPassword = value;
			}
		});
	}
}
function collectGoogleChatAccountAssignment(params) {
	const { explicitRef, ref } = resolveSecretInputRef({
		value: params.target.serviceAccount,
		refValue: params.target.serviceAccountRef,
		defaults: params.defaults
	});
	if (!ref) return;
	if (params.active === false) {
		pushInactiveSurfaceWarning({
			context: params.context,
			path: `${params.path}.serviceAccount`,
			details: params.inactiveReason
		});
		return;
	}
	if (explicitRef && params.target.serviceAccount !== void 0 && !coerceSecretRef(params.target.serviceAccount, params.defaults)) pushWarning(params.context, {
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: params.path,
		message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`
	});
	pushAssignment(params.context, {
		ref,
		path: `${params.path}.serviceAccount`,
		expected: "string-or-object",
		apply: (value) => {
			params.target.serviceAccount = value;
		}
	});
}
function collectGoogleChatAssignments(params) {
	const googleChatRecord = params.googleChat;
	const surface = resolveChannelAccountSurface(googleChatRecord);
	const topLevelServiceAccountActive = !surface.channelEnabled ? false : !surface.hasExplicitAccounts ? true : surface.accounts.some(({ account, enabled }) => enabled && !hasOwnProperty(account, "serviceAccount") && !hasOwnProperty(account, "serviceAccountRef"));
	collectGoogleChatAccountAssignment({
		target: params.googleChat,
		path: "channels.googlechat",
		defaults: params.defaults,
		context: params.context,
		active: topLevelServiceAccountActive,
		inactiveReason: "no enabled account inherits this top-level Google Chat serviceAccount."
	});
	if (!surface.hasExplicitAccounts) return;
	for (const { accountId, account, enabled } of surface.accounts) {
		if (!hasOwnProperty(account, "serviceAccount") && !hasOwnProperty(account, "serviceAccountRef")) continue;
		collectGoogleChatAccountAssignment({
			target: account,
			path: `channels.googlechat.accounts.${accountId}`,
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "Google Chat account is disabled."
		});
	}
}
function collectChannelConfigAssignments(params) {
	const googleChat = params.config.channels?.googlechat;
	if (googleChat) collectGoogleChatAssignments({
		googleChat,
		defaults: params.defaults,
		context: params.context
	});
	collectTelegramAssignments(params);
	collectSlackAssignments(params);
	collectDiscordAssignments(params);
	collectIrcAssignments(params);
	collectBlueBubblesAssignments(params);
	collectMattermostAssignments(params);
	collectMatrixAssignments(params);
	collectMSTeamsAssignments(params);
	collectNextcloudTalkAssignments(params);
	collectFeishuAssignments(params);
	collectZaloAssignments(params);
}

//#endregion
//#region src/secrets/runtime-gateway-auth-surfaces.ts
const GATEWAY_TOKEN_ENV_KEYS = ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"];
const GATEWAY_PASSWORD_ENV_KEYS = ["OPENCLAW_GATEWAY_PASSWORD", "CLAWDBOT_GATEWAY_PASSWORD"];
const GATEWAY_AUTH_SURFACE_PATHS = [
	"gateway.auth.token",
	"gateway.auth.password",
	"gateway.remote.token",
	"gateway.remote.password"
];
function readNonEmptyEnv(env, names) {
	for (const name of names) {
		const raw = env[name];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed.length > 0) return trimmed;
	}
}
function formatAuthMode(mode) {
	return mode ?? "unset";
}
function describeRemoteConfiguredSurface(parts) {
	const reasons = [];
	if (parts.remoteMode) reasons.push("gateway.mode is \"remote\"");
	if (parts.remoteUrlConfigured) reasons.push("gateway.remote.url is configured");
	if (parts.tailscaleRemoteExposure) reasons.push("gateway.tailscale.mode is \"serve\" or \"funnel\"");
	return reasons.join("; ");
}
function createState(params) {
	return {
		path: params.path,
		active: params.active,
		reason: params.reason,
		hasSecretRef: params.hasSecretRef
	};
}
function evaluateGatewayAuthSurfaceStates(params) {
	const defaults = params.defaults ?? params.config.secrets?.defaults;
	const gateway = params.config.gateway;
	if (!isRecord(gateway)) return {
		"gateway.auth.token": createState({
			path: "gateway.auth.token",
			active: false,
			reason: "gateway configuration is not set.",
			hasSecretRef: false
		}),
		"gateway.auth.password": createState({
			path: "gateway.auth.password",
			active: false,
			reason: "gateway configuration is not set.",
			hasSecretRef: false
		}),
		"gateway.remote.token": createState({
			path: "gateway.remote.token",
			active: false,
			reason: "gateway configuration is not set.",
			hasSecretRef: false
		}),
		"gateway.remote.password": createState({
			path: "gateway.remote.password",
			active: false,
			reason: "gateway configuration is not set.",
			hasSecretRef: false
		})
	};
	const auth = isRecord(gateway?.auth) ? gateway.auth : void 0;
	const remote = isRecord(gateway?.remote) ? gateway.remote : void 0;
	const authMode = auth && typeof auth.mode === "string" ? auth.mode : void 0;
	const hasAuthTokenRef = coerceSecretRef(auth?.token, defaults) !== null;
	const hasAuthPasswordRef = coerceSecretRef(auth?.password, defaults) !== null;
	const hasRemoteTokenRef = coerceSecretRef(remote?.token, defaults) !== null;
	const hasRemotePasswordRef = coerceSecretRef(remote?.password, defaults) !== null;
	const envToken = readNonEmptyEnv(params.env, GATEWAY_TOKEN_ENV_KEYS);
	const envPassword = readNonEmptyEnv(params.env, GATEWAY_PASSWORD_ENV_KEYS);
	const localTokenConfigured = hasConfiguredSecretInput(auth?.token, defaults);
	const localPasswordConfigured = hasConfiguredSecretInput(auth?.password, defaults);
	const remoteTokenConfigured = hasConfiguredSecretInput(remote?.token, defaults);
	const passwordSourceConfigured = Boolean(envPassword || localPasswordConfigured);
	const localTokenCanWin = authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
	const localTokenSurfaceActive = localTokenCanWin && !envToken && (authMode === "token" || authMode === void 0 && !passwordSourceConfigured);
	const passwordCanWin = authMode === "password" || authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !Boolean(envToken || localTokenConfigured || remoteTokenConfigured);
	const remoteMode = gateway?.mode === "remote";
	const remoteUrlConfigured = typeof remote?.url === "string" && remote.url.trim().length > 0;
	const tailscale = isRecord(gateway?.tailscale) && typeof gateway.tailscale.mode === "string" ? gateway.tailscale : void 0;
	const tailscaleRemoteExposure = tailscale?.mode === "serve" || tailscale?.mode === "funnel";
	const remoteEnabled = remote?.enabled !== false;
	const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
	const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localTokenConfigured;
	const remoteTokenActive = remoteEnabled && (remoteConfiguredSurface || remoteTokenFallbackActive);
	const remotePasswordFallbackActive = !envPassword && !localPasswordConfigured && passwordCanWin;
	const remotePasswordActive = remoteEnabled && (remoteConfiguredSurface || remotePasswordFallbackActive);
	const authPasswordReason = (() => {
		if (!auth) return "gateway.auth is not configured.";
		if (passwordCanWin) return authMode === "password" ? "gateway.auth.mode is \"password\"." : "no token source can win, so password auth can win.";
		if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") return `gateway.auth.mode is "${authMode}".`;
		if (envToken) return "gateway token env var is configured.";
		if (localTokenConfigured) return "gateway.auth.token is configured.";
		if (remoteTokenConfigured) return "gateway.remote.token is configured.";
		return "token auth can win.";
	})();
	const authTokenReason = (() => {
		if (!auth) return "gateway.auth is not configured.";
		if (authMode === "token") return envToken ? "gateway token env var is configured." : "gateway.auth.mode is \"token\".";
		if (authMode === "password" || authMode === "none" || authMode === "trusted-proxy") return `gateway.auth.mode is "${authMode}".`;
		if (envToken) return "gateway token env var is configured.";
		if (envPassword) return "gateway password env var is configured.";
		if (localPasswordConfigured) return "gateway.auth.password is configured.";
		return "token auth can win (mode is unset and no password source is configured).";
	})();
	const remoteSurfaceReason = describeRemoteConfiguredSurface({
		remoteMode,
		remoteUrlConfigured,
		tailscaleRemoteExposure
	});
	const remoteTokenReason = (() => {
		if (!remote) return "gateway.remote is not configured.";
		if (!remoteEnabled) return "gateway.remote.enabled is false.";
		if (remoteConfiguredSurface) return `remote surface is active: ${remoteSurfaceReason}.`;
		if (remoteTokenFallbackActive) return "local token auth can win and no env/auth token is configured.";
		if (!localTokenCanWin) return `token auth cannot win with gateway.auth.mode="${formatAuthMode(authMode)}".`;
		if (envToken) return "gateway token env var is configured.";
		if (localTokenConfigured) return "gateway.auth.token is configured.";
		return "remote token fallback is not active.";
	})();
	const remotePasswordReason = (() => {
		if (!remote) return "gateway.remote is not configured.";
		if (!remoteEnabled) return "gateway.remote.enabled is false.";
		if (remoteConfiguredSurface) return `remote surface is active: ${remoteSurfaceReason}.`;
		if (remotePasswordFallbackActive) return "password auth can win and no env/auth password is configured.";
		if (!passwordCanWin) {
			if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") return `password auth cannot win with gateway.auth.mode="${authMode}".`;
			return "a token source can win, so password auth cannot win.";
		}
		if (envPassword) return "gateway password env var is configured.";
		if (localPasswordConfigured) return "gateway.auth.password is configured.";
		return "remote password fallback is not active.";
	})();
	return {
		"gateway.auth.token": createState({
			path: "gateway.auth.token",
			active: localTokenSurfaceActive,
			reason: authTokenReason,
			hasSecretRef: hasAuthTokenRef
		}),
		"gateway.auth.password": createState({
			path: "gateway.auth.password",
			active: passwordCanWin,
			reason: authPasswordReason,
			hasSecretRef: hasAuthPasswordRef
		}),
		"gateway.remote.token": createState({
			path: "gateway.remote.token",
			active: remoteTokenActive,
			reason: remoteTokenReason,
			hasSecretRef: hasRemoteTokenRef
		}),
		"gateway.remote.password": createState({
			path: "gateway.remote.password",
			active: remotePasswordActive,
			reason: remotePasswordReason,
			hasSecretRef: hasRemotePasswordRef
		})
	};
}

//#endregion
//#region src/secrets/runtime-config-collectors-core.ts
function collectModelProviderAssignments(params) {
	for (const [providerId, provider] of Object.entries(params.providers)) collectSecretInputAssignment({
		value: provider.apiKey,
		path: `models.providers.${providerId}.apiKey`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: provider.enabled !== false,
		inactiveReason: "provider is disabled.",
		apply: (value) => {
			provider.apiKey = value;
		}
	});
}
function collectSkillAssignments(params) {
	for (const [skillKey, entry] of Object.entries(params.entries)) collectSecretInputAssignment({
		value: entry.apiKey,
		path: `skills.entries.${skillKey}.apiKey`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: entry.enabled !== false,
		inactiveReason: "skill entry is disabled.",
		apply: (value) => {
			entry.apiKey = value;
		}
	});
}
function collectAgentMemorySearchAssignments(params) {
	const agents = params.config.agents;
	if (!isRecord(agents)) return;
	const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : void 0;
	const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch) ? defaultsConfig.memorySearch : void 0;
	const defaultsEnabled = defaultsMemorySearch?.enabled !== false;
	const list = Array.isArray(agents.list) ? agents.list : [];
	let hasEnabledAgentWithoutOverride = false;
	for (const rawAgent of list) {
		if (!isRecord(rawAgent)) continue;
		if (rawAgent.enabled === false) continue;
		const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : void 0;
		if (memorySearch?.enabled === false) continue;
		if (!memorySearch || !Object.prototype.hasOwnProperty.call(memorySearch, "remote")) {
			hasEnabledAgentWithoutOverride = true;
			continue;
		}
		const remote = isRecord(memorySearch.remote) ? memorySearch.remote : void 0;
		if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
			hasEnabledAgentWithoutOverride = true;
			continue;
		}
	}
	if (defaultsMemorySearch && isRecord(defaultsMemorySearch.remote)) {
		const remote = defaultsMemorySearch.remote;
		collectSecretInputAssignment({
			value: remote.apiKey,
			path: "agents.defaults.memorySearch.remote.apiKey",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: defaultsEnabled && (hasEnabledAgentWithoutOverride || list.length === 0),
			inactiveReason: hasEnabledAgentWithoutOverride ? void 0 : "all enabled agents override memorySearch.remote.apiKey.",
			apply: (value) => {
				remote.apiKey = value;
			}
		});
	}
	list.forEach((rawAgent, index) => {
		if (!isRecord(rawAgent)) return;
		const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : void 0;
		if (!memorySearch) return;
		const remote = isRecord(memorySearch.remote) ? memorySearch.remote : void 0;
		if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) return;
		const enabled = rawAgent.enabled !== false && memorySearch.enabled !== false;
		collectSecretInputAssignment({
			value: remote.apiKey,
			path: `agents.list.${index}.memorySearch.remote.apiKey`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "agent or memorySearch override is disabled.",
			apply: (value) => {
				remote.apiKey = value;
			}
		});
	});
}
function collectTalkAssignments(params) {
	const talk = params.config.talk;
	if (!isRecord(talk)) return;
	collectSecretInputAssignment({
		value: talk.apiKey,
		path: "talk.apiKey",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		apply: (value) => {
			talk.apiKey = value;
		}
	});
	const providers = talk.providers;
	if (!isRecord(providers)) return;
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		if (!isRecord(providerConfig)) continue;
		collectSecretInputAssignment({
			value: providerConfig.apiKey,
			path: `talk.providers.${providerId}.apiKey`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			apply: (value) => {
				providerConfig.apiKey = value;
			}
		});
	}
}
function collectGatewayAssignments(params) {
	const gateway = params.config.gateway;
	if (!isRecord(gateway)) return;
	const auth = isRecord(gateway.auth) ? gateway.auth : void 0;
	const remote = isRecord(gateway.remote) ? gateway.remote : void 0;
	const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
		config: params.config,
		env: params.context.env,
		defaults: params.defaults
	});
	if (auth) {
		collectSecretInputAssignment({
			value: auth.token,
			path: "gateway.auth.token",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.auth.token"].active,
			inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
			apply: (value) => {
				auth.token = value;
			}
		});
		collectSecretInputAssignment({
			value: auth.password,
			path: "gateway.auth.password",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.auth.password"].active,
			inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
			apply: (value) => {
				auth.password = value;
			}
		});
	}
	if (remote) {
		collectSecretInputAssignment({
			value: remote.token,
			path: "gateway.remote.token",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.remote.token"].active,
			inactiveReason: gatewaySurfaceStates["gateway.remote.token"].reason,
			apply: (value) => {
				remote.token = value;
			}
		});
		collectSecretInputAssignment({
			value: remote.password,
			path: "gateway.remote.password",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.remote.password"].active,
			inactiveReason: gatewaySurfaceStates["gateway.remote.password"].reason,
			apply: (value) => {
				remote.password = value;
			}
		});
	}
}
function collectMessagesTtsAssignments(params) {
	const messages = params.config.messages;
	if (!isRecord(messages) || !isRecord(messages.tts)) return;
	collectTtsApiKeyAssignments({
		tts: messages.tts,
		pathPrefix: "messages.tts",
		defaults: params.defaults,
		context: params.context
	});
}
function collectToolsWebSearchAssignments(params) {
	const tools = params.config.tools;
	if (!isRecord(tools) || !isRecord(tools.web) || !isRecord(tools.web.search)) return;
	const search = tools.web.search;
	const searchEnabled = search.enabled !== false;
	const rawProvider = typeof search.provider === "string" ? search.provider.trim().toLowerCase() : "";
	const selectedProvider = rawProvider === "brave" || rawProvider === "gemini" || rawProvider === "grok" || rawProvider === "kimi" || rawProvider === "perplexity" ? rawProvider : void 0;
	for (const path of [
		"apiKey",
		"gemini.apiKey",
		"grok.apiKey",
		"kimi.apiKey",
		"perplexity.apiKey"
	]) {
		const [scope, field] = path.includes(".") ? path.split(".", 2) : [void 0, path];
		const target = scope ? search[scope] : search;
		if (!isRecord(target)) continue;
		const active = scope ? searchEnabled && (selectedProvider === void 0 || selectedProvider === scope) : searchEnabled && (selectedProvider === void 0 || selectedProvider === "brave");
		const inactiveReason = !searchEnabled ? "tools.web.search is disabled." : scope ? selectedProvider === void 0 ? void 0 : `tools.web.search.provider is "${selectedProvider}".` : selectedProvider === void 0 ? void 0 : `tools.web.search.provider is "${selectedProvider}".`;
		collectSecretInputAssignment({
			value: target[field],
			path: `tools.web.search.${path}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active,
			inactiveReason,
			apply: (value) => {
				target[field] = value;
			}
		});
	}
}
function collectCronAssignments(params) {
	const cron = params.config.cron;
	if (!isRecord(cron)) return;
	collectSecretInputAssignment({
		value: cron.webhookToken,
		path: "cron.webhookToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		apply: (value) => {
			cron.webhookToken = value;
		}
	});
}
function collectCoreConfigAssignments(params) {
	const providers = params.config.models?.providers;
	if (providers) collectModelProviderAssignments({
		providers,
		defaults: params.defaults,
		context: params.context
	});
	const skillEntries = params.config.skills?.entries;
	if (skillEntries) collectSkillAssignments({
		entries: skillEntries,
		defaults: params.defaults,
		context: params.context
	});
	collectAgentMemorySearchAssignments(params);
	collectTalkAssignments(params);
	collectGatewayAssignments(params);
	collectMessagesTtsAssignments(params);
	collectToolsWebSearchAssignments(params);
	collectCronAssignments(params);
}

//#endregion
//#region src/secrets/runtime-config-collectors.ts
function collectConfigAssignments(params) {
	const defaults = params.context.sourceConfig.secrets?.defaults;
	collectCoreConfigAssignments({
		config: params.config,
		defaults,
		context: params.context
	});
	collectChannelConfigAssignments({
		config: params.config,
		defaults,
		context: params.context
	});
}

//#endregion
export { setPathExistingStrict as C, setPathCreateStrict as S, assertExpectedResolvedSecretValue as _, createResolverContext as a, deletePathStrict as b, collectCommandSecretAssignmentsFromSnapshot as c, discoverConfigSecretTargetsByIds as d, isKnownSecretTargetId as f, resolvePlanTargetAgainstRegistry as g, listSecretTargetRegistryEntries as h, applyResolvedAssignments as i, discoverAuthProfileSecretTargets as l, listAuthProfileSecretTargetEntries as m, GATEWAY_AUTH_SURFACE_PATHS as n, pushAssignment as o, isKnownSecretTargetType as p, evaluateGatewayAuthSurfaceStates as r, pushWarning as s, collectConfigAssignments as t, discoverConfigSecretTargets as u, hasConfiguredPlaintextSecretValue as v, getPath as x, isExpectedResolvedSecretValue as y };