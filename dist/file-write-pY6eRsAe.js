import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { A as canonicalPathFromExistingAncestor, N as resolveAbsolutePathForWrite } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import "./security-runtime-CcSekjBd.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/node-host/file-write.ts
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
function sha256Hex(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}
function err(code, message, canonicalPath) {
	return {
		ok: false,
		code,
		message,
		...canonicalPath ? { canonicalPath } : {}
	};
}
function symlinkRedirectError(error) {
	return err("SYMLINK_REDIRECT", "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowWritePaths to the canonical path)", error.cause && typeof error.cause === "object" && "canonicalPath" in error.cause && typeof error.cause.canonicalPath === "string" ? error.cause.canonicalPath : void 0);
}
function writeFsSafeError(error, targetPath) {
	if (error.code === "symlink") return err("SYMLINK_TARGET_DENIED", `path is a symlink; refusing to write through it: ${targetPath}`);
	if (error.code === "not-file") return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
	if (error.code === "already-exists") return err("EXISTS_NO_OVERWRITE", `file already exists and overwrite is false: ${targetPath}`);
	return err("WRITE_ERROR", error.message, targetPath);
}
async function handleFileWrite(params) {
	const rawPath = typeof params?.path === "string" ? params.path : "";
	const hasContentBase64 = typeof params?.contentBase64 === "string";
	const contentBase64 = hasContentBase64 ? params.contentBase64 : "";
	const overwrite = params?.overwrite === true;
	const createParents = params?.createParents === true;
	const expectedSha256 = typeof params?.expectedSha256 === "string" ? params.expectedSha256 : void 0;
	const followSymlinks = params?.followSymlinks === true;
	const preflightOnly = params?.preflightOnly === true;
	if (!rawPath) return err("INVALID_PATH", "path is required");
	if (rawPath.includes("\0")) return err("INVALID_PATH", "path must not contain NUL bytes");
	if (!path.isAbsolute(rawPath)) return err("INVALID_PATH", "path must be absolute");
	if (!hasContentBase64) return err("INVALID_BASE64", "contentBase64 is required");
	const buf = Buffer.from(contentBase64, "base64");
	const reEncoded = buf.toString("base64");
	const normalize = (s) => s.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
	if (normalize(reEncoded) !== normalize(contentBase64)) return err("INVALID_BASE64", "contentBase64 is not valid base64");
	if (buf.length > MAX_CONTENT_BYTES) return err("FILE_TOO_LARGE", `decoded content is ${buf.length} bytes; maximum is ${MAX_CONTENT_BYTES} bytes (16 MB)`);
	let targetPath;
	let parentDir;
	let parentExists;
	try {
		const resolved = await resolveAbsolutePathForWrite(rawPath, { symlinks: followSymlinks ? "follow" : "reject" });
		targetPath = resolved.path;
		parentDir = resolved.parentDir;
		parentExists = resolved.parentExists;
	} catch (error) {
		if (error instanceof FsSafeError && error.code === "symlink") return symlinkRedirectError(error);
		throw error;
	}
	if (!parentExists) {
		if (!createParents) return err("PARENT_NOT_FOUND", `parent directory does not exist: ${parentDir}`);
		if (preflightOnly) {
			const computedSha256 = sha256Hex(buf);
			if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) return err("INTEGRITY_FAILURE", `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`, targetPath);
			return {
				ok: true,
				path: await canonicalPathFromExistingAncestor(targetPath),
				size: buf.length,
				sha256: computedSha256,
				overwritten: false
			};
		}
		try {
			await fs.mkdir(parentDir, { recursive: true });
		} catch (mkdirErr) {
			return err("WRITE_ERROR", `failed to create parent directories: ${mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)}`);
		}
	}
	try {
		await resolveAbsolutePathForWrite(targetPath, { symlinks: followSymlinks ? "follow" : "reject" });
	} catch (error) {
		if (error instanceof FsSafeError && error.code === "symlink") return symlinkRedirectError(error);
		throw error;
	}
	const targetFileName = path.basename(targetPath);
	const parentRoot = await root(parentDir);
	let overwritten = false;
	try {
		const existingLStat = await fs.lstat(targetPath);
		if (existingLStat.isSymbolicLink()) return err("SYMLINK_TARGET_DENIED", `path is a symlink; refusing to write through it: ${targetPath}`);
		if (existingLStat.isDirectory()) return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
		if (!overwrite) return err("EXISTS_NO_OVERWRITE", `file already exists and overwrite is false: ${targetPath}`);
		overwritten = true;
	} catch (statErr) {
		const statErrorCode = statErr instanceof FsSafeError ? statErr.code : statErr.code;
		if (statErrorCode !== "not-found" && statErrorCode !== "ENOENT") {
			const message = statErr instanceof Error ? statErr.message : String(statErr);
			if (message.toLowerCase().includes("permission")) return err("PERMISSION_DENIED", `permission denied: ${targetPath}`);
			return err("WRITE_ERROR", `unexpected stat error: ${message}`);
		}
	}
	const computedSha256 = sha256Hex(buf);
	if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) return err("INTEGRITY_FAILURE", `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`, targetPath);
	if (preflightOnly) return {
		ok: true,
		path: await canonicalPathFromExistingAncestor(targetPath),
		size: buf.length,
		sha256: computedSha256,
		overwritten
	};
	try {
		if (overwrite) await parentRoot.write(targetFileName, buf);
		else await parentRoot.create(targetFileName, buf);
	} catch (writeErr) {
		if (writeErr instanceof FsSafeError) return writeFsSafeError(writeErr, targetPath);
		const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
		if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) return err("PERMISSION_DENIED", `permission denied writing to: ${parentDir}`);
		return err("WRITE_ERROR", `failed to write file: ${message}`);
	}
	let canonicalPath = targetPath;
	try {
		const opened = await parentRoot.open(targetFileName);
		canonicalPath = opened.realPath;
		await opened.handle.close().catch(() => void 0);
	} catch (openErr) {
		if (openErr instanceof FsSafeError) return writeFsSafeError(openErr, targetPath);
	}
	return {
		ok: true,
		path: canonicalPath,
		size: buf.length,
		sha256: computedSha256,
		overwritten
	};
}
//#endregion
export { handleFileWrite };
