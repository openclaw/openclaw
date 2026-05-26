import { f as readStringValue } from "./string-coerce-DyL154ka.js";
import { n as resolveCliName } from "./cli-name-C-K1n6ar.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as asRecord } from "./record-coerce-aMlBWINm.js";
import { t as normalizeHostname } from "./hostname-DX6nIUV7.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import fs from "node:fs";
import * as path$1 from "node:path";
import * as fs$2 from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region src/cli/nodes-media-utils.ts
const asString = readStringValue;
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
export { parseCameraClipPayload as a, writeCameraPayloadToFile as c, cameraTempPath as i, screenRecordTempPath as n, parseCameraSnapPayload as o, writeScreenRecordToFile as r, writeCameraClipPayloadToFile as s, parseScreenRecordPayload as t };
