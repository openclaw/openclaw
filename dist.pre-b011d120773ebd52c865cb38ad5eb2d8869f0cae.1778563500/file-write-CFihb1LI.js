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
async function pathExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
async function findExistingAncestor(p) {
	let current = p;
	while (true) {
		try {
			await fs.lstat(current);
			return current;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
async function canonicalTargetFromExistingAncestor(targetPath) {
	const ancestor = await findExistingAncestor(targetPath);
	if (!ancestor) return targetPath;
	let canonicalAncestor;
	try {
		canonicalAncestor = await fs.realpath(ancestor);
	} catch {
		canonicalAncestor = ancestor;
	}
	const relative = path.relative(ancestor, targetPath);
	return relative ? path.join(canonicalAncestor, relative) : canonicalAncestor;
}
async function rejectParentSymlinkRedirect(targetPath, parentDir) {
	const ancestor = await findExistingAncestor(parentDir);
	if (!ancestor) return null;
	let canonicalAncestor;
	try {
		canonicalAncestor = await fs.realpath(ancestor);
	} catch {
		return null;
	}
	if (canonicalAncestor === ancestor) return null;
	const canonicalTarget = path.join(canonicalAncestor, path.relative(ancestor, targetPath));
	return err("SYMLINK_REDIRECT", `parent ${ancestor} resolves through a symlink to ${canonicalAncestor}; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowWritePaths to the canonical path)`, canonicalTarget);
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
	const targetPath = path.normalize(rawPath);
	const parentDir = path.dirname(targetPath);
	const parentExists = await pathExists(parentDir);
	if (!followSymlinks) {
		const redirect = await rejectParentSymlinkRedirect(targetPath, parentDir);
		if (redirect) return redirect;
	}
	if (!parentExists) {
		if (!createParents) return err("PARENT_NOT_FOUND", `parent directory does not exist: ${parentDir}`);
		if (preflightOnly) {
			const computedSha256 = sha256Hex(buf);
			if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) return err("INTEGRITY_FAILURE", `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`, targetPath);
			return {
				ok: true,
				path: await canonicalTargetFromExistingAncestor(targetPath),
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
	if (!followSymlinks) {
		const redirect = await rejectParentSymlinkRedirect(targetPath, parentDir);
		if (redirect) return redirect;
	}
	let overwritten = false;
	try {
		const existingLStat = await fs.lstat(targetPath);
		if (existingLStat.isSymbolicLink()) return err("SYMLINK_TARGET_DENIED", `path is a symlink; refusing to write through it: ${targetPath}`);
		if (existingLStat.isDirectory()) return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
		if (!overwrite) return err("EXISTS_NO_OVERWRITE", `file already exists and overwrite is false: ${targetPath}`);
		overwritten = true;
	} catch (statErr) {
		if (statErr.code !== "ENOENT") {
			const message = statErr instanceof Error ? statErr.message : String(statErr);
			if (message.toLowerCase().includes("permission")) return err("PERMISSION_DENIED", `permission denied: ${targetPath}`);
			return err("WRITE_ERROR", `unexpected stat error: ${message}`);
		}
	}
	const computedSha256 = sha256Hex(buf);
	if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) return err("INTEGRITY_FAILURE", `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`, targetPath);
	if (preflightOnly) return {
		ok: true,
		path: await canonicalTargetFromExistingAncestor(targetPath),
		size: buf.length,
		sha256: computedSha256,
		overwritten
	};
	const tmpPath = `${targetPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
	try {
		await fs.writeFile(tmpPath, buf);
	} catch (writeErr) {
		const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
		await fs.unlink(tmpPath).catch(() => {});
		if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) return err("PERMISSION_DENIED", `permission denied writing to: ${parentDir}`);
		return err("WRITE_ERROR", `failed to write file: ${message}`);
	}
	try {
		await fs.rename(tmpPath, targetPath);
	} catch (renameErr) {
		const message = renameErr instanceof Error ? renameErr.message : String(renameErr);
		await fs.unlink(tmpPath).catch(() => {});
		if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) return err("PERMISSION_DENIED", `permission denied renaming to: ${targetPath}`);
		return err("WRITE_ERROR", `failed to rename tmp to target: ${message}`);
	}
	const writtenBuf = buf;
	let canonicalPath = targetPath;
	try {
		canonicalPath = await fs.realpath(targetPath);
	} catch {
		canonicalPath = targetPath;
	}
	return {
		ok: true,
		path: canonicalPath,
		size: writtenBuf.length,
		sha256: computedSha256,
		overwritten
	};
}
//#endregion
export { handleFileWrite };
