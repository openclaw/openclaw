import { t as sameFileIdentity$1 } from "./file-identity-BKNyWMFA.js";
import fs from "node:fs";
//#region node_modules/@openclaw/fs-safe/dist/pinned-open.js
function isExpectedPathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function sameFileIdentity(left, right) {
	return sameFileIdentity$1(left, right);
}
function openPinnedFileSync(params) {
	const ioFs = params.ioFs ?? fs;
	const allowedType = params.allowedType ?? "file";
	const openReadFlags = ioFs.constants.O_RDONLY | (typeof ioFs.constants.O_NOFOLLOW === "number" ? ioFs.constants.O_NOFOLLOW : 0);
	let fd = null;
	try {
		if (params.rejectPathSymlink) {
			if (ioFs.lstatSync(params.filePath).isSymbolicLink()) return {
				ok: false,
				reason: "validation"
			};
		}
		const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
		const preOpenStat = ioFs.lstatSync(realPath);
		if (!isAllowedType(preOpenStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && preOpenStat.isFile() && preOpenStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && preOpenStat.isFile() && preOpenStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		fd = ioFs.openSync(realPath, openReadFlags);
		const openedStat = ioFs.fstatSync(fd);
		if (!isAllowedType(openedStat, allowedType)) return {
			ok: false,
			reason: "validation"
		};
		if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) return {
			ok: false,
			reason: "validation"
		};
		if (params.maxBytes !== void 0 && openedStat.isFile() && openedStat.size > params.maxBytes) return {
			ok: false,
			reason: "validation"
		};
		if (!sameFileIdentity(preOpenStat, openedStat)) return {
			ok: false,
			reason: "validation"
		};
		const opened = {
			ok: true,
			path: realPath,
			fd,
			stat: openedStat
		};
		fd = null;
		return opened;
	} catch (error) {
		if (isExpectedPathError(error)) return {
			ok: false,
			reason: "path",
			error
		};
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		if (fd !== null) ioFs.closeSync(fd);
	}
}
function isAllowedType(stat, allowedType) {
	if (allowedType === "directory") return stat.isDirectory();
	return stat.isFile();
}
//#endregion
export { openPinnedFileSync as t };
