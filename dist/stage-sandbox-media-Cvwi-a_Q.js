import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as assertSandboxPath } from "./sandbox-paths-BTYunIeX.js";
import { s as getMediaDir, t as MEDIA_MAX_BYTES } from "./store-rQFzzX5P.js";
import { i as resolveInboundMediaReference } from "./media-reference-efB9JQqF.js";
import { n as resolveChannelRemoteInboundAttachmentRoots } from "./channel-inbound-roots-U_3CsLmG.js";
import { t as isInboundPathAllowed } from "./inbound-path-policy-DEbcUBWg.js";
import { b as slugifySessionKey } from "./docker-DfzYD6UD.js";
import { a as ensureSandboxWorkspaceForSession } from "./sandbox-DiI74XYF.js";
import { i as normalizeScpRemotePath, r as normalizeScpRemoteHost } from "./scp-host-CIH1Vnml.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
//#region src/auto-reply/reply/stage-sandbox-media.ts
const STAGED_MEDIA_MAX_BYTES = MEDIA_MAX_BYTES;
const EMPTY_STAGE_RESULT = { staged: /* @__PURE__ */ new Map() };
async function stageSandboxMedia(params) {
	const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
	const hasPathsArray = Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0;
	const rawPaths = resolveRawPaths(ctx);
	if (rawPaths.length === 0 || !sessionKey) return EMPTY_STAGE_RESULT;
	const sandbox = await ensureSandboxWorkspaceForSession({
		config: cfg,
		sessionKey,
		workspaceDir
	});
	const remoteMediaCacheDir = ctx.MediaRemoteHost ? path.join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)) : null;
	const effectiveWorkspaceDir = sandbox?.workspaceDir ?? remoteMediaCacheDir;
	if (!effectiveWorkspaceDir) return EMPTY_STAGE_RESULT;
	await fs.mkdir(effectiveWorkspaceDir, { recursive: true });
	const remoteAttachmentRoots = ctx.MediaRemoteHost ? resolveChannelRemoteInboundAttachmentRoots({
		cfg,
		ctx
	}) ?? [] : [];
	const usedNames = /* @__PURE__ */ new Set();
	const staged = /* @__PURE__ */ new Map();
	for (const raw of rawPaths) {
		const source = resolveAbsolutePath(raw);
		if (!source || staged.has(source)) continue;
		if (!await isAllowedSourcePath({
			source,
			mediaRemoteHost: ctx.MediaRemoteHost,
			remoteAttachmentRoots
		})) continue;
		const fileName = allocateStagedFileName(source, usedNames);
		if (!fileName) continue;
		const relativeDest = sandbox ? path.join("media", "inbound", fileName) : fileName;
		const dest = path.join(effectiveWorkspaceDir, relativeDest);
		try {
			if (ctx.MediaRemoteHost) await stageRemoteFileIntoRoot({
				remoteHost: ctx.MediaRemoteHost,
				remotePath: source,
				rootDir: effectiveWorkspaceDir,
				relativeDestPath: relativeDest,
				maxBytes: STAGED_MEDIA_MAX_BYTES
			});
			else await stageLocalFileIntoRoot({
				sourcePath: await fs.realpath(source).catch(() => source),
				rootDir: effectiveWorkspaceDir,
				relativeDestPath: relativeDest,
				maxBytes: STAGED_MEDIA_MAX_BYTES
			});
		} catch (err) {
			if (err instanceof FsSafeError && err.code === "too-large") logVerbose(`Blocking inbound media staging above ${STAGED_MEDIA_MAX_BYTES} bytes: ${source}`);
			else logVerbose(`Failed to stage inbound media path ${source}: ${String(err)}`);
			continue;
		}
		const stagedPath = sandbox ? path.posix.join("media", "inbound", fileName) : dest;
		staged.set(source, stagedPath);
	}
	rewriteStagedMediaPaths({
		ctx,
		sessionCtx,
		rawPaths,
		staged,
		hasPathsArray
	});
	return { staged };
}
async function stageLocalFileIntoRoot(params) {
	await (await root(params.rootDir)).copyIn(params.relativeDestPath, params.sourcePath, { maxBytes: params.maxBytes });
}
async function stageRemoteFileIntoRoot(params) {
	const tmpRoot = resolvePreferredOpenClawTmpDir();
	await fs.mkdir(tmpRoot, { recursive: true });
	const tmpDir = await fs.mkdtemp(path.join(tmpRoot, "stage-sandbox-media-"));
	const tmpPath = path.join(tmpDir, "download");
	try {
		await scpFile(params.remoteHost, params.remotePath, tmpPath);
		await stageLocalFileIntoRoot({
			sourcePath: tmpPath,
			rootDir: params.rootDir,
			relativeDestPath: params.relativeDestPath,
			maxBytes: params.maxBytes
		});
	} finally {
		await fs.rm(tmpDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
function resolveRawPaths(ctx) {
	const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : void 0;
	return pathsFromArray && pathsFromArray.length > 0 ? pathsFromArray : normalizeOptionalString(ctx.MediaPath) ? [normalizeOptionalString(ctx.MediaPath)] : [];
}
function resolveAbsolutePath(value) {
	let resolved = value.trim();
	if (!resolved) return null;
	if (resolved.startsWith("file://")) try {
		resolved = fileURLToPath(resolved);
	} catch {
		return null;
	}
	if (!path.isAbsolute(resolved)) return null;
	return resolved;
}
async function isAllowedSourcePath(params) {
	if (params.mediaRemoteHost) {
		if (!isInboundPathAllowed({
			filePath: params.source,
			roots: params.remoteAttachmentRoots
		})) {
			logVerbose(`Blocking remote media staging from disallowed attachment path: ${params.source}`);
			return false;
		}
		return true;
	}
	if (await resolveInboundMediaReference(params.source).catch(() => null)) return true;
	const mediaDir = getMediaDir();
	const canonicalMediaDir = await fs.realpath(mediaDir).catch(() => mediaDir);
	if (!isInboundPathAllowed({
		filePath: params.source,
		roots: [mediaDir, canonicalMediaDir]
	})) {
		logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
		return false;
	}
	try {
		await assertSandboxPath({
			filePath: await fs.realpath(params.source).catch(() => params.source),
			cwd: canonicalMediaDir,
			root: canonicalMediaDir
		});
		return true;
	} catch {
		logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
		return false;
	}
}
function allocateStagedFileName(source, usedNames) {
	const baseName = path.basename(source);
	if (!baseName) return null;
	const parsed = path.parse(baseName);
	let fileName = baseName;
	let suffix = 1;
	while (usedNames.has(fileName)) {
		fileName = `${parsed.name}-${suffix}${parsed.ext}`;
		suffix += 1;
	}
	usedNames.add(fileName);
	return fileName;
}
function rewriteStagedMediaPaths(params) {
	const rewriteIfStaged = (value) => {
		const raw = normalizeOptionalString(value);
		if (!raw) return value;
		const abs = resolveAbsolutePath(raw);
		if (!abs) return value;
		return params.staged.get(abs) ?? value;
	};
	const nextMediaPaths = params.hasPathsArray ? params.rawPaths.map((p) => rewriteIfStaged(p) ?? p) : void 0;
	if (nextMediaPaths) {
		params.ctx.MediaPaths = nextMediaPaths;
		params.sessionCtx.MediaPaths = nextMediaPaths;
		params.ctx.MediaPath = nextMediaPaths[0];
		params.sessionCtx.MediaPath = nextMediaPaths[0];
	} else {
		const rewritten = rewriteIfStaged(params.ctx.MediaPath);
		if (rewritten && rewritten !== params.ctx.MediaPath) {
			params.ctx.MediaPath = rewritten;
			params.sessionCtx.MediaPath = rewritten;
		}
	}
	if (Array.isArray(params.ctx.MediaUrls) && params.ctx.MediaUrls.length > 0) {
		const nextUrls = params.ctx.MediaUrls.map((u) => rewriteIfStaged(u) ?? u);
		params.ctx.MediaUrls = nextUrls;
		params.sessionCtx.MediaUrls = nextUrls;
	}
	const rewrittenUrl = rewriteIfStaged(params.ctx.MediaUrl);
	if (rewrittenUrl && rewrittenUrl !== params.ctx.MediaUrl) {
		params.ctx.MediaUrl = rewrittenUrl;
		params.sessionCtx.MediaUrl = rewrittenUrl;
	}
}
async function scpFile(remoteHost, remotePath, localPath) {
	const safeRemoteHost = normalizeScpRemoteHost(remoteHost);
	if (!safeRemoteHost) throw new Error("invalid remote host for SCP");
	const safeRemotePath = normalizeScpRemotePath(remotePath);
	if (!safeRemotePath) throw new Error("invalid remote path for SCP");
	return new Promise((resolve, reject) => {
		const child = spawn("scp", [
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"--",
			`${safeRemoteHost}:${safeRemotePath}`,
			localPath
		], { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`scp failed (${code}): ${stderr.trim()}`));
		});
	});
}
//#endregion
export { stageSandboxMedia as t };
