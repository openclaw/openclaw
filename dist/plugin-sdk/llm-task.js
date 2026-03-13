import fs from "node:fs";
import os from "node:os";
import path from "node:path";
//#region src/infra/tmp-openclaw-dir.ts
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolvePreferredOpenClawTmpDir(options = {}) {
	const accessSync = options.accessSync ?? fs.accessSync;
	const chmodSync = options.chmodSync ?? fs.chmodSync;
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
	const warn = options.warn ?? ((message) => console.warn(message));
	const getuid = options.getuid ?? (() => {
		try {
			return typeof process.getuid === "function" ? process.getuid() : void 0;
		} catch {
			return;
		}
	});
	const tmpdir = options.tmpdir ?? os.tmpdir;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		if (typeof st.mode === "number" && (st.mode & 18) !== 0) return false;
		return true;
	};
	const fallback = () => {
		const base = tmpdir();
		const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
		return path.join(base, suffix);
	};
	const isTrustedTmpDir = (st) => {
		return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	};
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
			return "available";
		} catch (err) {
			if (isNodeErrorWithCode(err, "ENOENT")) return "missing";
			return "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number" || (st.mode & 18) === 0) return false;
			chmodSync(candidatePath, 448);
			warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
			return resolveDirState(candidatePath) === "available";
		} catch {
			return false;
		}
	};
	const ensureTrustedFallbackDir = () => {
		const fallbackPath = fallback();
		const state = resolveDirState(fallbackPath);
		if (state === "available") return fallbackPath;
		if (state === "invalid") {
			if (tryRepairWritableBits(fallbackPath)) return fallbackPath;
			throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		try {
			mkdirSync(fallbackPath, {
				recursive: true,
				mode: 448
			});
			chmodSync(fallbackPath, 448);
		} catch {
			throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		return fallbackPath;
	};
	const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
	if (existingPreferredState === "available") return POSIX_OPENCLAW_TMP_DIR;
	if (existingPreferredState === "invalid") {
		if (tryRepairWritableBits("/tmp/openclaw")) return POSIX_OPENCLAW_TMP_DIR;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync("/tmp", TMP_DIR_ACCESS_MODE);
		mkdirSync(POSIX_OPENCLAW_TMP_DIR, {
			recursive: true,
			mode: 448
		});
		chmodSync(POSIX_OPENCLAW_TMP_DIR, 448);
		if (resolveDirState("/tmp/openclaw") !== "available" && !tryRepairWritableBits("/tmp/openclaw")) return ensureTrustedFallbackDir();
		return POSIX_OPENCLAW_TMP_DIR;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
//#region src/auto-reply/thinking.ts
function normalizeProviderId(provider) {
	if (!provider) return "";
	const normalized = provider.trim().toLowerCase();
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
	return normalized;
}
function isBinaryThinkingProvider(provider) {
	return normalizeProviderId(provider) === "zai";
}
const XHIGH_MODEL_REFS = [
	"openai/gpt-5.4",
	"openai/gpt-5.4-pro",
	"openai/gpt-5.2",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.3-codex",
	"openai-codex/gpt-5.3-codex-spark",
	"openai-codex/gpt-5.2-codex",
	"openai-codex/gpt-5.1-codex",
	"github-copilot/gpt-5.2-codex",
	"github-copilot/gpt-5.2"
];
const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter((entry) => Boolean(entry)));
function normalizeThinkLevel(raw) {
	if (!raw) return;
	const key = raw.trim().toLowerCase();
	const collapsed = key.replace(/[\s_-]+/g, "");
	if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
	if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
	if (["off"].includes(key)) return "off";
	if ([
		"on",
		"enable",
		"enabled"
	].includes(key)) return "low";
	if (["min", "minimal"].includes(key)) return "minimal";
	if ([
		"low",
		"thinkhard",
		"think-hard",
		"think_hard"
	].includes(key)) return "low";
	if ([
		"mid",
		"med",
		"medium",
		"thinkharder",
		"think-harder",
		"harder"
	].includes(key)) return "medium";
	if ([
		"high",
		"ultra",
		"ultrathink",
		"think-hard",
		"thinkhardest",
		"highest",
		"max"
	].includes(key)) return "high";
	if (["think"].includes(key)) return "minimal";
}
function supportsXHighThinking(provider, model) {
	const modelKey = model?.trim().toLowerCase();
	if (!modelKey) return false;
	const providerKey = provider?.trim().toLowerCase();
	if (providerKey) return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
	return XHIGH_MODEL_IDS.has(modelKey);
}
function listThinkingLevels(provider, model) {
	const levels = [
		"off",
		"minimal",
		"low",
		"medium",
		"high"
	];
	if (supportsXHighThinking(provider, model)) levels.push("xhigh");
	levels.push("adaptive");
	return levels;
}
function listThinkingLevelLabels(provider, model) {
	if (isBinaryThinkingProvider(provider)) return ["off", "on"];
	return listThinkingLevels(provider, model);
}
function formatThinkingLevels(provider, model, separator = ", ") {
	return listThinkingLevelLabels(provider, model).join(separator);
}
function formatXHighModelHint() {
	const refs = [...XHIGH_MODEL_REFS];
	if (refs.length === 0) return "unknown model";
	if (refs.length === 1) return refs[0];
	if (refs.length === 2) return `${refs[0]} or ${refs[1]}`;
	return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}
//#endregion
export { formatThinkingLevels, formatXHighModelHint, normalizeThinkLevel, resolvePreferredOpenClawTmpDir, supportsXHighThinking };
