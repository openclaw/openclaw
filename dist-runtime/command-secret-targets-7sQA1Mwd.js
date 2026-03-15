import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
//#region src/secrets/shared.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function parseEnvValue(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) {return trimmed.slice(1, -1);}
	return trimmed;
}
function normalizePositiveInt(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value)) {return Math.max(1, Math.floor(value));}
	return Math.max(1, Math.floor(fallback));
}
function parseDotPath(pathname) {
	return pathname.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
function toDotPath(segments) {
	return segments.join(".");
}
function ensureDirForFile(filePath) {
	fs.mkdirSync(path.dirname(filePath), {
		recursive: true,
		mode: 448
	});
}
function writeTextFileAtomic(pathname, value, mode = 384) {
	ensureDirForFile(pathname);
	const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tempPath, value, "utf8");
	fs.chmodSync(tempPath, mode);
	fs.renameSync(tempPath, pathname);
}
function describeUnknownError(err) {
	if (err instanceof Error && err.message.trim().length > 0) {return err.message;}
	if (typeof err === "string" && err.trim().length > 0) {return err;}
	if (typeof err === "number" || typeof err === "bigint") {return err.toString();}
	if (typeof err === "boolean") {return err ? "true" : "false";}
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
//#endregion
//#region src/secrets/path-utils.ts
function isArrayIndexSegment(segment) {
	return /^\d+$/.test(segment);
}
function expectedContainer(nextSegment) {
	return isArrayIndexSegment(nextSegment) ? "array" : "object";
}
function parseArrayLeafTarget(cursor, leaf, segments) {
	if (!Array.isArray(cursor)) {return null;}
	if (!isArrayIndexSegment(leaf)) {throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);}
	return {
		array: cursor,
		index: Number.parseInt(leaf, 10)
	};
}
function traverseToLeafParent(params) {
	if (params.segments.length === 0) {throw new Error("Target path is empty.");}
	let cursor = params.root;
	for (let index = 0; index < params.segments.length - 1; index += 1) {
		const segment = params.segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) {throw new Error(`Invalid array index segment "${segment}" at ${params.segments.join(".")}.`);}
			const arrayIndex = Number.parseInt(segment, 10);
			if (params.requireExistingSegment && (arrayIndex < 0 || arrayIndex >= cursor.length)) {throw new Error(`Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`);}
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) {throw new Error(`Invalid path shape at ${params.segments.slice(0, index).join(".") || "<root>"}.`);}
		if (params.requireExistingSegment && !Object.prototype.hasOwnProperty.call(cursor, segment)) {throw new Error(`Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`);}
		cursor = cursor[segment];
	}
	return cursor;
}
function getPath(root, segments) {
	if (segments.length === 0) {return;}
	let cursor = root;
	for (const segment of segments) {
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) {return;}
			cursor = cursor[Number.parseInt(segment, 10)];
			continue;
		}
		if (!isRecord(cursor)) {return;}
		cursor = cursor[segment];
	}
	return cursor;
}
function setPathCreateStrict(root, segments, value) {
	if (segments.length === 0) {throw new Error("Target path is empty.");}
	let cursor = root;
	let changed = false;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index] ?? "";
		const needs = expectedContainer(segments[index + 1] ?? "");
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) {throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);}
			const arrayIndex = Number.parseInt(segment, 10);
			const existing = cursor[arrayIndex];
			if (existing === void 0 || existing === null) {
				cursor[arrayIndex] = needs === "array" ? [] : {};
				changed = true;
			} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) {throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);}
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) {throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);}
		const existing = cursor[segment];
		if (existing === void 0 || existing === null) {
			cursor[segment] = needs === "array" ? [] : {};
			changed = true;
		} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) {throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);}
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
			arrayTarget.array[arrayTarget.index] = value;
			changed = true;
		}
		return changed;
	}
	if (!isRecord(cursor)) {throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);}
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		changed = true;
	}
	return changed;
}
function setPathExistingStrict(root, segments, value) {
	const cursor = traverseToLeafParent({
		root,
		segments,
		requireExistingSegment: true
	});
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) {throw new Error(`Path segment does not exist at ${segments.join(".")}.`);}
		if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
			arrayTarget.array[arrayTarget.index] = value;
			return true;
		}
		return false;
	}
	if (!isRecord(cursor)) {throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);}
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) {throw new Error(`Path segment does not exist at ${segments.join(".")}.`);}
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		return true;
	}
	return false;
}
function deletePathStrict(root, segments) {
	const cursor = traverseToLeafParent({
		root,
		segments,
		requireExistingSegment: false
	});
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) {return false;}
		arrayTarget.array.splice(arrayTarget.index, 1);
		return true;
	}
	if (!isRecord(cursor)) {throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);}
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) {return false;}
	delete cursor[leaf];
	return true;
}
//#endregion
//#region src/secrets/target-registry-data.ts
const SECRET_INPUT_SHAPE = "secret_input";
const SIBLING_REF_SHAPE = "sibling_ref";
const SECRET_TARGET_REGISTRY = [
	{
		id: "auth-profiles.api_key.key",
		targetType: "auth-profiles.api_key.key",
		configFile: "auth-profiles.json",
		pathPattern: "profiles.*.key",
		refPathPattern: "profiles.*.keyRef",
		secretShape: SIBLING_REF_SHAPE,
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
		secretShape: SIBLING_REF_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.accounts.*.encryptKey",
		targetType: "channels.feishu.accounts.*.encryptKey",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.accounts.*.encryptKey",
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.feishu.encryptKey",
		targetType: "channels.feishu.encryptKey",
		configFile: "openclaw.json",
		pathPattern: "channels.feishu.encryptKey",
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SIBLING_REF_SHAPE,
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
		secretShape: SIBLING_REF_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2,
		trackProviderShadowing: true
	},
	{
		id: "models.providers.*.headers.*",
		targetType: "models.providers.headers",
		targetTypeAliases: ["models.providers.*.headers.*"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.headers.*",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "skills.entries.*.apiKey",
		targetType: "skills.entries.apiKey",
		targetTypeAliases: ["skills.entries.*.apiKey"],
		configFile: "openclaw.json",
		pathPattern: "skills.entries.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.fetch.firecrawl.apiKey",
		targetType: "tools.web.fetch.firecrawl.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.fetch.firecrawl.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		secretShape: SECRET_INPUT_SHAPE,
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
		if (segment === "*") {return { kind: "wildcard" };}
		if (segment.endsWith("[]")) {
			const field = segment.slice(0, -2).trim();
			if (!field) {throw new Error(`Invalid target path pattern: ${pathPattern}`);}
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
	if (entry.secretShape === "sibling_ref" && !refPathTokens) {throw new Error(`Missing refPathPattern for sibling_ref target: ${entry.id}`);}
	if (refPathTokens && refPathDynamicTokenCount !== pathDynamicTokenCount) {throw new Error(`Mismatched wildcard shape for target ref path: ${entry.id}`);}
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
			if (segments[index] !== token.value) {return null;}
			index += 1;
			continue;
		}
		if (token.kind === "wildcard") {
			const value = segments[index];
			if (!value) {return null;}
			captures.push(value);
			index += 1;
			continue;
		}
		if (segments[index] !== token.field) {return null;}
		const next = segments[index + 1];
		if (!next || !/^\d+$/.test(next)) {return null;}
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
			if (!value) {return null;}
			out.push(value);
			captureIndex += 1;
			continue;
		}
		const arrayIndex = captures[captureIndex];
		if (!arrayIndex || !/^\d+$/.test(arrayIndex)) {return null;}
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
			if (!isRecord(node)) {return;}
			if (isLeaf) {
				out.push({
					segments: [...segments, token.value],
					captures,
					value: node[token.value]
				});
				return;
			}
			if (!Object.prototype.hasOwnProperty.call(node, token.value)) {return;}
			walk(node[token.value], tokenIndex + 1, [...segments, token.value], captures);
			return;
		}
		if (token.kind === "wildcard") {
			if (!isRecord(node)) {return;}
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
		if (!isRecord(node)) {return;}
		const items = node[token.field];
		if (!Array.isArray(items)) {return;}
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
		for (const alias of entry.targetTypeAliases ?? []) {append(alias, entry);}
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
function normalizeAllowedTargetIds(targetIds) {
	if (targetIds === void 0) {return null;}
	return new Set(Array.from(targetIds).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}
function resolveDiscoveryEntries(params) {
	if (params.allowedTargetIds === null) {return params.defaultEntries;}
	return Array.from(params.allowedTargetIds).flatMap((targetId) => params.entriesById.get(targetId) ?? []);
}
function discoverSecretTargetsFromEntries(source, discoveryEntries) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of discoveryEntries) {
		const expanded = expandPathTokens(source, entry.pathTokens);
		for (const match of expanded) {
			const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
			if (!resolved) {continue;}
			const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
			if (seen.has(key)) {continue;}
			seen.add(key);
			const refValue = resolved.refPathSegments ? getPath(source, resolved.refPathSegments) : void 0;
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
function toResolvedPlanTarget(entry, pathSegments, captures) {
	const providerId = entry.providerIdPathSegmentIndex !== void 0 ? pathSegments[entry.providerIdPathSegmentIndex] : void 0;
	const accountId = entry.accountIdPathSegmentIndex !== void 0 ? pathSegments[entry.accountIdPathSegmentIndex] : void 0;
	const refPathSegments = entry.refPathTokens ? materializePathTokens(entry.refPathTokens, captures) : void 0;
	if (entry.refPathTokens && !refPathSegments) {return null;}
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
	if (!entries || entries.length === 0) {return null;}
	for (const entry of entries) {
		if (!entry.includeInPlan) {continue;}
		const matched = matchPathTokens(candidate.pathSegments, entry.pathTokens);
		if (!matched) {continue;}
		const resolved = toResolvedPlanTarget(entry, candidate.pathSegments, matched.captures);
		if (!resolved) {continue;}
		if (candidate.providerId && candidate.providerId.trim().length > 0) {
			if (!resolved.providerId || resolved.providerId !== candidate.providerId) {continue;}
		}
		if (candidate.accountId && candidate.accountId.trim().length > 0) {
			if (!resolved.accountId || resolved.accountId !== candidate.accountId) {continue;}
		}
		return resolved;
	}
	return null;
}
function discoverConfigSecretTargets(config) {
	return discoverConfigSecretTargetsByIds(config);
}
function discoverConfigSecretTargetsByIds(config, targetIds) {
	return discoverSecretTargetsFromEntries(config, resolveDiscoveryEntries({
		allowedTargetIds: normalizeAllowedTargetIds(targetIds),
		defaultEntries: OPENCLAW_COMPILED_SECRET_TARGETS,
		entriesById: OPENCLAW_TARGETS_BY_ID
	}));
}
function discoverAuthProfileSecretTargets(store) {
	return discoverAuthProfileSecretTargetsByIds(store);
}
function discoverAuthProfileSecretTargetsByIds(store, targetIds) {
	return discoverSecretTargetsFromEntries(store, resolveDiscoveryEntries({
		allowedTargetIds: normalizeAllowedTargetIds(targetIds),
		defaultEntries: AUTH_PROFILES_COMPILED_SECRET_TARGETS,
		entriesById: AUTH_PROFILES_TARGETS_BY_ID
	}));
}
function listAuthProfileSecretTargetEntries() {
	return COMPILED_SECRET_TARGET_REGISTRY.filter((entry) => entry.configFile === "auth-profiles.json" && entry.includeInAudit);
}
//#endregion
//#region src/cli/command-secret-targets.ts
function idsByPrefix(prefixes) {
	return listSecretTargetRegistryEntries().map((entry) => entry.id).filter((id) => prefixes.some((prefix) => id.startsWith(prefix))).toSorted();
}
const COMMAND_SECRET_TARGETS = {
	memory: ["agents.defaults.memorySearch.remote.apiKey", "agents.list[].memorySearch.remote.apiKey"],
	qrRemote: ["gateway.remote.token", "gateway.remote.password"],
	channels: idsByPrefix(["channels."]),
	models: idsByPrefix(["models.providers."]),
	agentRuntime: idsByPrefix([
		"channels.",
		"models.providers.",
		"agents.defaults.memorySearch.remote.",
		"agents.list[].memorySearch.remote.",
		"skills.entries.",
		"messages.tts.",
		"tools.web.search",
		"tools.web.fetch.firecrawl."
	]),
	status: idsByPrefix([
		"channels.",
		"agents.defaults.memorySearch.remote.",
		"agents.list[].memorySearch.remote."
	]),
	securityAudit: idsByPrefix([
		"channels.",
		"gateway.auth.",
		"gateway.remote."
	])
};
function toTargetIdSet(values) {
	return new Set(values);
}
function getMemoryCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.memory);
}
function getQrRemoteCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.qrRemote);
}
function getChannelsCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.channels);
}
function getModelsCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.models);
}
function getAgentRuntimeCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.agentRuntime);
}
function getStatusCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.status);
}
function getSecurityAuditCommandSecretTargetIds() {
	return toTargetIdSet(COMMAND_SECRET_TARGETS.securityAudit);
}
//#endregion
export { parseDotPath as C, writeTextFileAtomic as E, normalizePositiveInt as S, toDotPath as T, setPathCreateStrict as _, getQrRemoteCommandSecretTargetIds as a, isNonEmptyString as b, discoverAuthProfileSecretTargets as c, isKnownSecretTargetId as d, isKnownSecretTargetType as f, getPath as g, deletePathStrict as h, getModelsCommandSecretTargetIds as i, discoverConfigSecretTargets as l, resolvePlanTargetAgainstRegistry as m, getChannelsCommandSecretTargetIds as n, getSecurityAuditCommandSecretTargetIds as o, listAuthProfileSecretTargetEntries as p, getMemoryCommandSecretTargetIds as r, getStatusCommandSecretTargetIds as s, getAgentRuntimeCommandSecretTargetIds as t, discoverConfigSecretTargetsByIds as u, setPathExistingStrict as v, parseEnvValue as w, isRecord as x, describeUnknownError as y };
