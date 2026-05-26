import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
//#region src/infra/tmp-openclaw-dir.ts
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolvePreferredOpenClawTmpDir(options = {}) {
	const accessMode = fs.constants.W_OK | fs.constants.X_OK;
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
	const tmpdir$1 = typeof options.tmpdir === "function" ? options.tmpdir : tmpdir;
	const platform = options.platform ?? process.platform;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		return typeof st.mode !== "number" || (st.mode & 18) === 0;
	};
	const fallback = () => {
		const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
		return (platform === "win32" ? path.win32.join : path.join)(tmpdir$1(), suffix);
	};
	const isTrustedTmpDir = (st) => st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, accessMode);
			return "available";
		} catch (err) {
			return isNodeErrorWithCode(err, "ENOENT") ? "missing" : "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number") return false;
			if ((st.mode & 18) === 0) return resolveDirState(candidatePath) === "available";
			try {
				chmodSync(candidatePath, 448);
			} catch (chmodErr) {
				if (isNodeErrorWithCode(chmodErr, "EPERM") || isNodeErrorWithCode(chmodErr, "EACCES") || isNodeErrorWithCode(chmodErr, "ENOENT")) return resolveDirState(candidatePath) === "available";
				throw chmodErr;
			}
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
	if (platform === "win32") return ensureTrustedFallbackDir();
	const preferredDir = POSIX_OPENCLAW_TMP_DIR;
	const preferredState = resolveDirState(preferredDir);
	if (preferredState === "available") return preferredDir;
	if (preferredState === "invalid") {
		if (tryRepairWritableBits(preferredDir)) return preferredDir;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync(path.dirname(preferredDir), accessMode);
		mkdirSync(preferredDir, {
			recursive: true,
			mode: 448
		});
		chmodSync(preferredDir, 448);
		if (resolveDirState(preferredDir) !== "available" && !tryRepairWritableBits(preferredDir)) return ensureTrustedFallbackDir();
		return preferredDir;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
export { resolvePreferredOpenClawTmpDir as n, POSIX_OPENCLAW_TMP_DIR as t };
