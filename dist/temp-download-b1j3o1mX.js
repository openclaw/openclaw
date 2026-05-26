import "./fs-safe-defaults-B7hUN42l.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as tempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import path from "node:path";
import crypto from "node:crypto";
//#region src/infra/temp-download.ts
const logger = createSubsystemLogger("infra:temp-download");
function resolveTempRoot(tmpDir) {
	return tmpDir ?? resolvePreferredOpenClawTmpDir();
}
function sanitizeTempPrefix(prefix) {
	return prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tmp";
}
function sanitizeTempExtension(extension) {
	if (!extension) return "";
	const token = ((extension.startsWith(".") ? extension : `.${extension}`).match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "").replace(/^[._-]+/, "");
	return token ? `.${token}` : "";
}
function sanitizeTempFileName(fileName) {
	return path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "download.bin";
}
function buildRandomTempFilePath(params) {
	const nowCandidate = params.now;
	const now = typeof nowCandidate === "number" && Number.isFinite(nowCandidate) ? Math.trunc(nowCandidate) : Date.now();
	const uuid = params.uuid?.trim() || crypto.randomUUID();
	return path.join(resolveTempRoot(params.tmpDir), `${sanitizeTempPrefix(params.prefix)}-${now}-${uuid}${sanitizeTempExtension(params.extension)}`);
}
function buildTempDownloadTarget(workspace, fileName) {
	const file = (nextName) => workspace.path(sanitizeTempFileName(nextName ?? fileName ?? "download.bin"));
	return {
		dir: workspace.dir,
		path: file(),
		file,
		cleanup: async () => {
			await workspace.cleanup();
		},
		[Symbol.asyncDispose]: workspace[Symbol.asyncDispose].bind(workspace)
	};
}
async function createTempDownloadTarget(params) {
	const workspace = await tempWorkspace({
		rootDir: resolveTempRoot(params.tmpDir),
		prefix: sanitizeTempPrefix(params.prefix)
	});
	const target = buildTempDownloadTarget(workspace, params.fileName);
	const cleanup = async () => {
		try {
			await workspace.cleanup();
		} catch (err) {
			logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
		}
	};
	return {
		...target,
		cleanup,
		[Symbol.asyncDispose]: cleanup
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
