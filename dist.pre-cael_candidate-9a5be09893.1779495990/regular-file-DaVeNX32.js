import { o as isPathRelativeEscape, r as isNotFoundPathError } from "./path-BlG8lhgR.js";
import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region node_modules/@openclaw/fs-safe/dist/symlink-parents.js
function resolvePathWalk(params) {
	const root = path.resolve(params.rootDir);
	const target = path.resolve(params.targetPath);
	const relative = path.relative(root, target);
	if (isPathRelativeEscape(relative)) {
		if (params.allowOutsideRoot) return null;
		throw new Error(`${params.messagePrefix ?? "Path"} must stay under ${root}.`);
	}
	return {
		root,
		segments: relative && relative !== "." ? relative.split(path.sep).filter(Boolean) : []
	};
}
function formatUnsafePath(params, current) {
	return `${params.messagePrefix ?? "Path"} must not traverse symlinked directory: ${current}`;
}
async function assertNoSymlinkParents(params) {
	const walk = resolvePathWalk(params);
	if (!walk) return;
	let current = walk.root;
	for (const segment of walk.segments) {
		current = path.join(current, segment);
		try {
			const stat = await fs$1.lstat(current);
			if (stat.isSymbolicLink()) {
				if (params.allowRootChildSymlink && path.dirname(current) === walk.root) continue;
				throw new Error(formatUnsafePath(params, current));
			}
			if (params.requireDirectories && !stat.isDirectory()) throw new Error(`${params.messagePrefix ?? "Path"} must traverse directories: ${current}`);
		} catch (err) {
			if (isNotFoundPathError(err) && params.allowMissing !== false) return;
			throw err;
		}
	}
}
function assertNoSymlinkParentsSync(params) {
	const walk = resolvePathWalk(params);
	if (!walk) return;
	let current = walk.root;
	for (const segment of walk.segments) {
		current = path.join(current, segment);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) {
				if (params.allowRootChildSymlink && path.dirname(current) === walk.root) continue;
				throw new Error(formatUnsafePath(params, current));
			}
			if (params.requireDirectories && !stat.isDirectory()) throw new Error(`${params.messagePrefix ?? "Path"} must traverse directories: ${current}`);
		} catch (err) {
			if (err.code === "ENOENT" && params.allowMissing !== false) return;
			throw err;
		}
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/regular-file.js
function resolveRegularFileAppendFlags(constants = fs.constants) {
	const noFollow = constants.O_NOFOLLOW;
	return constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (typeof noFollow === "number" ? noFollow : 0);
}
function resolveRegularFileReadFlags() {
	return fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32" ? fs.constants.O_NOFOLLOW : 0);
}
async function readFileHandleBounded(params) {
	if (params.maxBytes === void 0) return await params.handle.readFile();
	const chunks = [];
	const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, params.maxBytes + 1)));
	let total = 0;
	while (true) {
		const { bytesRead } = await params.handle.read(scratch, 0, scratch.length, null);
		if (bytesRead === 0) return Buffer.concat(chunks, total);
		total += bytesRead;
		if (total > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
		chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
	}
}
function readFileDescriptorBounded(params) {
	if (params.maxBytes === void 0) return fs.readFileSync(params.fd);
	const chunks = [];
	const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, params.maxBytes + 1)));
	let total = 0;
	while (true) {
		const bytesRead = fs.readSync(params.fd, scratch, 0, scratch.length, null);
		if (bytesRead === 0) return Buffer.concat(chunks, total);
		total += bytesRead;
		if (total > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
		chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
	}
}
async function statRegularFile(filePath) {
	let stat;
	try {
		stat = await fs$1.lstat(filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return { missing: true };
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("path must be a regular file");
	return {
		missing: false,
		stat
	};
}
function statRegularFileSync(filePath) {
	let stat;
	try {
		stat = fs.lstatSync(filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return { missing: true };
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("path must be a regular file");
	return {
		missing: false,
		stat
	};
}
async function readRegularFile(params) {
	const result = await statRegularFile(params.filePath);
	if (result.missing) throw Object.assign(/* @__PURE__ */ new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
	if (params.maxBytes !== void 0 && result.stat.size > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
	const handle = await fs$1.open(params.filePath, resolveRegularFileReadFlags());
	try {
		const stat = await handle.stat();
		verifyStableReadTarget({
			filePath: params.filePath,
			pathStat: await fs$1.lstat(params.filePath),
			postOpenStat: stat,
			preOpenStat: result.stat
		});
		if (params.maxBytes !== void 0 && stat.size > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
		return {
			buffer: await readFileHandleBounded({
				handle,
				filePath: params.filePath,
				maxBytes: params.maxBytes
			}),
			stat
		};
	} finally {
		await handle.close();
	}
}
function verifyStableReadTarget(params) {
	if (!params.postOpenStat.isFile() || params.pathStat.isSymbolicLink() || !params.pathStat.isFile()) throw new Error(`File is not a regular file: ${params.filePath}`);
	if (!sameFileIdentity(params.preOpenStat, params.postOpenStat) || !sameFileIdentity(params.pathStat, params.postOpenStat)) throw new Error(`File changed during read: ${params.filePath}`);
}
function readOpenedRegularFileSync(params) {
	const stat = fs.fstatSync(params.fd);
	verifyStableReadTarget({
		filePath: params.filePath,
		pathStat: fs.lstatSync(params.filePath),
		postOpenStat: stat,
		preOpenStat: params.preOpenStat
	});
	if (params.maxBytes !== void 0 && stat.size > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
	return {
		buffer: readFileDescriptorBounded({
			fd: params.fd,
			filePath: params.filePath,
			maxBytes: params.maxBytes
		}),
		stat
	};
}
function readRegularFileSync(params) {
	const result = statRegularFileSync(params.filePath);
	if (result.missing) throw Object.assign(/* @__PURE__ */ new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
	if (params.maxBytes !== void 0 && result.stat.size > params.maxBytes) throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
	const fd = fs.openSync(params.filePath, resolveRegularFileReadFlags());
	try {
		return readOpenedRegularFileSync({
			fd,
			filePath: params.filePath,
			preOpenStat: result.stat,
			maxBytes: params.maxBytes
		});
	} finally {
		fs.closeSync(fd);
	}
}
function verifyStableAppendTarget(params) {
	if (!params.postOpenStat.isFile()) throw new Error(`Refusing to append to non-file: ${params.filePath}`);
	if (params.postOpenStat.nlink > 1) throw new Error(`Refusing to append to hardlinked file: ${params.filePath}`);
	const pre = params.preOpenStat;
	if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) throw new Error(`Refusing to append after file changed: ${params.filePath}`);
}
async function appendRegularFile(options) {
	if (options.rejectSymlinkParents === true) {
		const resolvedDir = path.resolve(path.dirname(options.filePath));
		await assertNoSymlinkParents({
			rootDir: path.parse(resolvedDir).root,
			targetPath: resolvedDir,
			allowMissing: false,
			allowRootChildSymlink: true,
			requireDirectories: true,
			messagePrefix: "Refusing to append under"
		});
	}
	let preOpenStat;
	try {
		const stat = await fs$1.lstat(options.filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to append through symlink: ${options.filePath}`);
		if (!stat.isFile()) throw new Error(`Refusing to append to non-file: ${options.filePath}`);
		preOpenStat = stat;
	} catch (err) {
		if (!isNotFoundPathError(err)) throw err;
	}
	const contentBytes = Buffer.isBuffer(options.content) ? options.content.byteLength : Buffer.byteLength(options.content, options.encoding ?? "utf8");
	if (options.maxFileBytes !== void 0 && (preOpenStat?.size ?? 0) + contentBytes > options.maxFileBytes) return;
	const handle = await fs$1.open(options.filePath, resolveRegularFileAppendFlags(), options.mode ?? 384);
	try {
		const stat = await handle.stat();
		verifyStableAppendTarget({
			preOpenStat,
			postOpenStat: stat,
			filePath: options.filePath
		});
		if (options.maxFileBytes !== void 0 && stat.size + contentBytes > options.maxFileBytes) return;
		await handle.chmod(options.mode ?? 384);
		await handle.appendFile(options.content, options.encoding ?? "utf8");
	} finally {
		await handle.close();
	}
}
function appendRegularFileSync(options) {
	if (options.rejectSymlinkParents === true) {
		const resolvedDir = path.resolve(path.dirname(options.filePath));
		assertNoSymlinkParentsSync({
			rootDir: path.parse(resolvedDir).root,
			targetPath: resolvedDir,
			allowMissing: false,
			allowRootChildSymlink: true,
			requireDirectories: true,
			messagePrefix: "Refusing to append under"
		});
	}
	let preOpenStat;
	try {
		const stat = fs.lstatSync(options.filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to append through symlink: ${options.filePath}`);
		if (!stat.isFile()) throw new Error(`Refusing to append to non-file: ${options.filePath}`);
		preOpenStat = stat;
	} catch (err) {
		if (!isNotFoundPathError(err)) throw err;
	}
	const contentBuffer = typeof options.content === "string" ? Buffer.from(options.content, options.encoding ?? "utf8") : Buffer.from(options.content);
	if (options.maxFileBytes !== void 0 && (preOpenStat?.size ?? 0) + contentBuffer.byteLength > options.maxFileBytes) return;
	const fd = fs.openSync(options.filePath, resolveRegularFileAppendFlags(), options.mode ?? 384);
	try {
		const stat = fs.fstatSync(fd);
		verifyStableAppendTarget({
			preOpenStat,
			postOpenStat: stat,
			filePath: options.filePath
		});
		if (options.maxFileBytes !== void 0 && stat.size + contentBuffer.byteLength > options.maxFileBytes) return;
		fs.fchmodSync(fd, options.mode ?? 384);
		fs.writeSync(fd, contentBuffer, 0, contentBuffer.byteLength);
	} finally {
		fs.closeSync(fd);
	}
}
//#endregion
export { resolveRegularFileAppendFlags as a, assertNoSymlinkParents as c, readRegularFileSync as i, assertNoSymlinkParentsSync as l, appendRegularFileSync as n, statRegularFile as o, readRegularFile as r, statRegularFileSync as s, appendRegularFile as t };
