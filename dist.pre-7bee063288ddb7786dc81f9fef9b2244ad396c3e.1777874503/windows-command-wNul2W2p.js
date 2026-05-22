import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import process$1 from "node:process";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
//#region src/infra/windows-encoding.ts
const WINDOWS_CODEPAGE_ENCODING_MAP = {
	65001: "utf-8",
	54936: "gb18030",
	936: "gbk",
	950: "big5",
	932: "shift_jis",
	949: "euc-kr",
	1252: "windows-1252"
};
let cachedWindowsConsoleEncoding;
function parseWindowsCodePage(raw) {
	if (!raw) return null;
	const match = raw.match(/\b(\d{3,5})\b/);
	if (!match?.[1]) return null;
	const codePage = Number.parseInt(match[1], 10);
	if (!Number.isFinite(codePage) || codePage <= 0) return null;
	return codePage;
}
function resolveWindowsConsoleEncoding() {
	if (process.platform !== "win32") return null;
	if (cachedWindowsConsoleEncoding !== void 0) return cachedWindowsConsoleEncoding;
	try {
		const result = spawnSync("cmd.exe", [
			"/d",
			"/s",
			"/c",
			"chcp"
		], {
			windowsHide: true,
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		const codePage = parseWindowsCodePage(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
		cachedWindowsConsoleEncoding = codePage !== null ? WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null : null;
	} catch {
		cachedWindowsConsoleEncoding = null;
	}
	return cachedWindowsConsoleEncoding;
}
function decodeWindowsOutputBuffer(params) {
	if ((params.platform ?? process.platform) !== "win32") return params.buffer.toString("utf8");
	const utf8 = decodeStrictUtf8(params.buffer);
	if (utf8 !== null) return utf8;
	const encoding = params.windowsEncoding ?? resolveWindowsConsoleEncoding();
	if (!encoding || normalizeLowercaseStringOrEmpty(encoding) === "utf-8") return params.buffer.toString("utf8");
	try {
		return new TextDecoder(encoding).decode(params.buffer);
	} catch {
		return params.buffer.toString("utf8");
	}
}
function createWindowsOutputDecoder(params) {
	const platform = params?.platform ?? process.platform;
	const encoding = platform === "win32" ? params?.windowsEncoding ?? resolveWindowsConsoleEncoding() : null;
	const normalizedEncoding = normalizeLowercaseStringOrEmpty(encoding);
	const legacyDecoder = platform === "win32" && encoding && normalizedEncoding !== "utf-8" ? new TextDecoder(encoding) : null;
	const utf8Decoder = platform === "win32" && legacyDecoder ? new TextDecoder("utf-8", { fatal: true }) : null;
	let useLegacyDecoder = false;
	let pendingUtf8Bytes = Buffer.alloc(0);
	return {
		decode(chunk) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (!legacyDecoder || !utf8Decoder) return buffer.toString("utf8");
			if (useLegacyDecoder) return legacyDecoder.decode(buffer, { stream: true });
			const replayBuffer = pendingUtf8Bytes.length > 0 ? Buffer.concat([pendingUtf8Bytes, buffer]) : buffer;
			try {
				const decoded = utf8Decoder.decode(buffer, { stream: true });
				pendingUtf8Bytes = Buffer.from(getTrailingIncompleteUtf8Bytes(replayBuffer));
				return decoded;
			} catch {
				useLegacyDecoder = true;
				pendingUtf8Bytes = Buffer.alloc(0);
				return legacyDecoder.decode(replayBuffer, { stream: true });
			}
		},
		flush() {
			if (!legacyDecoder || !utf8Decoder) return "";
			if (useLegacyDecoder) return legacyDecoder.decode();
			try {
				const decoded = utf8Decoder.decode();
				pendingUtf8Bytes = Buffer.alloc(0);
				return decoded;
			} catch {
				useLegacyDecoder = true;
				const replayBuffer = pendingUtf8Bytes;
				pendingUtf8Bytes = Buffer.alloc(0);
				return replayBuffer.length > 0 ? legacyDecoder.decode(replayBuffer) : "";
			}
		}
	};
}
function getTrailingIncompleteUtf8Bytes(buffer) {
	let index = buffer.length - 1;
	let continuationBytes = 0;
	while (index >= 0 && buffer[index] !== void 0 && buffer[index] >= 128 && buffer[index] <= 191 && continuationBytes < 3) {
		continuationBytes += 1;
		index -= 1;
	}
	if (index < 0) return buffer;
	const leadByte = buffer[index];
	const sequenceLength = getUtf8SequenceLength(leadByte);
	if (sequenceLength <= 1) return Buffer.alloc(0);
	return continuationBytes + 1 < sequenceLength ? buffer.subarray(index) : Buffer.alloc(0);
}
function getUtf8SequenceLength(byte) {
	if (byte >= 194 && byte <= 223) return 2;
	if (byte >= 224 && byte <= 239) return 3;
	if (byte >= 240 && byte <= 244) return 4;
	return 1;
}
function decodeStrictUtf8(buffer) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return null;
	}
}
//#endregion
//#region src/process/spawn-utils.ts
const DEFAULT_RETRY_CODES = ["EBADF"];
function resolveCommandStdio(params) {
	return [
		params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe",
		"pipe",
		"pipe"
	];
}
function shouldRetry(err, codes) {
	const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
	return code.length > 0 && codes.includes(code);
}
async function spawnAndWaitForSpawn(spawnImpl, argv, options) {
	const child = spawnImpl(argv[0], argv.slice(1), options);
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("spawn", onSpawn);
		};
		const finishResolve = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(child);
		};
		const onError = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const onSpawn = () => {
			finishResolve();
		};
		child.once("error", onError);
		child.once("spawn", onSpawn);
		process.nextTick(() => {
			if (typeof child.pid === "number") finishResolve();
		});
	});
}
async function spawnWithFallback(params) {
	const spawnImpl = params.spawnImpl ?? spawn;
	const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
	const baseOptions = { ...params.options };
	const fallbacks = params.fallbacks ?? [];
	const attempts = [{ options: baseOptions }, ...fallbacks.map((fallback) => ({
		label: fallback.label,
		options: {
			...baseOptions,
			...fallback.options
		}
	}))];
	let lastError;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		try {
			return {
				child: await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options),
				usedFallback: index > 0,
				fallbackLabel: attempt.label
			};
		} catch (err) {
			lastError = err;
			const nextFallback = fallbacks[index];
			if (!nextFallback || !shouldRetry(err, retryCodes)) throw err;
			params.onFallback?.(err, nextFallback);
		}
	}
	throw lastError;
}
//#endregion
//#region src/process/windows-command.ts
function resolveWindowsCommandShim(params) {
	if ((params.platform ?? process$1.platform) !== "win32") return params.command;
	const basename = normalizeLowercaseStringOrEmpty(path.basename(params.command));
	if (path.extname(basename)) return params.command;
	if (params.cmdCommands.includes(basename)) return `${params.command}.cmd`;
	return params.command;
}
//#endregion
export { decodeWindowsOutputBuffer as a, createWindowsOutputDecoder as i, resolveCommandStdio as n, resolveWindowsConsoleEncoding as o, spawnWithFallback as r, resolveWindowsCommandShim as t };
