import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C53Glfmy.js";
import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import crypto from "node:crypto";
//#region src/infra/temp-download.ts
const logger = createSubsystemLogger("infra:temp-download");
function sanitizePrefix(prefix) {
	return prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tmp";
}
function sanitizeExtension(extension) {
	if (!extension) return "";
	const token = ((extension.startsWith(".") ? extension : `.${extension}`).match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "").replace(/^[._-]+/, "");
	return token ? `.${token}` : "";
}
function sanitizeTempFileName(fileName) {
	return path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "download.bin";
}
function resolveTempRoot(tmpDir) {
	return tmpDir ?? resolvePreferredOpenClawTmpDir();
}
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
async function cleanupTempDir(dir) {
	try {
		await rm(dir, {
			recursive: true,
			force: true
		});
	} catch (err) {
		if (!isNodeErrorWithCode(err, "ENOENT")) logger.warn(`temp-path cleanup failed for ${dir}: ${String(err)}`, {
			dir,
			error: err
		});
	}
}
function buildRandomTempFilePath(params) {
	const prefix = sanitizePrefix(params.prefix);
	const extension = sanitizeExtension(params.extension);
	const nowCandidate = params.now;
	const now = typeof nowCandidate === "number" && Number.isFinite(nowCandidate) ? Math.trunc(nowCandidate) : Date.now();
	const uuid = params.uuid?.trim() || crypto.randomUUID();
	return path.join(resolveTempRoot(params.tmpDir), `${prefix}-${now}-${uuid}${extension}`);
}
async function createTempDownloadTarget(params) {
	const tempRoot = resolveTempRoot(params.tmpDir);
	const prefix = `${sanitizePrefix(params.prefix)}-`;
	const dir = await mkdtemp(path.join(tempRoot, prefix));
	return {
		dir,
		path: path.join(dir, sanitizeTempFileName(params.fileName ?? "download.bin")),
		cleanup: async () => {
			await cleanupTempDir(dir);
		}
	};
}
async function withTempDownloadPath(params, fn) {
	const target = await createTempDownloadTarget(params);
	try {
		return await fn(target.path);
	} finally {
		await target.cleanup();
	}
}
//#endregion
export { withTempDownloadPath as i, createTempDownloadTarget as n, sanitizeTempFileName as r, buildRandomTempFilePath as t };
