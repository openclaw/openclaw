import { p as resolveUserPath } from "./utils-D5swhEXt.js";
import { t as openVerifiedFileSync } from "./safe-open-sync-BVLkOkpr.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomBytes } from "node:crypto";
//#region src/infra/secret-file.ts
const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;
const PRIVATE_SECRET_DIR_MODE = 448;
const PRIVATE_SECRET_FILE_MODE = 384;
function normalizeSecretReadError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
function loadSecretFileSync(filePath, label, options = {}) {
	const resolvedPath = resolveUserPath(filePath.trim());
	if (!resolvedPath) return {
		ok: false,
		message: `${label} file path is empty.`
	};
	const maxBytes = options.maxBytes ?? 16384;
	let previewStat;
	try {
		previewStat = fs.lstatSync(resolvedPath);
	} catch (error) {
		const normalized = normalizeSecretReadError(error);
		return {
			ok: false,
			resolvedPath,
			error: normalized,
			message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`
		};
	}
	if (options.rejectSymlink && previewStat.isSymbolicLink()) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must not be a symlink.`
	};
	if (!previewStat.isFile()) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must be a regular file.`
	};
	if (previewStat.size > maxBytes) return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`
	};
	const opened = openVerifiedFileSync({
		filePath: resolvedPath,
		rejectPathSymlink: options.rejectSymlink,
		maxBytes
	});
	if (!opened.ok) {
		const error = normalizeSecretReadError(opened.reason === "validation" ? /* @__PURE__ */ new Error("security validation failed") : opened.error);
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`
		};
	}
	try {
		const secret = fs.readFileSync(opened.fd, "utf8").trim();
		if (!secret) return {
			ok: false,
			resolvedPath,
			message: `${label} file at ${resolvedPath} is empty.`
		};
		return {
			ok: true,
			secret,
			resolvedPath
		};
	} catch (error) {
		const normalized = normalizeSecretReadError(error);
		return {
			ok: false,
			resolvedPath,
			error: normalized,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(normalized)}`
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function readSecretFileSync(filePath, label, options = {}) {
	const result = loadSecretFileSync(filePath, label, options);
	if (result.ok) return result.secret;
	throw new Error(result.message, result.error ? { cause: result.error } : void 0);
}
function tryReadSecretFileSync(filePath, label, options = {}) {
	if (!filePath?.trim()) return;
	const result = loadSecretFileSync(filePath, label, options);
	return result.ok ? result.secret : void 0;
}
function assertPathWithinRoot(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Private secret path must stay under ${rootDir}.`);
}
function assertRealPathWithinRoot(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Private secret path must stay under ${rootDir}.`);
}
async function enforcePrivatePathMode(resolvedPath, expectedMode, kind) {
	if (process.platform === "win32") return;
	await fs$1.chmod(resolvedPath, expectedMode);
	const actualMode = (await fs$1.stat(resolvedPath)).mode & 511;
	if (actualMode !== expectedMode) throw new Error(`Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`);
}
async function ensurePrivateDirectory(rootDir, targetDir) {
	const resolvedRoot = path.resolve(rootDir);
	const resolvedTarget = path.resolve(targetDir);
	if (resolvedTarget === resolvedRoot) {
		await fs$1.mkdir(resolvedRoot, {
			recursive: true,
			mode: 448
		});
		const rootStat = await fs$1.lstat(resolvedRoot);
		if (rootStat.isSymbolicLink()) throw new Error(`Private secret root ${resolvedRoot} must not be a symlink.`);
		if (!rootStat.isDirectory()) throw new Error(`Private secret root ${resolvedRoot} must be a directory.`);
		await enforcePrivatePathMode(resolvedRoot, 448, "directory");
		return;
	}
	assertPathWithinRoot(resolvedRoot, resolvedTarget);
	await ensurePrivateDirectory(resolvedRoot, resolvedRoot);
	const resolvedRootReal = await fs$1.realpath(resolvedRoot);
	let current = resolvedRoot;
	for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = await fs$1.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`Private secret directory component ${current} must not be a symlink.`);
			if (!stat.isDirectory()) throw new Error(`Private secret directory component ${current} must be a directory.`);
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			await fs$1.mkdir(current, { mode: 448 });
		}
		const currentReal = await fs$1.realpath(current);
		assertRealPathWithinRoot(resolvedRootReal, currentReal);
		await enforcePrivatePathMode(currentReal, 448, "directory");
	}
}
async function writePrivateSecretFileAtomic(params) {
	const resolvedRoot = path.resolve(params.rootDir);
	const resolvedFile = path.resolve(params.filePath);
	assertPathWithinRoot(resolvedRoot, resolvedFile);
	const intendedParentDir = path.dirname(resolvedFile);
	await ensurePrivateDirectory(resolvedRoot, intendedParentDir);
	const resolvedRootReal = await fs$1.realpath(resolvedRoot);
	const parentDir = await fs$1.realpath(intendedParentDir);
	assertRealPathWithinRoot(resolvedRootReal, parentDir);
	const fileName = path.basename(resolvedFile);
	const finalFilePath = path.join(parentDir, fileName);
	try {
		const stat = await fs$1.lstat(finalFilePath);
		if (stat.isSymbolicLink()) throw new Error(`Private secret file ${finalFilePath} must not be a symlink.`);
		if (!stat.isFile()) throw new Error(`Private secret file ${finalFilePath} must be a regular file.`);
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const tempPath = path.join(parentDir, `.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
	let createdTemp = false;
	try {
		const handle = await fs$1.open(tempPath, "wx", 384);
		createdTemp = true;
		try {
			await handle.writeFile(params.content);
		} finally {
			await handle.close();
		}
		await enforcePrivatePathMode(tempPath, 384, "file");
		if (await fs$1.realpath(intendedParentDir) !== parentDir) throw new Error(`Private secret parent directory changed during write for ${finalFilePath}.`);
		await fs$1.rename(tempPath, finalFilePath);
		createdTemp = false;
		await enforcePrivatePathMode(finalFilePath, 384, "file");
	} finally {
		if (createdTemp) await fs$1.unlink(tempPath).catch(() => void 0);
	}
}
//#endregion
export { readSecretFileSync as a, loadSecretFileSync as i, PRIVATE_SECRET_DIR_MODE as n, tryReadSecretFileSync as o, PRIVATE_SECRET_FILE_MODE as r, writePrivateSecretFileAtomic as s, DEFAULT_SECRET_FILE_MAX_BYTES as t };
