import { Lt as resolvePreferredOpenClawTmpDir } from "./entry.js";
import { r as resolveCliName } from "./command-format-CDHXQh1_.js";
import * as path$1 from "node:path";
import path from "node:path";
import fs from "node:fs";
import * as fs$2 from "node:fs/promises";
import { randomUUID } from "node:crypto";

//#region src/infra/path-prepend.ts
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
	if (options?.requireExisting && !env.PATH) return;
	const merged = mergePathPrepend(env.PATH, prepend);
	if (merged) env.PATH = merged;
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
async function writeUrlToFile(filePath, url) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") throw new Error(`writeUrlToFile: only https URLs are allowed, got ${parsed.protocol}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
	const contentLengthRaw = res.headers.get("content-length");
	const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : void 0;
	if (typeof contentLength === "number" && Number.isFinite(contentLength) && contentLength > MAX_CAMERA_URL_DOWNLOAD_BYTES) throw new Error(`writeUrlToFile: content-length ${contentLength} exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`);
	const body = res.body;
	if (!body) throw new Error(`failed to download ${url}: empty response body`);
	const fileHandle = await fs$2.open(filePath, "w");
	let bytes = 0;
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
async function writeCameraClipPayloadToFile(params) {
	const filePath = cameraTempPath({
		kind: "clip",
		facing: params.facing,
		ext: params.payload.format,
		tmpDir: params.tmpDir,
		id: params.id
	});
	if (params.payload.url) await writeUrlToFile(filePath, params.payload.url);
	else if (params.payload.base64) await writeBase64ToFile(filePath, params.payload.base64);
	else throw new Error("invalid camera.clip payload");
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
export { canvasSnapshotTempPath as a, parseCameraClipPayload as c, writeCameraClipPayloadToFile as d, writeUrlToFile as f, normalizePathPrepend as g, mergePathPrepend as h, parseEnvPairs as i, parseCameraSnapPayload as l, applyPathPrepend as m, screenRecordTempPath as n, parseCanvasSnapshotPayload as o, buildNodeShellCommand as p, writeScreenRecordToFile as r, cameraTempPath as s, parseScreenRecordPayload as t, writeBase64ToFile as u };