import { a as __toCommonJS } from "./chunk-DORXReHP.js";
import { i as init_paths, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { a as init_registry, d as getActivePluginRegistry, l as normalizeChatChannelId, m as init_runtime, u as registry_exports } from "./registry-ep1yQ6WN.js";
import { n as ENV_SECRET_REF_ID_RE, o as init_types_secrets, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-Cu0Lz6pi.js";
import { n as logError, t as logDebug } from "./logger-DLmJXd-S.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import { a as isLoopbackHost, o as isSecureWebSocketUrl, t as normalizeDeviceMetadataForAuth } from "./device-metadata-normalization-a2oQYp64.js";
import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
import AjvPkg from "ajv";
import { Type } from "@sinclair/typebox";
//#region src/secrets/ref-contract.ts
init_types_secrets();
const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SINGLE_VALUE_FILE_REF_ID = "value";
const FILE_SECRET_REF_ID_PATTERN = /^(?:value|\/(?:[^~]|~0|~1)*(?:\/(?:[^~]|~0|~1)*)*)$/;
const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN = "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
function secretRefKey(ref) {
	return `${ref.source}:${ref.provider}:${ref.id}`;
}
function resolveDefaultSecretProviderAlias(config, source, options) {
	const configured = source === "env" ? config.secrets?.defaults?.env : source === "file" ? config.secrets?.defaults?.file : config.secrets?.defaults?.exec;
	if (configured?.trim()) return configured.trim();
	if (options?.preferFirstProviderForSource) {
		const providers = config.secrets?.providers;
		if (providers) {
			for (const [providerName, provider] of Object.entries(providers)) if (provider?.source === source) return providerName;
		}
	}
	return DEFAULT_SECRET_PROVIDER_ALIAS;
}
function isValidFileSecretRefId(value) {
	if (value === "value") return true;
	if (!value.startsWith("/")) return false;
	return value.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}
function isValidSecretProviderAlias(value) {
	return SECRET_PROVIDER_ALIAS_PATTERN.test(value);
}
function validateExecSecretRefId(value) {
	if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) return {
		ok: false,
		reason: "pattern"
	};
	for (const segment of value.split("/")) if (segment === "." || segment === "..") return {
		ok: false,
		reason: "traversal-segment"
	};
	return { ok: true };
}
function isValidExecSecretRefId(value) {
	return validateExecSecretRefId(value).ok;
}
function formatExecSecretRefIdValidationMessage() {
	return [
		"Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/",
		"and must not include \".\" or \"..\" path segments",
		"(example: \"vault/openai/api-key\")."
	].join(" ");
}
//#endregion
//#region src/gateway/protocol/client-info.ts
const GATEWAY_CLIENT_IDS = {
	WEBCHAT_UI: "webchat-ui",
	CONTROL_UI: "openclaw-control-ui",
	WEBCHAT: "webchat",
	CLI: "cli",
	GATEWAY_CLIENT: "gateway-client",
	MACOS_APP: "openclaw-macos",
	IOS_APP: "openclaw-ios",
	ANDROID_APP: "openclaw-android",
	NODE_HOST: "node-host",
	TEST: "test",
	FINGERPRINT: "fingerprint",
	PROBE: "openclaw-probe"
};
const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
const GATEWAY_CLIENT_MODES = {
	WEBCHAT: "webchat",
	CLI: "cli",
	UI: "ui",
	BACKEND: "backend",
	NODE: "node",
	PROBE: "probe",
	TEST: "test"
};
const GATEWAY_CLIENT_CAPS = { TOOL_EVENTS: "tool-events" };
const GATEWAY_CLIENT_ID_SET = new Set(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set(Object.values(GATEWAY_CLIENT_MODES));
function normalizeGatewayClientId(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	return GATEWAY_CLIENT_ID_SET.has(normalized) ? normalized : void 0;
}
function normalizeGatewayClientName(raw) {
	return normalizeGatewayClientId(raw);
}
function normalizeGatewayClientMode(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	return GATEWAY_CLIENT_MODE_SET.has(normalized) ? normalized : void 0;
}
function hasGatewayClientCap(caps, cap) {
	if (!Array.isArray(caps)) return false;
	return caps.includes(cap);
}
//#endregion
//#region src/utils/message-channel.ts
init_registry();
init_runtime();
function getChannelIds() {
	const { CHANNEL_IDS } = (init_registry(), __toCommonJS(registry_exports));
	return CHANNEL_IDS;
}
const INTERNAL_MESSAGE_CHANNEL = "webchat";
const MARKDOWN_CAPABLE_CHANNELS = new Set([
	"slack",
	"telegram",
	"signal",
	"discord",
	"googlechat",
	"tui",
	INTERNAL_MESSAGE_CHANNEL
]);
function isGatewayCliClient(client) {
	return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}
function isInternalMessageChannel(raw) {
	return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}
function isWebchatClient(client) {
	if (normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.WEBCHAT) return true;
	return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}
function normalizeMessageChannel(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (normalized === "webchat") return INTERNAL_MESSAGE_CHANNEL;
	const builtIn = normalizeChatChannelId(normalized);
	if (builtIn) return builtIn;
	return (getActivePluginRegistry()?.channels.find((entry) => {
		if (entry.plugin.id.toLowerCase() === normalized) return true;
		return (entry.plugin.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized);
	}))?.plugin.id ?? normalized;
}
const listPluginChannelIds = () => {
	const registry = getActivePluginRegistry();
	if (!registry) return [];
	return registry.channels.map((entry) => entry.plugin.id);
};
const listDeliverableMessageChannels = () => Array.from(new Set([...getChannelIds(), ...listPluginChannelIds()]));
const listGatewayMessageChannels = () => [...listDeliverableMessageChannels(), INTERNAL_MESSAGE_CHANNEL];
function isGatewayMessageChannel(value) {
	return listGatewayMessageChannels().includes(value);
}
function isDeliverableMessageChannel(value) {
	return listDeliverableMessageChannels().includes(value);
}
function resolveGatewayMessageChannel(raw) {
	const normalized = normalizeMessageChannel(raw);
	if (!normalized) return;
	return isGatewayMessageChannel(normalized) ? normalized : void 0;
}
function resolveMessageChannel(primary, fallback) {
	return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
function isMarkdownCapableMessageChannel(raw) {
	const channel = normalizeMessageChannel(raw);
	if (!channel) return false;
	return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
//#endregion
//#region src/infra/ws.ts
function rawDataToString(data, encoding = "utf8") {
	if (typeof data === "string") return data;
	if (Buffer$1.isBuffer(data)) return data.toString(encoding);
	if (Array.isArray(data)) return Buffer$1.concat(data).toString(encoding);
	if (data instanceof ArrayBuffer) return Buffer$1.from(data).toString(encoding);
	return Buffer$1.from(String(data)).toString(encoding);
}
//#endregion
//#region src/sessions/input-provenance.ts
const INPUT_PROVENANCE_KIND_VALUES = [
	"external_user",
	"inter_session",
	"internal_system"
];
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function isInputProvenanceKind(value) {
	return typeof value === "string" && INPUT_PROVENANCE_KIND_VALUES.includes(value);
}
function normalizeInputProvenance(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	if (!isInputProvenanceKind(record.kind)) return;
	return {
		kind: record.kind,
		originSessionId: normalizeOptionalString(record.originSessionId),
		sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
		sourceChannel: normalizeOptionalString(record.sourceChannel),
		sourceTool: normalizeOptionalString(record.sourceTool)
	};
}
function applyInputProvenanceToUserMessage(message, inputProvenance) {
	if (!inputProvenance) return message;
	if (message.role !== "user") return message;
	if (normalizeInputProvenance(message.provenance)) return message;
	return {
		...message,
		provenance: inputProvenance
	};
}
function isInterSessionInputProvenance(value) {
	return normalizeInputProvenance(value)?.kind === "inter_session";
}
function hasInterSessionUserProvenance(message) {
	if (!message || message.role !== "user") return false;
	return isInterSessionInputProvenance(message.provenance);
}
//#endregion
//#region src/infra/device-identity.ts
init_paths();
function resolveDefaultIdentityPath() {
	return path.join(resolveStateDir(), "identity", "device.json");
}
function ensureDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function base64UrlDecode(input) {
	const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
	return Buffer.from(padded, "base64");
}
function derivePublicKeyRaw(publicKeyPem) {
	const spki = crypto.createPublicKey(publicKeyPem).export({
		type: "spki",
		format: "der"
	});
	if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) return spki.subarray(ED25519_SPKI_PREFIX.length);
	return spki;
}
function fingerprintPublicKey(publicKeyPem) {
	const raw = derivePublicKeyRaw(publicKeyPem);
	return crypto.createHash("sha256").update(raw).digest("hex");
}
function generateIdentity() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({
		type: "spki",
		format: "pem"
	}).toString();
	const privateKeyPem = privateKey.export({
		type: "pkcs8",
		format: "pem"
	}).toString();
	return {
		deviceId: fingerprintPublicKey(publicKeyPem),
		publicKeyPem,
		privateKeyPem
	};
}
function loadOrCreateDeviceIdentity(filePath = resolveDefaultIdentityPath()) {
	try {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.version === 1 && typeof parsed.deviceId === "string" && typeof parsed.publicKeyPem === "string" && typeof parsed.privateKeyPem === "string") {
				const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
				if (derivedId && derivedId !== parsed.deviceId) {
					const updated = {
						...parsed,
						deviceId: derivedId
					};
					fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 384 });
					try {
						fs.chmodSync(filePath, 384);
					} catch {}
					return {
						deviceId: derivedId,
						publicKeyPem: parsed.publicKeyPem,
						privateKeyPem: parsed.privateKeyPem
					};
				}
				return {
					deviceId: parsed.deviceId,
					publicKeyPem: parsed.publicKeyPem,
					privateKeyPem: parsed.privateKeyPem
				};
			}
		}
	} catch {}
	const identity = generateIdentity();
	ensureDir(filePath);
	const stored = {
		version: 1,
		deviceId: identity.deviceId,
		publicKeyPem: identity.publicKeyPem,
		privateKeyPem: identity.privateKeyPem,
		createdAtMs: Date.now()
	};
	fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
	return identity;
}
function signDevicePayload(privateKeyPem, payload) {
	const key = crypto.createPrivateKey(privateKeyPem);
	return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}
function normalizeDevicePublicKeyBase64Url(publicKey) {
	try {
		if (publicKey.includes("BEGIN")) return base64UrlEncode(derivePublicKeyRaw(publicKey));
		const raw = base64UrlDecode(publicKey);
		if (raw.length === 0) return null;
		return base64UrlEncode(raw);
	} catch {
		return null;
	}
}
function deriveDeviceIdFromPublicKey(publicKey) {
	try {
		const raw = publicKey.includes("BEGIN") ? derivePublicKeyRaw(publicKey) : base64UrlDecode(publicKey);
		if (raw.length === 0) return null;
		return crypto.createHash("sha256").update(raw).digest("hex");
	} catch {
		return null;
	}
}
function publicKeyRawBase64UrlFromPem(publicKeyPem) {
	return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
function verifyDeviceSignature(publicKey, payload, signatureBase64Url) {
	try {
		const key = publicKey.includes("BEGIN") ? crypto.createPublicKey(publicKey) : crypto.createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
			type: "spki",
			format: "der"
		});
		const sig = (() => {
			try {
				return base64UrlDecode(signatureBase64Url);
			} catch {
				return Buffer.from(signatureBase64Url, "base64");
			}
		})();
		return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
	} catch {
		return false;
	}
}
//#endregion
//#region src/infra/tls/fingerprint.ts
function normalizeFingerprint(input) {
	return input.trim().replace(/^sha-?256\s*:?\s*/i, "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}
//#endregion
//#region src/shared/device-auth.ts
function normalizeDeviceAuthRole(role) {
	return role.trim();
}
function normalizeDeviceAuthScopes(scopes) {
	if (!Array.isArray(scopes)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return [...out].toSorted();
}
//#endregion
//#region src/shared/device-auth-store.ts
function loadDeviceAuthTokenFromStore(params) {
	const store = params.adapter.readStore();
	if (!store || store.deviceId !== params.deviceId) return null;
	const role = normalizeDeviceAuthRole(params.role);
	const entry = store.tokens[role];
	if (!entry || typeof entry.token !== "string") return null;
	return entry;
}
function storeDeviceAuthTokenInStore(params) {
	const role = normalizeDeviceAuthRole(params.role);
	const existing = params.adapter.readStore();
	const next = {
		version: 1,
		deviceId: params.deviceId,
		tokens: existing && existing.deviceId === params.deviceId && existing.tokens ? { ...existing.tokens } : {}
	};
	const entry = {
		token: params.token,
		role,
		scopes: normalizeDeviceAuthScopes(params.scopes),
		updatedAtMs: Date.now()
	};
	next.tokens[role] = entry;
	params.adapter.writeStore(next);
	return entry;
}
function clearDeviceAuthTokenFromStore(params) {
	const store = params.adapter.readStore();
	if (!store || store.deviceId !== params.deviceId) return;
	const role = normalizeDeviceAuthRole(params.role);
	if (!store.tokens[role]) return;
	const next = {
		version: 1,
		deviceId: store.deviceId,
		tokens: { ...store.tokens }
	};
	delete next.tokens[role];
	params.adapter.writeStore(next);
}
//#endregion
//#region src/infra/device-auth-store.ts
init_paths();
const DEVICE_AUTH_FILE = "device-auth.json";
function resolveDeviceAuthPath(env = process.env) {
	return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}
function readStore(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") return null;
		if (!parsed.tokens || typeof parsed.tokens !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}
function writeStore(filePath, store) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
}
function loadDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	return loadDeviceAuthTokenFromStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (_store) => {}
		},
		deviceId: params.deviceId,
		role: params.role
	});
}
function storeDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	return storeDeviceAuthTokenInStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (store) => writeStore(filePath, store)
		},
		deviceId: params.deviceId,
		role: params.role,
		token: params.token,
		scopes: params.scopes
	});
}
function clearDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	clearDeviceAuthTokenFromStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (store) => writeStore(filePath, store)
		},
		deviceId: params.deviceId,
		role: params.role
	});
}
//#endregion
//#region src/gateway/device-auth.ts
function buildDeviceAuthPayload(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	return [
		"v2",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce
	].join("|");
}
function buildDeviceAuthPayloadV3(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	const platform = normalizeDeviceMetadataForAuth(params.platform);
	const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
	return [
		"v3",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce,
		platform,
		deviceFamily
	].join("|");
}
//#endregion
//#region src/gateway/protocol/connect-error-details.ts
const ConnectErrorDetailCodes = {
	AUTH_REQUIRED: "AUTH_REQUIRED",
	AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
	AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
	AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
	AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
	AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
	AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
	AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED",
	AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
	AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
	AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
	AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
	AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
	AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
	AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
	CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
	CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
	DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
	DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
	DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
	DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
	DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
	DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
	DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
	DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
	PAIRING_REQUIRED: "PAIRING_REQUIRED"
};
const CONNECT_RECOVERY_NEXT_STEP_VALUES = new Set([
	"retry_with_device_token",
	"update_auth_configuration",
	"update_auth_credentials",
	"wait_then_retry",
	"review_auth_configuration"
]);
function resolveAuthConnectErrorDetailCode(reason) {
	switch (reason) {
		case "token_missing": return ConnectErrorDetailCodes.AUTH_TOKEN_MISSING;
		case "token_mismatch": return ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
		case "token_missing_config": return ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED;
		case "password_missing": return ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING;
		case "password_mismatch": return ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH;
		case "password_missing_config": return ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED;
		case "bootstrap_token_invalid": return ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID;
		case "tailscale_user_missing": return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING;
		case "tailscale_proxy_missing": return ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING;
		case "tailscale_whois_failed": return ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED;
		case "tailscale_user_mismatch": return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH;
		case "rate_limited": return ConnectErrorDetailCodes.AUTH_RATE_LIMITED;
		case "device_token_mismatch": return ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH;
		case void 0: return ConnectErrorDetailCodes.AUTH_REQUIRED;
		default: return ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
	}
}
function resolveDeviceAuthConnectErrorDetailCode(reason) {
	switch (reason) {
		case "device-id-mismatch": return ConnectErrorDetailCodes.DEVICE_AUTH_DEVICE_ID_MISMATCH;
		case "device-signature-stale": return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_EXPIRED;
		case "device-nonce-missing": return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_REQUIRED;
		case "device-nonce-mismatch": return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_MISMATCH;
		case "device-signature": return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID;
		case "device-public-key": return ConnectErrorDetailCodes.DEVICE_AUTH_PUBLIC_KEY_INVALID;
		default: return ConnectErrorDetailCodes.DEVICE_AUTH_INVALID;
	}
}
function readConnectErrorDetailCode(details) {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const code = details.code;
	return typeof code === "string" && code.trim().length > 0 ? code : null;
}
function readConnectErrorRecoveryAdvice(details) {
	if (!details || typeof details !== "object" || Array.isArray(details)) return {};
	const raw = details;
	const canRetryWithDeviceToken = typeof raw.canRetryWithDeviceToken === "boolean" ? raw.canRetryWithDeviceToken : void 0;
	const normalizedNextStep = typeof raw.recommendedNextStep === "string" ? raw.recommendedNextStep.trim() : "";
	return {
		canRetryWithDeviceToken,
		recommendedNextStep: CONNECT_RECOVERY_NEXT_STEP_VALUES.has(normalizedNextStep) ? normalizedNextStep : void 0
	};
}
function parseSessionLabel(raw) {
	if (typeof raw !== "string") return {
		ok: false,
		error: "invalid label: must be a string"
	};
	const trimmed = raw.trim();
	if (!trimmed) return {
		ok: false,
		error: "invalid label: empty"
	};
	if (trimmed.length > 64) return {
		ok: false,
		error: `invalid label: too long (max 64)`
	};
	return {
		ok: true,
		label: trimmed
	};
}
//#endregion
//#region src/gateway/protocol/schema/primitives.ts
init_types_secrets();
const NonEmptyString = Type.String({ minLength: 1 });
const ChatSendSessionKeyString = Type.String({
	minLength: 1,
	maxLength: 512
});
const SessionLabelString = Type.String({
	minLength: 1,
	maxLength: 64
});
const InputProvenanceSchema = Type.Object({
	kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
	originSessionId: Type.Optional(Type.String()),
	sourceSessionKey: Type.Optional(Type.String()),
	sourceChannel: Type.Optional(Type.String()),
	sourceTool: Type.Optional(Type.String())
}, { additionalProperties: false });
const GatewayClientIdSchema = Type.Union(Object.values(GATEWAY_CLIENT_IDS).map((value) => Type.Literal(value)));
const GatewayClientModeSchema = Type.Union(Object.values(GATEWAY_CLIENT_MODES).map((value) => Type.Literal(value)));
Type.Union([
	Type.Literal("env"),
	Type.Literal("file"),
	Type.Literal("exec")
]);
const SecretProviderAliasString = Type.String({ pattern: SECRET_PROVIDER_ALIAS_PATTERN.source });
const EnvSecretRefSchema = Type.Object({
	source: Type.Literal("env"),
	provider: SecretProviderAliasString,
	id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source })
}, { additionalProperties: false });
const FileSecretRefSchema = Type.Object({
	source: Type.Literal("file"),
	provider: SecretProviderAliasString,
	id: Type.String({ pattern: FILE_SECRET_REF_ID_PATTERN.source })
}, { additionalProperties: false });
const ExecSecretRefSchema = Type.Object({
	source: Type.Literal("exec"),
	provider: SecretProviderAliasString,
	id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN })
}, { additionalProperties: false });
const SecretRefSchema = Type.Union([
	EnvSecretRefSchema,
	FileSecretRefSchema,
	ExecSecretRefSchema
]);
const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
//#endregion
//#region src/gateway/protocol/schema/agent.ts
const AgentInternalEventSchema = Type.Object({
	type: Type.Literal("task_completion"),
	source: Type.String({ enum: ["subagent", "cron"] }),
	childSessionKey: Type.String(),
	childSessionId: Type.Optional(Type.String()),
	announceType: Type.String(),
	taskLabel: Type.String(),
	status: Type.String({ enum: [
		"ok",
		"timeout",
		"error",
		"unknown"
	] }),
	statusLabel: Type.String(),
	result: Type.String(),
	statsLine: Type.Optional(Type.String()),
	replyInstruction: Type.String()
}, { additionalProperties: false });
Type.Object({
	runId: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	stream: NonEmptyString,
	ts: Type.Integer({ minimum: 0 }),
	data: Type.Record(Type.String(), Type.Unknown())
}, { additionalProperties: false });
const SendParamsSchema = Type.Object({
	to: NonEmptyString,
	message: Type.Optional(Type.String()),
	mediaUrl: Type.Optional(Type.String()),
	mediaUrls: Type.Optional(Type.Array(Type.String())),
	gifPlayback: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const PollParamsSchema = Type.Object({
	to: NonEmptyString,
	question: NonEmptyString,
	options: Type.Array(NonEmptyString, {
		minItems: 2,
		maxItems: 12
	}),
	maxSelections: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 12
	})),
	durationSeconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 604800
	})),
	durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
	silent: Type.Optional(Type.Boolean()),
	isAnonymous: Type.Optional(Type.Boolean()),
	threadId: Type.Optional(Type.String()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const AgentParamsSchema = Type.Object({
	message: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	to: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	channel: Type.Optional(Type.String()),
	replyChannel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	replyAccountId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	groupId: Type.Optional(Type.String()),
	groupChannel: Type.Optional(Type.String()),
	groupSpace: Type.Optional(Type.String()),
	timeout: Type.Optional(Type.Integer({ minimum: 0 })),
	bestEffortDeliver: Type.Optional(Type.Boolean()),
	lane: Type.Optional(Type.String()),
	extraSystemPrompt: Type.Optional(Type.String()),
	internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
	inputProvenance: Type.Optional(InputProvenanceSchema),
	idempotencyKey: NonEmptyString,
	label: Type.Optional(SessionLabelString)
}, { additionalProperties: false });
const AgentIdentityParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String())
}, { additionalProperties: false });
Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	avatar: Type.Optional(NonEmptyString),
	emoji: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const AgentWaitParamsSchema = Type.Object({
	runId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const WakeParamsSchema = Type.Object({
	mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
	text: NonEmptyString
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/agents-models-skills.ts
const ModelChoiceSchema = Type.Object({
	id: NonEmptyString,
	name: NonEmptyString,
	provider: NonEmptyString,
	contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	reasoning: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentSummarySchema = Type.Object({
	id: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	identity: Type.Optional(Type.Object({
		name: Type.Optional(NonEmptyString),
		theme: Type.Optional(NonEmptyString),
		emoji: Type.Optional(NonEmptyString),
		avatar: Type.Optional(NonEmptyString),
		avatarUrl: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });
Type.Object({
	defaultId: NonEmptyString,
	mainKey: NonEmptyString,
	scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
	agents: Type.Array(AgentSummarySchema)
}, { additionalProperties: false });
const AgentsCreateParamsSchema = Type.Object({
	name: NonEmptyString,
	workspace: NonEmptyString,
	emoji: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	name: NonEmptyString,
	workspace: NonEmptyString
}, { additionalProperties: false });
const AgentsUpdateParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	workspace: Type.Optional(NonEmptyString),
	model: Type.Optional(NonEmptyString),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString
}, { additionalProperties: false });
const AgentsDeleteParamsSchema = Type.Object({
	agentId: NonEmptyString,
	deleteFiles: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	removedBindings: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const AgentsFileEntrySchema = Type.Object({
	name: NonEmptyString,
	path: NonEmptyString,
	missing: Type.Boolean(),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	content: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsFilesListParamsSchema = Type.Object({ agentId: NonEmptyString }, { additionalProperties: false });
Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	files: Type.Array(AgentsFileEntrySchema)
}, { additionalProperties: false });
const AgentsFilesGetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString
}, { additionalProperties: false });
Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const AgentsFilesSetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString,
	content: Type.String()
}, { additionalProperties: false });
Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });
Type.Object({ models: Type.Array(ModelChoiceSchema) }, { additionalProperties: false });
const SkillsStatusParamsSchema = Type.Object({ agentId: Type.Optional(NonEmptyString) }, { additionalProperties: false });
const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });
Type.Object({ bins: Type.Array(NonEmptyString) }, { additionalProperties: false });
const SkillsInstallParamsSchema = Type.Object({
	name: NonEmptyString,
	installId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
}, { additionalProperties: false });
const SkillsUpdateParamsSchema = Type.Object({
	skillKey: NonEmptyString,
	enabled: Type.Optional(Type.Boolean()),
	apiKey: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String()))
}, { additionalProperties: false });
const ToolsCatalogParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	includePlugins: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ToolCatalogProfileSchema = Type.Object({
	id: Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]),
	label: NonEmptyString
}, { additionalProperties: false });
const ToolCatalogEntrySchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	description: Type.String(),
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	optional: Type.Optional(Type.Boolean()),
	defaultProfiles: Type.Array(Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]))
}, { additionalProperties: false });
const ToolCatalogGroupSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	tools: Type.Array(ToolCatalogEntrySchema)
}, { additionalProperties: false });
Type.Object({
	agentId: NonEmptyString,
	profiles: Type.Array(ToolCatalogProfileSchema),
	groups: Type.Array(ToolCatalogGroupSchema)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/channels.ts
const TalkModeParamsSchema = Type.Object({
	enabled: Type.Boolean(),
	phase: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkConfigParamsSchema = Type.Object({ includeSecrets: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const talkProviderFieldSchemas = {
	voiceId: Type.Optional(Type.String()),
	voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
	modelId: Type.Optional(Type.String()),
	outputFormat: Type.Optional(Type.String()),
	apiKey: Type.Optional(SecretInputSchema)
};
const TalkProviderConfigSchema = Type.Object(talkProviderFieldSchemas, { additionalProperties: true });
const ResolvedTalkConfigSchema = Type.Object({
	provider: Type.String(),
	config: TalkProviderConfigSchema
}, { additionalProperties: false });
const LegacyTalkConfigSchema = Type.Object({
	...talkProviderFieldSchemas,
	interruptOnSpeech: Type.Optional(Type.Boolean()),
	silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const NormalizedTalkConfigSchema = Type.Object({
	provider: Type.Optional(Type.String()),
	providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
	resolved: ResolvedTalkConfigSchema,
	...talkProviderFieldSchemas,
	interruptOnSpeech: Type.Optional(Type.Boolean()),
	silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const TalkConfigResultSchema = Type.Object({ config: Type.Object({
	talk: Type.Optional(Type.Union([LegacyTalkConfigSchema, NormalizedTalkConfigSchema])),
	session: Type.Optional(Type.Object({ mainKey: Type.Optional(Type.String()) }, { additionalProperties: false })),
	ui: Type.Optional(Type.Object({ seamColor: Type.Optional(Type.String()) }, { additionalProperties: false }))
}, { additionalProperties: false }) }, { additionalProperties: false });
const ChannelsStatusParamsSchema = Type.Object({
	probe: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ChannelAccountSnapshotSchema = Type.Object({
	accountId: NonEmptyString,
	name: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	configured: Type.Optional(Type.Boolean()),
	linked: Type.Optional(Type.Boolean()),
	running: Type.Optional(Type.Boolean()),
	connected: Type.Optional(Type.Boolean()),
	reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
	lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastError: Type.Optional(Type.String()),
	lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	busy: Type.Optional(Type.Boolean()),
	activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.String()),
	dmPolicy: Type.Optional(Type.String()),
	allowFrom: Type.Optional(Type.Array(Type.String())),
	tokenSource: Type.Optional(Type.String()),
	botTokenSource: Type.Optional(Type.String()),
	appTokenSource: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	allowUnmentionedGroups: Type.Optional(Type.Boolean()),
	cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	probe: Type.Optional(Type.Unknown()),
	audit: Type.Optional(Type.Unknown()),
	application: Type.Optional(Type.Unknown())
}, { additionalProperties: true });
const ChannelUiMetaSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	detailLabel: NonEmptyString,
	systemImage: Type.Optional(Type.String())
}, { additionalProperties: false });
Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	channelOrder: Type.Array(NonEmptyString),
	channelLabels: Type.Record(NonEmptyString, NonEmptyString),
	channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
	channels: Type.Record(NonEmptyString, Type.Unknown()),
	channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
	channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString)
}, { additionalProperties: false });
const ChannelsLogoutParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginStartParamsSchema = Type.Object({
	force: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	verbose: Type.Optional(Type.Boolean()),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginWaitParamsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/config.ts
const ConfigSchemaLookupPathString = Type.String({
	minLength: 1,
	maxLength: 1024,
	pattern: "^[A-Za-z0-9_./\\[\\]\\-*]+$"
});
const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSetParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ConfigApplyLikeParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigPatchParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSchemaLookupParamsSchema = Type.Object({ path: ConfigSchemaLookupPathString }, { additionalProperties: false });
const UpdateRunParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const ConfigUiHintSchema = Type.Object({
	label: Type.Optional(Type.String()),
	help: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	group: Type.Optional(Type.String()),
	order: Type.Optional(Type.Integer()),
	advanced: Type.Optional(Type.Boolean()),
	sensitive: Type.Optional(Type.Boolean()),
	placeholder: Type.Optional(Type.String()),
	itemTemplate: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
Type.Object({
	schema: Type.Unknown(),
	uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
	version: NonEmptyString,
	generatedAt: NonEmptyString
}, { additionalProperties: false });
const ConfigSchemaLookupChildSchema = Type.Object({
	key: NonEmptyString,
	path: NonEmptyString,
	type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	required: Type.Boolean(),
	hasChildren: Type.Boolean(),
	hint: Type.Optional(ConfigUiHintSchema),
	hintPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ConfigSchemaLookupResultSchema = Type.Object({
	path: NonEmptyString,
	schema: Type.Unknown(),
	hint: Type.Optional(ConfigUiHintSchema),
	hintPath: Type.Optional(Type.String()),
	children: Type.Array(ConfigSchemaLookupChildSchema)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/cron.ts
function cronAgentTurnPayloadSchema(params) {
	return Type.Object({
		kind: Type.Literal("agentTurn"),
		message: params.message,
		model: Type.Optional(Type.String()),
		fallbacks: Type.Optional(Type.Array(Type.String())),
		thinking: Type.Optional(Type.String()),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
		allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
		lightContext: Type.Optional(Type.Boolean()),
		deliver: Type.Optional(Type.Boolean()),
		channel: Type.Optional(Type.String()),
		to: Type.Optional(Type.String()),
		bestEffortDeliver: Type.Optional(Type.Boolean())
	}, { additionalProperties: false });
}
const CronSessionTargetSchema = Type.Union([
	Type.Literal("main"),
	Type.Literal("isolated"),
	Type.Literal("current"),
	Type.String({ pattern: "^session:.+" })
]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
const CronRunStatusSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("enabled"),
	Type.Literal("disabled")
]);
const CronJobsSortBySchema = Type.Union([
	Type.Literal("nextRunAtMs"),
	Type.Literal("updatedAtMs"),
	Type.Literal("name")
]);
const CronRunsStatusFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronRunsStatusValueSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronDeliveryStatusSchema = Type.Union([
	Type.Literal("delivered"),
	Type.Literal("not-delivered"),
	Type.Literal("unknown"),
	Type.Literal("not-requested")
]);
const CronFailoverReasonSchema = Type.Union([
	Type.Literal("auth"),
	Type.Literal("format"),
	Type.Literal("rate_limit"),
	Type.Literal("billing"),
	Type.Literal("timeout"),
	Type.Literal("model_not_found"),
	Type.Literal("unknown")
]);
const CronCommonOptionalFields = {
	agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean())
};
function cronIdOrJobIdParams(extraFields) {
	return Type.Union([Type.Object({
		id: NonEmptyString,
		...extraFields
	}, { additionalProperties: false }), Type.Object({
		jobId: NonEmptyString,
		...extraFields
	}, { additionalProperties: false })]);
}
const CronRunLogJobIdSchema = Type.String({
	minLength: 1,
	pattern: "^[^/\\\\]+$"
});
const CronScheduleSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("at"),
		at: NonEmptyString
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("every"),
		everyMs: Type.Integer({ minimum: 1 }),
		anchorMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("cron"),
		expr: NonEmptyString,
		tz: Type.Optional(Type.String()),
		staggerMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })
]);
const CronPayloadSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: NonEmptyString
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({ message: NonEmptyString })]);
const CronPayloadPatchSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: Type.Optional(NonEmptyString)
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({ message: Type.Optional(NonEmptyString) })]);
const CronFailureAlertSchema = Type.Object({
	after: Type.Optional(Type.Integer({ minimum: 1 })),
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
	accountId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const CronFailureDestinationSchema = Type.Object({
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	accountId: Type.Optional(NonEmptyString),
	mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")]))
}, { additionalProperties: false });
const CronDeliverySharedProperties = {
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	accountId: Type.Optional(NonEmptyString),
	bestEffort: Type.Optional(Type.Boolean()),
	failureDestination: Type.Optional(CronFailureDestinationSchema)
};
const CronDeliveryNoopSchema = Type.Object({
	mode: Type.Literal("none"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryAnnounceSchema = Type.Object({
	mode: Type.Literal("announce"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryWebhookSchema = Type.Object({
	mode: Type.Literal("webhook"),
	...CronDeliverySharedProperties,
	to: NonEmptyString
}, { additionalProperties: false });
const CronDeliverySchema = Type.Union([
	CronDeliveryNoopSchema,
	CronDeliveryAnnounceSchema,
	CronDeliveryWebhookSchema
]);
const CronDeliveryPatchSchema = Type.Object({
	mode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("announce"),
		Type.Literal("webhook")
	])),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronJobStateSchema = Type.Object({
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunStatus: Type.Optional(CronRunStatusSchema),
	lastStatus: Type.Optional(CronRunStatusSchema),
	lastError: Type.Optional(Type.String()),
	lastErrorReason: Type.Optional(CronFailoverReasonSchema),
	lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
	lastDelivered: Type.Optional(Type.Boolean()),
	lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastDeliveryError: Type.Optional(Type.String()),
	lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
Type.Object({
	id: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	name: NonEmptyString,
	description: Type.Optional(Type.String()),
	enabled: Type.Boolean(),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	createdAtMs: Type.Integer({ minimum: 0 }),
	updatedAtMs: Type.Integer({ minimum: 0 }),
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
	state: CronJobStateSchema
}, { additionalProperties: false });
const CronListParamsSchema = Type.Object({
	includeDisabled: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	query: Type.Optional(Type.String()),
	enabled: Type.Optional(CronJobsEnabledFilterSchema),
	sortBy: Type.Optional(CronJobsSortBySchema),
	sortDir: Type.Optional(CronSortDirSchema)
}, { additionalProperties: false });
const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });
const CronAddParamsSchema = Type.Object({
	name: NonEmptyString,
	...CronCommonOptionalFields,
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema]))
}, { additionalProperties: false });
const CronUpdateParamsSchema = cronIdOrJobIdParams({ patch: Type.Object({
	name: Type.Optional(NonEmptyString),
	...CronCommonOptionalFields,
	schedule: Type.Optional(CronScheduleSchema),
	sessionTarget: Type.Optional(CronSessionTargetSchema),
	wakeMode: Type.Optional(CronWakeModeSchema),
	payload: Type.Optional(CronPayloadPatchSchema),
	delivery: Type.Optional(CronDeliveryPatchSchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
	state: Type.Optional(Type.Partial(CronJobStateSchema))
}, { additionalProperties: false }) });
const CronRemoveParamsSchema = cronIdOrJobIdParams({});
const CronRunParamsSchema = cronIdOrJobIdParams({ mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])) });
const CronRunsParamsSchema = Type.Object({
	scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
	id: Type.Optional(CronRunLogJobIdSchema),
	jobId: Type.Optional(CronRunLogJobIdSchema),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, {
		minItems: 1,
		maxItems: 3
	})),
	status: Type.Optional(CronRunsStatusFilterSchema),
	deliveryStatuses: Type.Optional(Type.Array(CronDeliveryStatusSchema, {
		minItems: 1,
		maxItems: 4
	})),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	query: Type.Optional(Type.String()),
	sortDir: Type.Optional(CronSortDirSchema)
}, { additionalProperties: false });
Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	jobId: NonEmptyString,
	action: Type.Literal("finished"),
	status: Type.Optional(CronRunStatusSchema),
	error: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	delivered: Type.Optional(Type.Boolean()),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	deliveryError: Type.Optional(Type.String()),
	sessionId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Object({
		input_tokens: Type.Optional(Type.Number()),
		output_tokens: Type.Optional(Type.Number()),
		total_tokens: Type.Optional(Type.Number()),
		cache_read_tokens: Type.Optional(Type.Number()),
		cache_write_tokens: Type.Optional(Type.Number())
	}, { additionalProperties: false })),
	jobName: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/error-codes.ts
const ErrorCodes = {
	NOT_LINKED: "NOT_LINKED",
	NOT_PAIRED: "NOT_PAIRED",
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	INVALID_REQUEST: "INVALID_REQUEST",
	UNAVAILABLE: "UNAVAILABLE"
};
function errorShape(code, message, opts) {
	return {
		code,
		message,
		...opts
	};
}
//#endregion
//#region src/gateway/protocol/schema/exec-approvals.ts
const ExecApprovalsAllowlistEntrySchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	pattern: Type.String(),
	lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastUsedCommand: Type.Optional(Type.String()),
	lastResolvedPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ExecApprovalsPolicyFields = {
	security: Type.Optional(Type.String()),
	ask: Type.Optional(Type.String()),
	askFallback: Type.Optional(Type.String()),
	autoAllowSkills: Type.Optional(Type.Boolean())
};
const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, { additionalProperties: false });
const ExecApprovalsAgentSchema = Type.Object({
	...ExecApprovalsPolicyFields,
	allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema))
}, { additionalProperties: false });
const ExecApprovalsFileSchema = Type.Object({
	version: Type.Literal(1),
	socket: Type.Optional(Type.Object({
		path: Type.Optional(Type.String()),
		token: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	defaults: Type.Optional(ExecApprovalsDefaultsSchema),
	agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema))
}, { additionalProperties: false });
Type.Object({
	path: NonEmptyString,
	exists: Type.Boolean(),
	hash: NonEmptyString,
	file: ExecApprovalsFileSchema
}, { additionalProperties: false });
const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ExecApprovalsSetParamsSchema = Type.Object({
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalsNodeGetParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const ExecApprovalsNodeSetParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalRequestParamsSchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	command: Type.Optional(NonEmptyString),
	commandArgv: Type.Optional(Type.Array(Type.String())),
	systemRunPlan: Type.Optional(Type.Object({
		argv: Type.Array(Type.String()),
		cwd: Type.Union([Type.String(), Type.Null()]),
		commandText: Type.String(),
		commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		agentId: Type.Union([Type.String(), Type.Null()]),
		sessionKey: Type.Union([Type.String(), Type.Null()]),
		mutableFileOperand: Type.Optional(Type.Union([Type.Object({
			argvIndex: Type.Integer({ minimum: 0 }),
			path: Type.String(),
			sha256: Type.String()
		}, { additionalProperties: false }), Type.Null()]))
	}, { additionalProperties: false })),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
	cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceThreadId: Type.Optional(Type.Union([
		Type.String(),
		Type.Number(),
		Type.Null()
	])),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	twoPhase: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ExecApprovalResolveParamsSchema = Type.Object({
	id: NonEmptyString,
	decision: NonEmptyString
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/devices.ts
const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const DevicePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRemoveParamsSchema = Type.Object({ deviceId: NonEmptyString }, { additionalProperties: false });
const DeviceTokenRotateParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString,
	scopes: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const DeviceTokenRevokeParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString
}, { additionalProperties: false });
Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	publicKey: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	clientId: Type.Optional(NonEmptyString),
	clientMode: Type.Optional(NonEmptyString),
	role: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean()),
	isRepair: Type.Optional(Type.Boolean()),
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	decision: NonEmptyString,
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/snapshot.ts
const PresenceEntrySchema = Type.Object({
	host: Type.Optional(NonEmptyString),
	ip: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	mode: Type.Optional(NonEmptyString),
	lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
	reason: Type.Optional(NonEmptyString),
	tags: Type.Optional(Type.Array(NonEmptyString)),
	text: Type.Optional(Type.String()),
	ts: Type.Integer({ minimum: 0 }),
	deviceId: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	instanceId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const HealthSnapshotSchema = Type.Any();
const SessionDefaultsSchema = Type.Object({
	defaultAgentId: NonEmptyString,
	mainKey: NonEmptyString,
	mainSessionKey: NonEmptyString,
	scope: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const StateVersionSchema = Type.Object({
	presence: Type.Integer({ minimum: 0 }),
	health: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const SnapshotSchema = Type.Object({
	presence: Type.Array(PresenceEntrySchema),
	health: HealthSnapshotSchema,
	stateVersion: StateVersionSchema,
	uptimeMs: Type.Integer({ minimum: 0 }),
	configPath: Type.Optional(NonEmptyString),
	stateDir: Type.Optional(NonEmptyString),
	sessionDefaults: Type.Optional(SessionDefaultsSchema),
	authMode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("token"),
		Type.Literal("password"),
		Type.Literal("trusted-proxy")
	])),
	updateAvailable: Type.Optional(Type.Object({
		currentVersion: NonEmptyString,
		latestVersion: NonEmptyString,
		channel: NonEmptyString
	}))
}, { additionalProperties: false });
Type.Object({ ts: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
Type.Object({
	reason: NonEmptyString,
	restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConnectParamsSchema = Type.Object({
	minProtocol: Type.Integer({ minimum: 1 }),
	maxProtocol: Type.Integer({ minimum: 1 }),
	client: Type.Object({
		id: GatewayClientIdSchema,
		displayName: Type.Optional(NonEmptyString),
		version: NonEmptyString,
		platform: NonEmptyString,
		deviceFamily: Type.Optional(NonEmptyString),
		modelIdentifier: Type.Optional(NonEmptyString),
		mode: GatewayClientModeSchema,
		instanceId: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }),
	caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
	pathEnv: Type.Optional(Type.String()),
	role: Type.Optional(NonEmptyString),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	device: Type.Optional(Type.Object({
		id: NonEmptyString,
		publicKey: NonEmptyString,
		signature: NonEmptyString,
		signedAt: Type.Integer({ minimum: 0 }),
		nonce: NonEmptyString
	}, { additionalProperties: false })),
	auth: Type.Optional(Type.Object({
		token: Type.Optional(Type.String()),
		bootstrapToken: Type.Optional(Type.String()),
		deviceToken: Type.Optional(Type.String()),
		password: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	locale: Type.Optional(Type.String()),
	userAgent: Type.Optional(Type.String())
}, { additionalProperties: false });
Type.Object({
	type: Type.Literal("hello-ok"),
	protocol: Type.Integer({ minimum: 1 }),
	server: Type.Object({
		version: NonEmptyString,
		connId: NonEmptyString
	}, { additionalProperties: false }),
	features: Type.Object({
		methods: Type.Array(NonEmptyString),
		events: Type.Array(NonEmptyString)
	}, { additionalProperties: false }),
	snapshot: SnapshotSchema,
	canvasHostUrl: Type.Optional(NonEmptyString),
	auth: Type.Optional(Type.Object({
		deviceToken: NonEmptyString,
		role: NonEmptyString,
		scopes: Type.Array(NonEmptyString),
		issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })),
	policy: Type.Object({
		maxPayload: Type.Integer({ minimum: 1 }),
		maxBufferedBytes: Type.Integer({ minimum: 1 }),
		tickIntervalMs: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false })
}, { additionalProperties: false });
const ErrorShapeSchema = Type.Object({
	code: NonEmptyString,
	message: NonEmptyString,
	details: Type.Optional(Type.Unknown()),
	retryable: Type.Optional(Type.Boolean()),
	retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const RequestFrameSchema = Type.Object({
	type: Type.Literal("req"),
	id: NonEmptyString,
	method: NonEmptyString,
	params: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ResponseFrameSchema = Type.Object({
	type: Type.Literal("res"),
	id: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorShapeSchema)
}, { additionalProperties: false });
const EventFrameSchema = Type.Object({
	type: Type.Literal("event"),
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	seq: Type.Optional(Type.Integer({ minimum: 0 })),
	stateVersion: Type.Optional(StateVersionSchema)
}, { additionalProperties: false });
Type.Union([
	RequestFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema
], { discriminator: "type" });
//#endregion
//#region src/gateway/protocol/schema/logs-chat.ts
const LogsTailParamsSchema = Type.Object({
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	})),
	maxBytes: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e6
	}))
}, { additionalProperties: false });
Type.Object({
	file: NonEmptyString,
	cursor: Type.Integer({ minimum: 0 }),
	size: Type.Integer({ minimum: 0 }),
	lines: Type.Array(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	reset: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ChatHistoryParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e3
	}))
}, { additionalProperties: false });
const ChatSendParamsSchema = Type.Object({
	sessionKey: ChatSendSessionKeyString,
	message: Type.String(),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	systemInputProvenance: Type.Optional(InputProvenanceSchema),
	systemProvenanceReceipt: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const ChatAbortParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	runId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ChatInjectParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: NonEmptyString,
	label: Type.Optional(Type.String({ maxLength: 100 }))
}, { additionalProperties: false });
const ChatEventSchema = Type.Object({
	runId: NonEmptyString,
	sessionKey: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	state: Type.Union([
		Type.Literal("delta"),
		Type.Literal("final"),
		Type.Literal("aborted"),
		Type.Literal("error")
	]),
	message: Type.Optional(Type.Unknown()),
	errorMessage: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/nodes.ts
const NodePendingWorkTypeSchema = Type.String({ enum: ["status.request", "location.request"] });
const NodePendingWorkPrioritySchema = Type.String({ enum: ["normal", "high"] });
const NodePairRequestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	coreVersion: Type.Optional(NonEmptyString),
	uiVersion: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	caps: Type.Optional(Type.Array(NonEmptyString)),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairVerifyParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	token: NonEmptyString
}, { additionalProperties: false });
const NodeRenameParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: NonEmptyString
}, { additionalProperties: false });
const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePendingAckParamsSchema = Type.Object({ ids: Type.Array(NonEmptyString, { minItems: 1 }) }, { additionalProperties: false });
const NodeDescribeParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const NodeInvokeParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	command: NonEmptyString,
	params: Type.Optional(Type.Unknown()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const NodeInvokeResultParamsSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({
		code: Type.Optional(NonEmptyString),
		message: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const NodeEventParamsSchema = Type.Object({
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String())
}, { additionalProperties: false });
const NodePendingDrainParamsSchema = Type.Object({ maxItems: Type.Optional(Type.Integer({
	minimum: 1,
	maximum: 10
})) }, { additionalProperties: false });
const NodePendingDrainItemSchema = Type.Object({
	id: NonEmptyString,
	type: NodePendingWorkTypeSchema,
	priority: Type.String({ enum: [
		"default",
		"normal",
		"high"
	] }),
	createdAtMs: Type.Integer({ minimum: 0 }),
	expiresAtMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	payload: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
Type.Object({
	nodeId: NonEmptyString,
	revision: Type.Integer({ minimum: 0 }),
	items: Type.Array(NodePendingDrainItemSchema),
	hasMore: Type.Boolean()
}, { additionalProperties: false });
const NodePendingEnqueueParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	type: NodePendingWorkTypeSchema,
	priority: Type.Optional(NodePendingWorkPrioritySchema),
	expiresInMs: Type.Optional(Type.Integer({
		minimum: 1e3,
		maximum: 864e5
	})),
	wake: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
Type.Object({
	nodeId: NonEmptyString,
	revision: Type.Integer({ minimum: 0 }),
	queued: NodePendingDrainItemSchema,
	wakeTriggered: Type.Boolean()
}, { additionalProperties: false });
Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	command: NonEmptyString,
	paramsJSON: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/push.ts
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });
const PushTestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	environment: Type.Optional(ApnsEnvironmentSchema)
}, { additionalProperties: false });
Type.Object({
	ok: Type.Boolean(),
	status: Type.Integer(),
	apnsId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	tokenSuffix: Type.String(),
	topic: Type.String(),
	environment: ApnsEnvironmentSchema,
	transport: Type.String({ enum: ["direct", "relay"] })
}, { additionalProperties: false });
Type.Object({}, { additionalProperties: false });
const SecretsResolveParamsSchema = Type.Object({
	commandName: NonEmptyString,
	targetIds: Type.Array(NonEmptyString)
}, { additionalProperties: false });
const SecretsResolveAssignmentSchema = Type.Object({
	path: Type.Optional(NonEmptyString),
	pathSegments: Type.Array(NonEmptyString),
	value: Type.Unknown()
}, { additionalProperties: false });
const SecretsResolveResultSchema = Type.Object({
	ok: Type.Optional(Type.Boolean()),
	assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
	diagnostics: Type.Optional(Type.Array(NonEmptyString)),
	inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/sessions.ts
const SessionsListParamsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean()),
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	includeLastMessage: Type.Optional(Type.Boolean()),
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	search: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionsPreviewParamsSchema = Type.Object({
	keys: Type.Array(NonEmptyString, { minItems: 1 }),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChars: Type.Optional(Type.Integer({ minimum: 20 }))
}, { additionalProperties: false });
const SessionsResolveParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	sessionId: Type.Optional(NonEmptyString),
	label: Type.Optional(SessionLabelString),
	agentId: Type.Optional(NonEmptyString),
	spawnedBy: Type.Optional(NonEmptyString),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsPatchParamsSchema = Type.Object({
	key: NonEmptyString,
	label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
	thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
	verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	responseUsage: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("tokens"),
		Type.Literal("full"),
		Type.Literal("on"),
		Type.Null()
	])),
	elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	subagentRole: Type.Optional(Type.Union([
		Type.Literal("orchestrator"),
		Type.Literal("leaf"),
		Type.Null()
	])),
	subagentControlScope: Type.Optional(Type.Union([
		Type.Literal("children"),
		Type.Literal("none"),
		Type.Null()
	])),
	sendPolicy: Type.Optional(Type.Union([
		Type.Literal("allow"),
		Type.Literal("deny"),
		Type.Null()
	])),
	groupActivation: Type.Optional(Type.Union([
		Type.Literal("mention"),
		Type.Literal("always"),
		Type.Null()
	]))
}, { additionalProperties: false });
const SessionsResetParamsSchema = Type.Object({
	key: NonEmptyString,
	reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")]))
}, { additionalProperties: false });
const SessionsDeleteParamsSchema = Type.Object({
	key: NonEmptyString,
	deleteTranscript: Type.Optional(Type.Boolean()),
	emitLifecycleHooks: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsCompactParamsSchema = Type.Object({
	key: NonEmptyString,
	maxLines: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const SessionsUsageParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	mode: Type.Optional(Type.Union([
		Type.Literal("utc"),
		Type.Literal("gateway"),
		Type.Literal("specific")
	])),
	utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	includeContextWeight: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/wizard.ts
const WizardRunStatusSchema = Type.Union([
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("cancelled"),
	Type.Literal("error")
]);
const WizardStartParamsSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
	workspace: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardAnswerSchema = Type.Object({
	stepId: NonEmptyString,
	value: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const WizardNextParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	answer: Type.Optional(WizardAnswerSchema)
}, { additionalProperties: false });
const WizardSessionIdParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const WizardCancelParamsSchema = WizardSessionIdParamsSchema;
const WizardStatusParamsSchema = WizardSessionIdParamsSchema;
const WizardStepOptionSchema = Type.Object({
	value: Type.Unknown(),
	label: NonEmptyString,
	hint: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStepSchema = Type.Object({
	id: NonEmptyString,
	type: Type.Union([
		Type.Literal("note"),
		Type.Literal("select"),
		Type.Literal("text"),
		Type.Literal("confirm"),
		Type.Literal("multiselect"),
		Type.Literal("progress"),
		Type.Literal("action")
	]),
	title: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(WizardStepOptionSchema)),
	initialValue: Type.Optional(Type.Unknown()),
	placeholder: Type.Optional(Type.String()),
	sensitive: Type.Optional(Type.Boolean()),
	executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")]))
}, { additionalProperties: false });
const WizardResultFields = {
	done: Type.Boolean(),
	step: Type.Optional(WizardStepSchema),
	status: Type.Optional(WizardRunStatusSchema),
	error: Type.Optional(Type.String())
};
Type.Object(WizardResultFields, { additionalProperties: false });
Type.Object({
	sessionId: NonEmptyString,
	...WizardResultFields
}, { additionalProperties: false });
Type.Object({
	status: WizardRunStatusSchema,
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/index.ts
const ajv = new AjvPkg({
	allErrors: true,
	strict: false,
	removeAdditional: false
});
const validateConnectParams = ajv.compile(ConnectParamsSchema);
const validateRequestFrame = ajv.compile(RequestFrameSchema);
const validateResponseFrame = ajv.compile(ResponseFrameSchema);
const validateEventFrame = ajv.compile(EventFrameSchema);
const validateSendParams = ajv.compile(SendParamsSchema);
const validatePollParams = ajv.compile(PollParamsSchema);
const validateAgentParams = ajv.compile(AgentParamsSchema);
const validateAgentIdentityParams = ajv.compile(AgentIdentityParamsSchema);
const validateAgentWaitParams = ajv.compile(AgentWaitParamsSchema);
const validateWakeParams = ajv.compile(WakeParamsSchema);
const validateAgentsListParams = ajv.compile(AgentsListParamsSchema);
const validateAgentsCreateParams = ajv.compile(AgentsCreateParamsSchema);
const validateAgentsUpdateParams = ajv.compile(AgentsUpdateParamsSchema);
const validateAgentsDeleteParams = ajv.compile(AgentsDeleteParamsSchema);
const validateAgentsFilesListParams = ajv.compile(AgentsFilesListParamsSchema);
const validateAgentsFilesGetParams = ajv.compile(AgentsFilesGetParamsSchema);
const validateAgentsFilesSetParams = ajv.compile(AgentsFilesSetParamsSchema);
const validateNodePairRequestParams = ajv.compile(NodePairRequestParamsSchema);
const validateNodePairListParams = ajv.compile(NodePairListParamsSchema);
const validateNodePairApproveParams = ajv.compile(NodePairApproveParamsSchema);
const validateNodePairRejectParams = ajv.compile(NodePairRejectParamsSchema);
const validateNodePairVerifyParams = ajv.compile(NodePairVerifyParamsSchema);
const validateNodeRenameParams = ajv.compile(NodeRenameParamsSchema);
const validateNodeListParams = ajv.compile(NodeListParamsSchema);
const validateNodePendingAckParams = ajv.compile(NodePendingAckParamsSchema);
const validateNodeDescribeParams = ajv.compile(NodeDescribeParamsSchema);
const validateNodeInvokeParams = ajv.compile(NodeInvokeParamsSchema);
const validateNodeInvokeResultParams = ajv.compile(NodeInvokeResultParamsSchema);
const validateNodeEventParams = ajv.compile(NodeEventParamsSchema);
const validateNodePendingDrainParams = ajv.compile(NodePendingDrainParamsSchema);
const validateNodePendingEnqueueParams = ajv.compile(NodePendingEnqueueParamsSchema);
const validatePushTestParams = ajv.compile(PushTestParamsSchema);
const validateSecretsResolveParams = ajv.compile(SecretsResolveParamsSchema);
const validateSecretsResolveResult = ajv.compile(SecretsResolveResultSchema);
const validateSessionsListParams = ajv.compile(SessionsListParamsSchema);
const validateSessionsPreviewParams = ajv.compile(SessionsPreviewParamsSchema);
const validateSessionsResolveParams = ajv.compile(SessionsResolveParamsSchema);
const validateSessionsPatchParams = ajv.compile(SessionsPatchParamsSchema);
const validateSessionsResetParams = ajv.compile(SessionsResetParamsSchema);
const validateSessionsDeleteParams = ajv.compile(SessionsDeleteParamsSchema);
const validateSessionsCompactParams = ajv.compile(SessionsCompactParamsSchema);
const validateSessionsUsageParams = ajv.compile(SessionsUsageParamsSchema);
const validateConfigGetParams = ajv.compile(ConfigGetParamsSchema);
const validateConfigSetParams = ajv.compile(ConfigSetParamsSchema);
const validateConfigApplyParams = ajv.compile(ConfigApplyParamsSchema);
const validateConfigPatchParams = ajv.compile(ConfigPatchParamsSchema);
const validateConfigSchemaParams = ajv.compile(ConfigSchemaParamsSchema);
const validateConfigSchemaLookupParams = ajv.compile(ConfigSchemaLookupParamsSchema);
const validateConfigSchemaLookupResult = ajv.compile(ConfigSchemaLookupResultSchema);
const validateWizardStartParams = ajv.compile(WizardStartParamsSchema);
const validateWizardNextParams = ajv.compile(WizardNextParamsSchema);
const validateWizardCancelParams = ajv.compile(WizardCancelParamsSchema);
const validateWizardStatusParams = ajv.compile(WizardStatusParamsSchema);
const validateTalkModeParams = ajv.compile(TalkModeParamsSchema);
const validateTalkConfigParams = ajv.compile(TalkConfigParamsSchema);
ajv.compile(TalkConfigResultSchema);
const validateChannelsStatusParams = ajv.compile(ChannelsStatusParamsSchema);
const validateChannelsLogoutParams = ajv.compile(ChannelsLogoutParamsSchema);
const validateModelsListParams = ajv.compile(ModelsListParamsSchema);
const validateSkillsStatusParams = ajv.compile(SkillsStatusParamsSchema);
const validateToolsCatalogParams = ajv.compile(ToolsCatalogParamsSchema);
const validateSkillsBinsParams = ajv.compile(SkillsBinsParamsSchema);
const validateSkillsInstallParams = ajv.compile(SkillsInstallParamsSchema);
const validateSkillsUpdateParams = ajv.compile(SkillsUpdateParamsSchema);
const validateCronListParams = ajv.compile(CronListParamsSchema);
const validateCronStatusParams = ajv.compile(CronStatusParamsSchema);
const validateCronAddParams = ajv.compile(CronAddParamsSchema);
const validateCronUpdateParams = ajv.compile(CronUpdateParamsSchema);
const validateCronRemoveParams = ajv.compile(CronRemoveParamsSchema);
const validateCronRunParams = ajv.compile(CronRunParamsSchema);
const validateCronRunsParams = ajv.compile(CronRunsParamsSchema);
const validateDevicePairListParams = ajv.compile(DevicePairListParamsSchema);
const validateDevicePairApproveParams = ajv.compile(DevicePairApproveParamsSchema);
const validateDevicePairRejectParams = ajv.compile(DevicePairRejectParamsSchema);
const validateDevicePairRemoveParams = ajv.compile(DevicePairRemoveParamsSchema);
const validateDeviceTokenRotateParams = ajv.compile(DeviceTokenRotateParamsSchema);
const validateDeviceTokenRevokeParams = ajv.compile(DeviceTokenRevokeParamsSchema);
const validateExecApprovalsGetParams = ajv.compile(ExecApprovalsGetParamsSchema);
const validateExecApprovalsSetParams = ajv.compile(ExecApprovalsSetParamsSchema);
const validateExecApprovalRequestParams = ajv.compile(ExecApprovalRequestParamsSchema);
const validateExecApprovalResolveParams = ajv.compile(ExecApprovalResolveParamsSchema);
const validateExecApprovalsNodeGetParams = ajv.compile(ExecApprovalsNodeGetParamsSchema);
const validateExecApprovalsNodeSetParams = ajv.compile(ExecApprovalsNodeSetParamsSchema);
const validateLogsTailParams = ajv.compile(LogsTailParamsSchema);
const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
const validateChatAbortParams = ajv.compile(ChatAbortParamsSchema);
const validateChatInjectParams = ajv.compile(ChatInjectParamsSchema);
ajv.compile(ChatEventSchema);
const validateUpdateRunParams = ajv.compile(UpdateRunParamsSchema);
const validateWebLoginStartParams = ajv.compile(WebLoginStartParamsSchema);
const validateWebLoginWaitParams = ajv.compile(WebLoginWaitParamsSchema);
function formatValidationErrors(errors) {
	if (!errors?.length) return "unknown validation error";
	const parts = [];
	for (const err of errors) {
		const keyword = typeof err?.keyword === "string" ? err.keyword : "";
		const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";
		if (keyword === "additionalProperties") {
			const additionalProperty = (err?.params)?.additionalProperty;
			if (typeof additionalProperty === "string" && additionalProperty.trim()) {
				const where = instancePath ? `at ${instancePath}` : "at root";
				parts.push(`${where}: unexpected property '${additionalProperty}'`);
				continue;
			}
		}
		const message = typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
		const where = instancePath ? `at ${instancePath}: ` : "";
		parts.push(`${where}${message}`);
	}
	const unique = Array.from(new Set(parts.filter((part) => part.trim())));
	if (!unique.length) return ajv.errorsText(errors, { separator: "; " }) || "unknown validation error";
	return unique.join("; ");
}
//#endregion
//#region src/gateway/client.ts
var GatewayClientRequestError = class extends Error {
	constructor(error) {
		super(error.message ?? "gateway request failed");
		this.name = "GatewayClientRequestError";
		this.gatewayCode = error.code ?? "UNAVAILABLE";
		this.details = error.details;
	}
};
const FORCE_STOP_TERMINATE_GRACE_MS = 250;
const STOP_AND_WAIT_TIMEOUT_MS = 1e3;
var GatewayClient = class {
	constructor(opts) {
		this.ws = null;
		this.pending = /* @__PURE__ */ new Map();
		this.backoffMs = 1e3;
		this.closed = false;
		this.lastSeq = null;
		this.connectNonce = null;
		this.connectSent = false;
		this.connectTimer = null;
		this.pendingDeviceTokenRetry = false;
		this.deviceTokenRetryBudgetUsed = false;
		this.pendingConnectErrorDetailCode = null;
		this.lastTick = null;
		this.tickIntervalMs = 3e4;
		this.tickTimer = null;
		this.pendingStop = null;
		this.opts = {
			...opts,
			deviceIdentity: opts.deviceIdentity === null ? void 0 : opts.deviceIdentity ?? loadOrCreateDeviceIdentity()
		};
		this.requestTimeoutMs = typeof opts.requestTimeoutMs === "number" && Number.isFinite(opts.requestTimeoutMs) ? Math.max(1, Math.min(Math.floor(opts.requestTimeoutMs), 2147483647)) : 3e4;
	}
	start() {
		if (this.closed) return;
		const url = this.opts.url ?? "ws://127.0.0.1:18789";
		if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway tls fingerprint requires wss:// gateway url"));
			return;
		}
		const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
		if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
			let displayHost = url;
			try {
				displayHost = new URL(url).hostname || url;
			} catch {}
			const error = /* @__PURE__ */ new Error(`SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. Both credentials and chat data would be exposed to network interception. Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. ` + (allowPrivateWs ? "" : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1. ") + "Run `openclaw doctor --fix` for guidance.");
			this.opts.onConnectError?.(error);
			return;
		}
		const wsOptions = { maxPayload: 25 * 1024 * 1024 };
		if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
			wsOptions.rejectUnauthorized = false;
			wsOptions.checkServerIdentity = ((_host, cert) => {
				const fingerprintValue = typeof cert === "object" && cert && "fingerprint256" in cert ? cert.fingerprint256 ?? "" : "";
				const fingerprint = normalizeFingerprint(typeof fingerprintValue === "string" ? fingerprintValue : "");
				const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
				if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
				if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
				if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
			});
		}
		const ws = new WebSocket(url, wsOptions);
		this.ws = ws;
		ws.on("open", () => {
			if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
				const tlsError = this.validateTlsFingerprint();
				if (tlsError) {
					this.opts.onConnectError?.(tlsError);
					this.ws?.close(1008, tlsError.message);
					return;
				}
			}
			this.queueConnect();
		});
		ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
		ws.on("close", (code, reason) => {
			const reasonText = rawDataToString(reason);
			const connectErrorDetailCode = this.pendingConnectErrorDetailCode;
			this.pendingConnectErrorDetailCode = null;
			if (this.ws === ws) this.ws = null;
			this.resolvePendingStop(ws);
			if (code === 1008 && reasonText.toLowerCase().includes("device token mismatch") && !this.opts.token && !this.opts.password && this.opts.deviceIdentity) {
				const deviceId = this.opts.deviceIdentity.deviceId;
				const role = this.opts.role ?? "operator";
				try {
					clearDeviceAuthToken({
						deviceId,
						role
					});
					logDebug(`cleared stale device-auth token for device ${deviceId}`);
				} catch (err) {
					logDebug(`failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`);
				}
			}
			this.flushPendingErrors(/* @__PURE__ */ new Error(`gateway closed (${code}): ${reasonText}`));
			if (this.shouldPauseReconnectAfterAuthFailure(connectErrorDetailCode)) {
				this.opts.onClose?.(code, reasonText);
				return;
			}
			this.scheduleReconnect();
			this.opts.onClose?.(code, reasonText);
		});
		ws.on("error", (err) => {
			logDebug(`gateway client error: ${String(err)}`);
			if (!this.connectSent) this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
		});
	}
	stop() {
		this.beginStop();
	}
	async stopAndWait(opts) {
		const stopPromise = this.beginStop();
		if (!stopPromise) return;
		const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : STOP_AND_WAIT_TIMEOUT_MS;
		let timeout = null;
		try {
			await Promise.race([stopPromise, new Promise((_, reject) => {
				timeout = setTimeout(() => {
					reject(/* @__PURE__ */ new Error(`gateway client stop timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				timeout.unref?.();
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	beginStop() {
		this.closed = true;
		this.pendingDeviceTokenRetry = false;
		this.deviceTokenRetryBudgetUsed = false;
		this.pendingConnectErrorDetailCode = null;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		if (this.pendingStop) {
			this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
			return this.pendingStop.promise;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			const stopPromise = this.createPendingStop(ws);
			ws.close();
			setTimeout(() => {
				try {
					ws.terminate();
				} catch {}
				this.resolvePendingStop(ws);
			}, FORCE_STOP_TERMINATE_GRACE_MS).unref?.();
			this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
			return stopPromise;
		}
		this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
		return null;
	}
	createPendingStop(ws) {
		if (this.pendingStop?.ws === ws) return this.pendingStop.promise;
		let resolve;
		const promise = new Promise((res) => {
			resolve = res;
		});
		this.pendingStop = {
			ws,
			promise,
			resolve
		};
		return promise;
	}
	resolvePendingStop(ws) {
		if (this.pendingStop?.ws !== ws) return;
		const { resolve } = this.pendingStop;
		this.pendingStop = null;
		resolve();
	}
	sendConnect() {
		if (this.connectSent) return;
		const nonce = this.connectNonce?.trim() ?? "";
		if (!nonce) {
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
			this.ws?.close(1008, "connect challenge missing nonce");
			return;
		}
		this.connectSent = true;
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		const role = this.opts.role ?? "operator";
		const { authToken, authBootstrapToken, authDeviceToken, authPassword, signatureToken, resolvedDeviceToken, storedToken } = this.selectConnectAuth(role);
		if (this.pendingDeviceTokenRetry && authDeviceToken) this.pendingDeviceTokenRetry = false;
		const auth = authToken || authBootstrapToken || authPassword || resolvedDeviceToken ? {
			token: authToken,
			bootstrapToken: authBootstrapToken,
			deviceToken: authDeviceToken ?? resolvedDeviceToken,
			password: authPassword
		} : void 0;
		const signedAtMs = Date.now();
		const scopes = this.opts.scopes ?? ["operator.admin"];
		const platform = this.opts.platform ?? process.platform;
		const device = (() => {
			if (!this.opts.deviceIdentity) return;
			const payload = buildDeviceAuthPayloadV3({
				deviceId: this.opts.deviceIdentity.deviceId,
				clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				role,
				scopes,
				signedAtMs,
				token: signatureToken ?? null,
				nonce,
				platform,
				deviceFamily: this.opts.deviceFamily
			});
			const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
			return {
				id: this.opts.deviceIdentity.deviceId,
				publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
				signature,
				signedAt: signedAtMs,
				nonce
			};
		})();
		const params = {
			minProtocol: this.opts.minProtocol ?? 3,
			maxProtocol: this.opts.maxProtocol ?? 3,
			client: {
				id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				displayName: this.opts.clientDisplayName,
				version: this.opts.clientVersion ?? VERSION,
				platform,
				deviceFamily: this.opts.deviceFamily,
				mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				instanceId: this.opts.instanceId
			},
			caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
			commands: Array.isArray(this.opts.commands) ? this.opts.commands : void 0,
			permissions: this.opts.permissions && typeof this.opts.permissions === "object" ? this.opts.permissions : void 0,
			pathEnv: this.opts.pathEnv,
			auth,
			role,
			scopes,
			device
		};
		this.request("connect", params).then((helloOk) => {
			this.pendingDeviceTokenRetry = false;
			this.deviceTokenRetryBudgetUsed = false;
			this.pendingConnectErrorDetailCode = null;
			const authInfo = helloOk?.auth;
			if (authInfo?.deviceToken && this.opts.deviceIdentity) storeDeviceAuthToken({
				deviceId: this.opts.deviceIdentity.deviceId,
				role: authInfo.role ?? role,
				token: authInfo.deviceToken,
				scopes: authInfo.scopes ?? []
			});
			this.backoffMs = 1e3;
			this.tickIntervalMs = typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 3e4;
			this.lastTick = Date.now();
			this.startTickWatch();
			this.opts.onHelloOk?.(helloOk);
		}).catch((err) => {
			this.pendingConnectErrorDetailCode = err instanceof GatewayClientRequestError ? readConnectErrorDetailCode(err.details) : null;
			if (this.shouldRetryWithStoredDeviceToken({
				error: err,
				explicitGatewayToken: this.opts.token?.trim() || void 0,
				resolvedDeviceToken,
				storedToken: storedToken ?? void 0
			})) {
				this.pendingDeviceTokenRetry = true;
				this.deviceTokenRetryBudgetUsed = true;
				this.backoffMs = Math.min(this.backoffMs, 250);
			}
			this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
			const msg = `gateway connect failed: ${String(err)}`;
			if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE) logDebug(msg);
			else logError(msg);
			this.ws?.close(1008, "connect failed");
		});
	}
	shouldPauseReconnectAfterAuthFailure(detailCode) {
		if (!detailCode) return false;
		if (detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING || detailCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID || detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING || detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH || detailCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED || detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED || detailCode === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED || detailCode === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED) return true;
		if (detailCode !== ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) return false;
		if (this.pendingDeviceTokenRetry) return false;
		if (!this.isTrustedDeviceRetryEndpoint()) return true;
		return this.deviceTokenRetryBudgetUsed;
	}
	shouldRetryWithStoredDeviceToken(params) {
		if (this.deviceTokenRetryBudgetUsed) return false;
		if (params.resolvedDeviceToken) return false;
		if (!params.explicitGatewayToken || !params.storedToken) return false;
		if (!this.isTrustedDeviceRetryEndpoint()) return false;
		if (!(params.error instanceof GatewayClientRequestError)) return false;
		const detailCode = readConnectErrorDetailCode(params.error.details);
		const advice = readConnectErrorRecoveryAdvice(params.error.details);
		const retryWithDeviceTokenRecommended = advice.recommendedNextStep === "retry_with_device_token";
		return advice.canRetryWithDeviceToken === true || retryWithDeviceTokenRecommended || detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
	}
	isTrustedDeviceRetryEndpoint() {
		const rawUrl = this.opts.url ?? "ws://127.0.0.1:18789";
		try {
			const parsed = new URL(rawUrl);
			const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
			if (isLoopbackHost(parsed.hostname)) return true;
			return protocol === "wss:" && Boolean(this.opts.tlsFingerprint?.trim());
		} catch {
			return false;
		}
	}
	selectConnectAuth(role) {
		const explicitGatewayToken = this.opts.token?.trim() || void 0;
		const explicitBootstrapToken = this.opts.bootstrapToken?.trim() || void 0;
		const explicitDeviceToken = this.opts.deviceToken?.trim() || void 0;
		const authPassword = this.opts.password?.trim() || void 0;
		const storedToken = this.opts.deviceIdentity ? loadDeviceAuthToken({
			deviceId: this.opts.deviceIdentity.deviceId,
			role
		})?.token : null;
		const shouldUseDeviceRetryToken = this.pendingDeviceTokenRetry && !explicitDeviceToken && Boolean(explicitGatewayToken) && Boolean(storedToken) && this.isTrustedDeviceRetryEndpoint();
		const resolvedDeviceToken = explicitDeviceToken ?? (shouldUseDeviceRetryToken || !(explicitGatewayToken || authPassword) && (!explicitBootstrapToken || Boolean(storedToken)) ? storedToken ?? void 0 : void 0);
		const authToken = explicitGatewayToken ?? resolvedDeviceToken;
		const authBootstrapToken = !explicitGatewayToken && !resolvedDeviceToken ? explicitBootstrapToken : void 0;
		return {
			authToken,
			authBootstrapToken,
			authDeviceToken: shouldUseDeviceRetryToken ? storedToken ?? void 0 : void 0,
			authPassword,
			signatureToken: authToken ?? authBootstrapToken ?? void 0,
			resolvedDeviceToken,
			storedToken: storedToken ?? void 0
		};
	}
	handleMessage(raw) {
		try {
			const parsed = JSON.parse(raw);
			if (validateEventFrame(parsed)) {
				const evt = parsed;
				if (evt.event === "connect.challenge") {
					const payload = evt.payload;
					const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
					if (!nonce || nonce.trim().length === 0) {
						this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
						this.ws?.close(1008, "connect challenge missing nonce");
						return;
					}
					this.connectNonce = nonce.trim();
					this.sendConnect();
					return;
				}
				const seq = typeof evt.seq === "number" ? evt.seq : null;
				if (seq !== null) {
					if (this.lastSeq !== null && seq > this.lastSeq + 1) this.opts.onGap?.({
						expected: this.lastSeq + 1,
						received: seq
					});
					this.lastSeq = seq;
				}
				if (evt.event === "tick") this.lastTick = Date.now();
				this.opts.onEvent?.(evt);
				return;
			}
			if (validateResponseFrame(parsed)) {
				const pending = this.pending.get(parsed.id);
				if (!pending) return;
				const status = parsed.payload?.status;
				if (pending.expectFinal && status === "accepted") return;
				this.pending.delete(parsed.id);
				if (pending.timeout) clearTimeout(pending.timeout);
				if (parsed.ok) pending.resolve(parsed.payload);
				else pending.reject(new GatewayClientRequestError({
					code: parsed.error?.code,
					message: parsed.error?.message ?? "unknown error",
					details: parsed.error?.details
				}));
			}
		} catch (err) {
			logDebug(`gateway client parse error: ${String(err)}`);
		}
	}
	queueConnect() {
		this.connectNonce = null;
		this.connectSent = false;
		const rawConnectDelayMs = this.opts.connectDelayMs;
		const connectChallengeTimeoutMs = typeof rawConnectDelayMs === "number" && Number.isFinite(rawConnectDelayMs) ? Math.max(250, Math.min(1e4, rawConnectDelayMs)) : 2e3;
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = setTimeout(() => {
			if (this.connectSent || this.ws?.readyState !== WebSocket.OPEN) return;
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge timeout"));
			this.ws?.close(1008, "connect challenge timeout");
		}, connectChallengeTimeoutMs);
	}
	scheduleReconnect() {
		if (this.closed) return;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
		setTimeout(() => this.start(), delay).unref();
	}
	flushPendingErrors(err) {
		for (const [, p] of this.pending) {
			if (p.timeout) clearTimeout(p.timeout);
			p.reject(err);
		}
		this.pending.clear();
	}
	startTickWatch() {
		if (this.tickTimer) clearInterval(this.tickTimer);
		const rawMinInterval = this.opts.tickWatchMinIntervalMs;
		const minInterval = typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval) ? Math.max(1, Math.min(3e4, rawMinInterval)) : 1e3;
		const interval = Math.max(this.tickIntervalMs, minInterval);
		this.tickTimer = setInterval(() => {
			if (this.closed) return;
			if (!this.lastTick) return;
			if (Date.now() - this.lastTick > this.tickIntervalMs * 2) this.ws?.close(4e3, "tick timeout");
		}, interval);
	}
	validateTlsFingerprint() {
		if (!this.opts.tlsFingerprint || !this.ws) return null;
		const expected = normalizeFingerprint(this.opts.tlsFingerprint);
		if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
		const socket = this.ws._socket;
		if (!socket || typeof socket.getPeerCertificate !== "function") return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? "");
		if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
		return null;
	}
	async request(method, params, opts) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("gateway not connected");
		const id = randomUUID();
		const frame = {
			type: "req",
			id,
			method,
			params
		};
		if (!validateRequestFrame(frame)) throw new Error(`invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`);
		const expectFinal = opts?.expectFinal === true;
		const timeoutMs = opts?.timeoutMs === null ? null : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.min(Math.floor(opts.timeoutMs), 2147483647)) : expectFinal ? null : this.requestTimeoutMs;
		const p = new Promise((resolve, reject) => {
			const timeout = timeoutMs === null ? null : setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`gateway request timeout for ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value),
				reject,
				expectFinal,
				timeout
			});
		});
		this.ws.send(JSON.stringify(frame));
		return p;
	}
};
//#endregion
//#region src/gateway/method-scopes.ts
const ADMIN_SCOPE = "operator.admin";
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";
const CLI_DEFAULT_OPERATOR_SCOPES = [
	ADMIN_SCOPE,
	READ_SCOPE,
	WRITE_SCOPE,
	APPROVALS_SCOPE,
	PAIRING_SCOPE
];
const NODE_ROLE_METHODS = new Set([
	"node.invoke.result",
	"node.event",
	"node.pending.drain",
	"node.canvas.capability.refresh",
	"node.pending.pull",
	"node.pending.ack",
	"skills.bins"
]);
const METHOD_SCOPE_GROUPS = {
	[APPROVALS_SCOPE]: [
		"exec.approval.request",
		"exec.approval.waitDecision",
		"exec.approval.resolve"
	],
	[PAIRING_SCOPE]: [
		"node.pair.request",
		"node.pair.list",
		"node.pair.approve",
		"node.pair.reject",
		"node.pair.verify",
		"device.pair.list",
		"device.pair.approve",
		"device.pair.reject",
		"device.pair.remove",
		"device.token.rotate",
		"device.token.revoke",
		"node.rename"
	],
	[READ_SCOPE]: [
		"health",
		"doctor.memory.status",
		"logs.tail",
		"channels.status",
		"status",
		"usage.status",
		"usage.cost",
		"tts.status",
		"tts.providers",
		"models.list",
		"tools.catalog",
		"agents.list",
		"agent.identity.get",
		"skills.status",
		"voicewake.get",
		"sessions.list",
		"sessions.get",
		"sessions.preview",
		"sessions.resolve",
		"sessions.usage",
		"sessions.usage.timeseries",
		"sessions.usage.logs",
		"cron.list",
		"cron.status",
		"cron.runs",
		"gateway.identity.get",
		"system-presence",
		"last-heartbeat",
		"node.list",
		"node.describe",
		"chat.history",
		"config.get",
		"config.schema.lookup",
		"talk.config",
		"agents.files.list",
		"agents.files.get"
	],
	[WRITE_SCOPE]: [
		"send",
		"poll",
		"agent",
		"agent.wait",
		"wake",
		"talk.mode",
		"tts.enable",
		"tts.disable",
		"tts.convert",
		"tts.setProvider",
		"voicewake.set",
		"node.invoke",
		"chat.send",
		"chat.abort",
		"browser.request",
		"push.test",
		"node.pending.enqueue"
	],
	[ADMIN_SCOPE]: [
		"channels.logout",
		"agents.create",
		"agents.update",
		"agents.delete",
		"skills.install",
		"skills.update",
		"secrets.reload",
		"secrets.resolve",
		"cron.add",
		"cron.update",
		"cron.remove",
		"cron.run",
		"sessions.patch",
		"sessions.reset",
		"sessions.delete",
		"sessions.compact",
		"connect",
		"chat.inject",
		"web.login.start",
		"web.login.wait",
		"set-heartbeats",
		"system-event",
		"agents.files.set"
	]
};
const ADMIN_METHOD_PREFIXES = [
	"exec.approvals.",
	"config.",
	"wizard.",
	"update."
];
const METHOD_SCOPE_BY_NAME = new Map(Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) => methods.map((method) => [method, scope])));
function resolveScopedMethod(method) {
	const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
	if (explicitScope) return explicitScope;
	if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) return ADMIN_SCOPE;
}
function isNodeRoleMethod(method) {
	return NODE_ROLE_METHODS.has(method);
}
function resolveRequiredOperatorScopeForMethod(method) {
	return resolveScopedMethod(method);
}
function resolveLeastPrivilegeOperatorScopesForMethod(method) {
	const requiredScope = resolveRequiredOperatorScopeForMethod(method);
	if (requiredScope) return [requiredScope];
	return [];
}
function authorizeOperatorScopesForMethod(method, scopes) {
	if (scopes.includes("operator.admin")) return { allowed: true };
	const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? "operator.admin";
	if (requiredScope === "operator.read") {
		if (scopes.includes("operator.read") || scopes.includes("operator.write")) return { allowed: true };
		return {
			allowed: false,
			missingScope: READ_SCOPE
		};
	}
	if (scopes.includes(requiredScope)) return { allowed: true };
	return {
		allowed: false,
		missingScope: requiredScope
	};
}
//#endregion
export { validateExecApprovalsNodeSetParams as $, buildDeviceAuthPayloadV3 as $t, validateConfigPatchParams as A, SINGLE_VALUE_FILE_REF_ID as An, validateSessionsUsageParams as At, validateCronRunsParams as B, validateWebLoginStartParams as Bt, validateChannelsStatusParams as C, GATEWAY_CLIENT_CAPS as Cn, validateSessionsCompactParams as Ct, validateChatSendParams as D, hasGatewayClientCap as Dn, validateSessionsPreviewParams as Dt, validateChatInjectParams as E, GATEWAY_CLIENT_NAMES as En, validateSessionsPatchParams as Et, validateConnectParams as F, resolveDefaultSecretProviderAlias as Fn, validateTalkConfigParams as Ft, validateDevicePairRejectParams as G, validateWizardStatusParams as Gt, validateCronUpdateParams as H, validateWizardCancelParams as Ht, validateCronAddParams as I, secretRefKey as In, validateTalkModeParams as It, validateDeviceTokenRotateParams as J, parseSessionLabel as Jt, validateDevicePairRemoveParams as K, ErrorCodes as Kt, validateCronListParams as L, validateToolsCatalogParams as Lt, validateConfigSchemaLookupResult as M, isValidExecSecretRefId as Mn, validateSkillsInstallParams as Mt, validateConfigSchemaParams as N, isValidFileSecretRefId as Nn, validateSkillsStatusParams as Nt, validateConfigApplyParams as O, normalizeGatewayClientMode as On, validateSessionsResetParams as Ot, validateConfigSetParams as P, isValidSecretProviderAlias as Pn, validateSkillsUpdateParams as Pt, validateExecApprovalsNodeGetParams as Q, buildDeviceAuthPayload as Qt, validateCronRemoveParams as R, validateUpdateRunParams as Rt, validateChannelsLogoutParams as S, resolveMessageChannel as Sn, validateSendParams as St, validateChatHistoryParams as T, GATEWAY_CLIENT_MODES as Tn, validateSessionsListParams as Tt, validateDevicePairApproveParams as U, validateWizardNextParams as Ut, validateCronStatusParams as V, validateWebLoginWaitParams as Vt, validateDevicePairListParams as W, validateWizardStartParams as Wt, validateExecApprovalResolveParams as X, resolveAuthConnectErrorDetailCode as Xt, validateExecApprovalRequestParams as Y, ConnectErrorDetailCodes as Yt, validateExecApprovalsGetParams as Z, resolveDeviceAuthConnectErrorDetailCode as Zt, validateAgentsFilesGetParams as _, isMarkdownCapableMessageChannel as _n, validatePollParams as _t, READ_SCOPE as a, publicKeyRawBase64UrlFromPem as an, validateNodeInvokeParams as at, validateAgentsListParams as b, normalizeMessageChannel as bn, validateSecretsResolveParams as bt, isNodeRoleMethod as c, applyInputProvenanceToUserMessage as cn, validateNodePairApproveParams as ct, formatValidationErrors as d, rawDataToString as dn, validateNodePairRequestParams as dt, normalizeDeviceAuthScopes as en, validateExecApprovalsSetParams as et, validateAgentIdentityParams as f, INTERNAL_MESSAGE_CHANNEL as fn, validateNodePairVerifyParams as ft, validateAgentsDeleteParams as g, isInternalMessageChannel as gn, validateNodeRenameParams as gt, validateAgentsCreateParams as h, isGatewayMessageChannel as hn, validateNodePendingEnqueueParams as ht, PAIRING_SCOPE as i, normalizeDevicePublicKeyBase64Url as in, validateNodeEventParams as it, validateConfigSchemaLookupParams as j, formatExecSecretRefIdValidationMessage as jn, validateSkillsBinsParams as jt, validateConfigGetParams as k, SECRET_PROVIDER_ALIAS_PATTERN as kn, validateSessionsResolveParams as kt, resolveLeastPrivilegeOperatorScopesForMethod as l, hasInterSessionUserProvenance as ln, validateNodePairListParams as lt, validateAgentWaitParams as m, isGatewayCliClient as mn, validateNodePendingDrainParams as mt, APPROVALS_SCOPE as n, deriveDeviceIdFromPublicKey as nn, validateModelsListParams as nt, WRITE_SCOPE as o, signDevicePayload as on, validateNodeInvokeResultParams as ot, validateAgentParams as p, isDeliverableMessageChannel as pn, validateNodePendingAckParams as pt, validateDeviceTokenRevokeParams as q, errorShape as qt, CLI_DEFAULT_OPERATOR_SCOPES as r, loadOrCreateDeviceIdentity as rn, validateNodeDescribeParams as rt, authorizeOperatorScopesForMethod as s, verifyDeviceSignature as sn, validateNodeListParams as st, ADMIN_SCOPE as t, normalizeFingerprint as tn, validateLogsTailParams as tt, GatewayClient as u, normalizeInputProvenance as un, validateNodePairRejectParams as ut, validateAgentsFilesListParams as v, isWebchatClient as vn, validatePushTestParams as vt, validateChatAbortParams as w, GATEWAY_CLIENT_IDS as wn, validateSessionsDeleteParams as wt, validateAgentsUpdateParams as x, resolveGatewayMessageChannel as xn, validateSecretsResolveResult as xt, validateAgentsFilesSetParams as y, listDeliverableMessageChannels as yn, validateRequestFrame as yt, validateCronRunParams as z, validateWakeParams as zt };
