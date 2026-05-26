import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { d as createGoogleMeetSpace, t as createMeetWithBrowserProxyOnNode } from "./chrome-create-D3QLc7OZ.js";
import { o as resolveGoogleMeetAccessToken } from "./oauth-BKYaLd7f.js";
//#region extensions/google-meet/src/create.ts
function normalizeTransport(value) {
	return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : void 0;
}
function normalizeMode(value) {
	if (value === "realtime") return "agent";
	return value === "agent" || value === "bidi" || value === "transcribe" ? value : void 0;
}
function normalizeGoogleMeetAccessType(value) {
	const normalized = normalizeOptionalString(value)?.toUpperCase().replaceAll("-", "_");
	return normalized === "OPEN" || normalized === "TRUSTED" || normalized === "RESTRICTED" ? normalized : void 0;
}
function normalizeGoogleMeetEntryPointAccess(value) {
	const normalized = normalizeOptionalString(value)?.toUpperCase().replaceAll("-", "_");
	return normalized === "ALL" || normalized === "CREATOR_APP_ONLY" ? normalized : void 0;
}
function resolveCreateSpaceConfig(raw) {
	const rawAccessType = normalizeOptionalString(raw.accessType);
	const rawEntryPointAccess = normalizeOptionalString(raw.entryPointAccess);
	const accessType = normalizeGoogleMeetAccessType(raw.accessType);
	const entryPointAccess = normalizeGoogleMeetEntryPointAccess(raw.entryPointAccess);
	if (rawAccessType !== void 0 && !accessType) throw new Error("Invalid Google Meet accessType. Expected OPEN, TRUSTED, or RESTRICTED.");
	if (rawEntryPointAccess !== void 0 && !entryPointAccess) throw new Error("Invalid Google Meet entryPointAccess. Expected ALL or CREATOR_APP_ONLY.");
	const config = {
		...accessType ? { accessType } : {},
		...entryPointAccess ? { entryPointAccess } : {}
	};
	return Object.keys(config).length > 0 ? config : void 0;
}
function hasCreateSpaceConfigInput(raw) {
	return normalizeOptionalString(raw.accessType) !== void 0 || normalizeOptionalString(raw.entryPointAccess) !== void 0;
}
async function createSpaceFromParams(config, raw) {
	const token = await resolveGoogleMeetAccessToken({
		clientId: normalizeOptionalString(raw.clientId) ?? config.oauth.clientId,
		clientSecret: normalizeOptionalString(raw.clientSecret) ?? config.oauth.clientSecret,
		refreshToken: normalizeOptionalString(raw.refreshToken) ?? config.oauth.refreshToken,
		accessToken: normalizeOptionalString(raw.accessToken) ?? config.oauth.accessToken,
		expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt
	});
	return {
		source: "api",
		token,
		...await createGoogleMeetSpace({
			accessToken: token.accessToken,
			config: resolveCreateSpaceConfig(raw)
		})
	};
}
function hasGoogleMeetOAuth(config, raw) {
	return Boolean(normalizeOptionalString(raw.accessToken) ?? normalizeOptionalString(raw.refreshToken) ?? config.oauth.accessToken ?? config.oauth.refreshToken);
}
async function createMeetFromParams(params) {
	if (hasGoogleMeetOAuth(params.config, params.raw)) {
		const { token: _token, ...result } = await createSpaceFromParams(params.config, params.raw);
		return {
			...result,
			joined: false,
			nextAction: "URL-only creation was requested. Call google_meet with action=join and url=meetingUri to enter the meeting."
		};
	}
	if (hasCreateSpaceConfigInput(params.raw)) throw new Error("Google Meet access policy options require OAuth/API room creation. Configure Google Meet OAuth or remove accessType/entryPointAccess.");
	const browser = await createMeetWithBrowserProxyOnNode({
		runtime: params.runtime,
		config: params.config
	});
	return {
		source: browser.source,
		meetingUri: browser.meetingUri,
		joined: false,
		nextAction: "URL-only creation was requested. Call google_meet with action=join and url=meetingUri to enter the meeting.",
		space: {
			name: `browser/${browser.meetingUri.split("/").pop()}`,
			meetingUri: browser.meetingUri
		},
		browser: {
			nodeId: browser.nodeId,
			targetId: browser.targetId,
			browserUrl: browser.browserUrl,
			browserTitle: browser.browserTitle,
			notes: browser.notes
		}
	};
}
async function createAndJoinMeetFromParams(params) {
	const created = await createMeetFromParams(params);
	const join = await (await params.ensureRuntime()).join({
		url: created.meetingUri,
		transport: normalizeTransport(params.raw.transport),
		mode: normalizeMode(params.raw.mode),
		dialInNumber: normalizeOptionalString(params.raw.dialInNumber),
		pin: normalizeOptionalString(params.raw.pin),
		dtmfSequence: normalizeOptionalString(params.raw.dtmfSequence),
		message: normalizeOptionalString(params.raw.message),
		requesterSessionKey: normalizeOptionalString(params.raw.requesterSessionKey)
	});
	return {
		...created,
		joined: true,
		nextAction: "Share meetingUri with participants; the OpenClaw agent has started the join flow.",
		join
	};
}
//#endregion
export { resolveCreateSpaceConfig as i, createMeetFromParams as n, hasCreateSpaceConfigInput as r, createAndJoinMeetFromParams as t };
