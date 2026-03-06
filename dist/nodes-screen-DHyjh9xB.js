import { j as resolvePreferredOpenClawTmpDir } from "./globals-DqM7Q4km.js";
import { r as resolveCliName } from "./command-format-CLEQe4bk.js";
import { v as normalizeEnvVarKey } from "./manifest-registry-YpcF6BWJ.js";
import { c as normalizeHostname } from "./proxy-env-CllmEezI.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-DmS0QApa.js";
import { n as resolveSystemRunCommand, t as formatExecCommand } from "./system-run-command-BaNeRDcR.js";
import * as path$1 from "node:path";
import path from "node:path";
import fs from "node:fs";
import * as fs$2 from "node:fs/promises";
import crypto, { randomUUID } from "node:crypto";

//#region src/infra/path-prepend.ts
/**
* Find the actual key used for PATH in the env object.
* On Windows, `process.env` stores it as `Path` (not `PATH`),
* and after copying to a plain object the original casing is preserved.
*/
function findPathKey(env) {
	if ("PATH" in env) return "PATH";
	for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") return key;
	return "PATH";
}
function normalizePathPrepend(entries) {
	if (!Array.isArray(entries)) return [];
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}
function mergePathPrepend(existing, prepend) {
	if (prepend.length === 0) return existing;
	const partsExisting = (existing ?? "").split(path.delimiter).map((part) => part.trim()).filter(Boolean);
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const part of [...prepend, ...partsExisting]) {
		if (seen.has(part)) continue;
		seen.add(part);
		merged.push(part);
	}
	return merged.join(path.delimiter);
}
function applyPathPrepend(env, prepend, options) {
	if (!Array.isArray(prepend) || prepend.length === 0) return;
	const pathKey = findPathKey(env);
	if (options?.requireExisting && !env[pathKey]) return;
	const merged = mergePathPrepend(env[pathKey], prepend);
	if (merged) env[pathKey] = merged;
}

//#endregion
//#region src/infra/node-shell.ts
function buildNodeShellCommand(command, platform) {
	if (String(platform ?? "").trim().toLowerCase().startsWith("win")) return [
		"cmd.exe",
		"/d",
		"/s",
		"/c",
		command
	];
	return [
		"/bin/sh",
		"-lc",
		command
	];
}

//#endregion
//#region src/infra/system-run-normalize.ts
function normalizeNonEmptyString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function normalizeStringArray(value) {
	return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

//#endregion
//#region src/infra/system-run-approval-binding.ts
function normalizeSystemRunApprovalPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value;
	const argv = normalizeStringArray(candidate.argv);
	if (argv.length === 0) return null;
	return {
		argv,
		cwd: normalizeNonEmptyString(candidate.cwd),
		rawCommand: normalizeNonEmptyString(candidate.rawCommand),
		agentId: normalizeNonEmptyString(candidate.agentId),
		sessionKey: normalizeNonEmptyString(candidate.sessionKey)
	};
}
function normalizeSystemRunEnvEntries(env) {
	if (!env || typeof env !== "object" || Array.isArray(env)) return [];
	const entries = [];
	for (const [rawKey, rawValue] of Object.entries(env)) {
		if (typeof rawValue !== "string") continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		entries.push([key, rawValue]);
	}
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	return entries;
}
function hashSystemRunEnvEntries(entries) {
	if (entries.length === 0) return null;
	return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
function buildSystemRunApprovalEnvBinding(env) {
	const entries = normalizeSystemRunEnvEntries(env);
	return {
		envHash: hashSystemRunEnvEntries(entries),
		envKeys: entries.map(([key]) => key)
	};
}
function buildSystemRunApprovalBinding(params) {
	const envBinding = buildSystemRunApprovalEnvBinding(params.env);
	return {
		binding: {
			argv: normalizeStringArray(params.argv),
			cwd: normalizeNonEmptyString(params.cwd),
			agentId: normalizeNonEmptyString(params.agentId),
			sessionKey: normalizeNonEmptyString(params.sessionKey),
			envHash: envBinding.envHash
		},
		envKeys: envBinding.envKeys
	};
}
function argvMatches(expectedArgv, actualArgv) {
	if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) return false;
	for (let i = 0; i < expectedArgv.length; i += 1) if (expectedArgv[i] !== actualArgv[i]) return false;
	return true;
}
const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";
function requestMismatch(details) {
	return {
		ok: false,
		code: "APPROVAL_REQUEST_MISMATCH",
		message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
		details
	};
}
function matchSystemRunApprovalEnvHash(params) {
	if (!params.expectedEnvHash && !params.actualEnvHash) return { ok: true };
	if (!params.expectedEnvHash && params.actualEnvHash) return {
		ok: false,
		code: "APPROVAL_ENV_BINDING_MISSING",
		message: "approval id missing env binding for requested env overrides",
		details: { envKeys: params.actualEnvKeys }
	};
	if (params.expectedEnvHash !== params.actualEnvHash) return {
		ok: false,
		code: "APPROVAL_ENV_MISMATCH",
		message: "approval id env binding mismatch",
		details: {
			envKeys: params.actualEnvKeys,
			expectedEnvHash: params.expectedEnvHash,
			actualEnvHash: params.actualEnvHash
		}
	};
	return { ok: true };
}
function matchSystemRunApprovalBinding(params) {
	if (!argvMatches(params.expected.argv, params.actual.argv)) return requestMismatch();
	if (params.expected.cwd !== params.actual.cwd) return requestMismatch();
	if (params.expected.agentId !== params.actual.agentId) return requestMismatch();
	if (params.expected.sessionKey !== params.actual.sessionKey) return requestMismatch();
	return matchSystemRunApprovalEnvHash({
		expectedEnvHash: params.expected.envHash,
		actualEnvHash: params.actual.envHash,
		actualEnvKeys: params.actualEnvKeys
	});
}
function missingSystemRunApprovalBinding(params) {
	return requestMismatch({ envKeys: params.actualEnvKeys });
}
function toSystemRunApprovalMismatchError(params) {
	const details = {
		code: params.match.code,
		runId: params.runId
	};
	if (params.match.details) Object.assign(details, params.match.details);
	return {
		ok: false,
		message: params.match.message,
		details
	};
}

//#endregion
//#region src/infra/system-run-approval-context.ts
function normalizeCommandText(value) {
	return typeof value === "string" ? value : "";
}
function parsePreparedSystemRunPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const raw = payload;
	const cmdText = normalizeNonEmptyString(raw.cmdText);
	const plan = normalizeSystemRunApprovalPlan(raw.plan);
	if (!cmdText || !plan) return null;
	return {
		cmdText,
		plan
	};
}
function resolveSystemRunApprovalRequestContext(params) {
	const plan = (normalizeNonEmptyString(params.host) ?? "") === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
	const fallbackArgv = normalizeStringArray(params.commandArgv);
	const fallbackCommand = normalizeCommandText(params.command);
	return {
		plan,
		commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : void 0),
		commandText: plan ? plan.rawCommand ?? formatExecCommand(plan.argv) : fallbackCommand,
		cwd: plan?.cwd ?? normalizeNonEmptyString(params.cwd),
		agentId: plan?.agentId ?? normalizeNonEmptyString(params.agentId),
		sessionKey: plan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey)
	};
}
function resolveSystemRunApprovalRuntimeContext(params) {
	const normalizedPlan = normalizeSystemRunApprovalPlan(params.plan ?? null);
	if (normalizedPlan) return {
		ok: true,
		plan: normalizedPlan,
		argv: [...normalizedPlan.argv],
		cwd: normalizedPlan.cwd,
		agentId: normalizedPlan.agentId,
		sessionKey: normalizedPlan.sessionKey,
		rawCommand: normalizedPlan.rawCommand
	};
	const command = resolveSystemRunCommand({
		command: params.command,
		rawCommand: params.rawCommand
	});
	if (!command.ok) return {
		ok: false,
		message: command.message,
		details: command.details
	};
	return {
		ok: true,
		plan: null,
		argv: command.argv,
		cwd: normalizeNonEmptyString(params.cwd),
		agentId: normalizeNonEmptyString(params.agentId),
		sessionKey: normalizeNonEmptyString(params.sessionKey),
		rawCommand: normalizeNonEmptyString(params.rawCommand)
	};
}

//#endregion
//#region src/cli/nodes-media-utils.ts
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function asString(value) {
	return typeof value === "string" ? value : void 0;
}
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function resolveTempPathParts(opts) {
	const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
	if (!opts.tmpDir) fs.mkdirSync(tmpDir, {
		recursive: true,
		mode: 448
	});
	return {
		tmpDir,
		id: opts.id ?? randomUUID(),
		ext: opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`
	};
}

//#endregion
//#region src/cli/nodes-camera.ts
const MAX_CAMERA_URL_DOWNLOAD_BYTES = 250 * 1024 * 1024;
function parseCameraSnapPayload(value) {
	const obj = asRecord(value);
	const format = asString(obj.format);
	const base64 = asString(obj.base64);
	const url = asString(obj.url);
	const width = asNumber(obj.width);
	const height = asNumber(obj.height);
	if (!format || !base64 && !url || width === void 0 || height === void 0) throw new Error("invalid camera.snap payload");
	return {
		format,
		...base64 ? { base64 } : {},
		...url ? { url } : {},
		width,
		height
	};
}
function parseCameraClipPayload(value) {
	const obj = asRecord(value);
	const format = asString(obj.format);
	const base64 = asString(obj.base64);
	const url = asString(obj.url);
	const durationMs = asNumber(obj.durationMs);
	const hasAudio = asBoolean(obj.hasAudio);
	if (!format || !base64 && !url || durationMs === void 0 || hasAudio === void 0) throw new Error("invalid camera.clip payload");
	return {
		format,
		...base64 ? { base64 } : {},
		...url ? { url } : {},
		durationMs,
		hasAudio
	};
}
function cameraTempPath(opts) {
	const { tmpDir, id, ext } = resolveTempPathParts({
		tmpDir: opts.tmpDir,
		id: opts.id,
		ext: opts.ext
	});
	const facingPart = opts.facing ? `-${opts.facing}` : "";
	const cliName = resolveCliName();
	return path$1.join(tmpDir, `${cliName}-camera-${opts.kind}${facingPart}-${id}${ext}`);
}
async function writeUrlToFile(filePath, url, opts) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") throw new Error(`writeUrlToFile: only https URLs are allowed, got ${parsed.protocol}`);
	const expectedHost = normalizeHostname(opts.expectedHost);
	if (!expectedHost) throw new Error("writeUrlToFile: expectedHost is required");
	if (normalizeHostname(parsed.hostname) !== expectedHost) throw new Error(`writeUrlToFile: url host ${parsed.hostname} must match node host ${opts.expectedHost}`);
	const policy = {
		allowPrivateNetwork: true,
		allowedHostnames: [expectedHost],
		hostnameAllowlist: [expectedHost]
	};
	let release = async () => {};
	let bytes = 0;
	try {
		const guarded = await fetchWithSsrFGuard({
			url,
			auditContext: "writeUrlToFile",
			policy
		});
		release = guarded.release;
		const finalUrl = new URL(guarded.finalUrl);
		if (finalUrl.protocol !== "https:") throw new Error(`writeUrlToFile: redirect resolved to non-https URL ${guarded.finalUrl}`);
		if (normalizeHostname(finalUrl.hostname) !== expectedHost) throw new Error(`writeUrlToFile: redirect host ${finalUrl.hostname} must match node host ${opts.expectedHost}`);
		const res = guarded.response;
		if (!res.ok) throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
		const contentLengthRaw = res.headers.get("content-length");
		const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : void 0;
		if (typeof contentLength === "number" && Number.isFinite(contentLength) && contentLength > MAX_CAMERA_URL_DOWNLOAD_BYTES) throw new Error(`writeUrlToFile: content-length ${contentLength} exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`);
		const body = res.body;
		if (!body) throw new Error(`failed to download ${url}: empty response body`);
		const fileHandle = await fs$2.open(filePath, "w");
		let thrown;
		try {
			const reader = body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				bytes += value.byteLength;
				if (bytes > MAX_CAMERA_URL_DOWNLOAD_BYTES) throw new Error(`writeUrlToFile: downloaded ${bytes} bytes, exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`);
				await fileHandle.write(value);
			}
		} catch (err) {
			thrown = err;
		} finally {
			await fileHandle.close();
		}
		if (thrown) {
			await fs$2.unlink(filePath).catch(() => {});
			throw thrown;
		}
	} finally {
		await release();
	}
	return {
		path: filePath,
		bytes
	};
}
async function writeBase64ToFile(filePath, base64) {
	const buf = Buffer.from(base64, "base64");
	await fs$2.writeFile(filePath, buf);
	return {
		path: filePath,
		bytes: buf.length
	};
}
function requireNodeRemoteIp(remoteIp) {
	const normalized = remoteIp?.trim();
	if (!normalized) throw new Error("camera URL payload requires node remoteIp");
	return normalized;
}
async function writeCameraPayloadToFile(params) {
	if (params.payload.url) {
		await writeUrlToFile(params.filePath, params.payload.url, { expectedHost: requireNodeRemoteIp(params.expectedHost) });
		return;
	}
	if (params.payload.base64) {
		await writeBase64ToFile(params.filePath, params.payload.base64);
		return;
	}
	throw new Error(params.invalidPayloadMessage ?? "invalid camera payload");
}
async function writeCameraClipPayloadToFile(params) {
	const filePath = cameraTempPath({
		kind: "clip",
		facing: params.facing,
		ext: params.payload.format,
		tmpDir: params.tmpDir,
		id: params.id
	});
	await writeCameraPayloadToFile({
		filePath,
		payload: params.payload,
		expectedHost: params.expectedHost,
		invalidPayloadMessage: "invalid camera.clip payload"
	});
	return filePath;
}

//#endregion
//#region src/cli/nodes-canvas.ts
function parseCanvasSnapshotPayload(value) {
	const obj = asRecord(value);
	const format = asString(obj.format);
	const base64 = asString(obj.base64);
	if (!format || !base64) throw new Error("invalid canvas.snapshot payload");
	return {
		format,
		base64
	};
}
function canvasSnapshotTempPath(opts) {
	const { tmpDir, id, ext } = resolveTempPathParts(opts);
	const cliName = resolveCliName();
	return path$1.join(tmpDir, `${cliName}-canvas-snapshot-${id}${ext}`);
}

//#endregion
//#region src/cli/nodes-run.ts
function parseEnvPairs(pairs) {
	if (!Array.isArray(pairs) || pairs.length === 0) return;
	const env = {};
	for (const pair of pairs) {
		if (typeof pair !== "string") continue;
		const idx = pair.indexOf("=");
		if (idx <= 0) continue;
		const key = pair.slice(0, idx).trim();
		if (!key) continue;
		env[key] = pair.slice(idx + 1);
	}
	return Object.keys(env).length > 0 ? env : void 0;
}

//#endregion
//#region src/cli/nodes-screen.ts
function parseScreenRecordPayload(value) {
	const obj = asRecord(value);
	const format = asString(obj.format);
	const base64 = asString(obj.base64);
	if (!format || !base64) throw new Error("invalid screen.record payload");
	return {
		format,
		base64,
		durationMs: typeof obj.durationMs === "number" ? obj.durationMs : void 0,
		fps: typeof obj.fps === "number" ? obj.fps : void 0,
		screenIndex: typeof obj.screenIndex === "number" ? obj.screenIndex : void 0,
		hasAudio: typeof obj.hasAudio === "boolean" ? obj.hasAudio : void 0
	};
}
function screenRecordTempPath(opts) {
	const { tmpDir, id, ext } = resolveTempPathParts(opts);
	return path$1.join(tmpDir, `openclaw-screen-record-${id}${ext}`);
}
async function writeScreenRecordToFile(filePath, base64) {
	return writeBase64ToFile(filePath, base64);
}

//#endregion
export { mergePathPrepend as C, findPathKey as S, matchSystemRunApprovalBinding as _, canvasSnapshotTempPath as a, buildNodeShellCommand as b, parseCameraClipPayload as c, writeCameraClipPayloadToFile as d, writeCameraPayloadToFile as f, buildSystemRunApprovalBinding as g, resolveSystemRunApprovalRuntimeContext as h, parseEnvPairs as i, parseCameraSnapPayload as l, resolveSystemRunApprovalRequestContext as m, screenRecordTempPath as n, parseCanvasSnapshotPayload as o, parsePreparedSystemRunPayload as p, writeScreenRecordToFile as r, cameraTempPath as s, parseScreenRecordPayload as t, writeBase64ToFile as u, missingSystemRunApprovalBinding as v, normalizePathPrepend as w, applyPathPrepend as x, toSystemRunApprovalMismatchError as y };