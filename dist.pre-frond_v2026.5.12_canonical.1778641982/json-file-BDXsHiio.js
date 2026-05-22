import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region src/infra/json-file.ts
const JSON_FILE_MODE = 384;
const JSON_DIR_MODE = 448;
function trySetSecureMode(pathname) {
	try {
		fs.chmodSync(pathname, JSON_FILE_MODE);
	} catch {}
}
function trySyncDirectory(pathname) {
	let fd;
	try {
		fd = fs.openSync(path.dirname(pathname), "r");
		fs.fsyncSync(fd);
	} catch {} finally {
		if (fd !== void 0) try {
			fs.closeSync(fd);
		} catch {}
	}
}
function readSymlinkTargetPath(linkPath) {
	const target = fs.readlinkSync(linkPath);
	return path.resolve(path.dirname(linkPath), target);
}
function resolveJsonWriteTarget(pathname) {
	let currentPath = pathname;
	const visited = /* @__PURE__ */ new Set();
	let followsSymlink = false;
	for (;;) {
		let stat;
		try {
			stat = fs.lstatSync(currentPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			return {
				targetPath: currentPath,
				followsSymlink
			};
		}
		if (!stat.isSymbolicLink()) return {
			targetPath: currentPath,
			followsSymlink
		};
		if (visited.has(currentPath)) {
			const err = /* @__PURE__ */ new Error(`Too many symlink levels while resolving ${pathname}`);
			err.code = "ELOOP";
			throw err;
		}
		visited.add(currentPath);
		followsSymlink = true;
		currentPath = readSymlinkTargetPath(currentPath);
	}
}
function renameJsonFileWithFallback(tmpPath, pathname) {
	try {
		fs.renameSync(tmpPath, pathname);
		return;
	} catch (error) {
		const code = error.code;
		if (code === "EPERM" || code === "EEXIST") {
			fs.copyFileSync(tmpPath, pathname);
			fs.rmSync(tmpPath, { force: true });
			return;
		}
		throw error;
	}
}
function writeTempJsonFile(pathname, payload) {
	const fd = fs.openSync(pathname, "w", JSON_FILE_MODE);
	try {
		fs.writeFileSync(fd, payload, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
function loadJsonFile(pathname) {
	try {
		const raw = fs.readFileSync(pathname, "utf8");
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function saveJsonFile(pathname, data) {
	const { targetPath, followsSymlink } = resolveJsonWriteTarget(pathname);
	const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
	const payload = `${JSON.stringify(data, null, 2)}\n`;
	if (!followsSymlink) fs.mkdirSync(path.dirname(targetPath), {
		recursive: true,
		mode: JSON_DIR_MODE
	});
	try {
		writeTempJsonFile(tmpPath, payload);
		trySetSecureMode(tmpPath);
		renameJsonFileWithFallback(tmpPath, targetPath);
		trySetSecureMode(targetPath);
		trySyncDirectory(targetPath);
	} finally {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {}
	}
}
//#endregion
export { saveJsonFile as n, loadJsonFile as t };
