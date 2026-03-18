import fs from "node:fs";
//#region src/infra/file-identity.ts
function isZero(value) {
	return value === 0 || value === 0n;
}
function sameFileIdentity$1(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
//#endregion
//#region src/infra/safe-open-sync.ts
function isExpectedPathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function sameFileIdentity(left, right) {
	return sameFileIdentity$1(left, right);
}
function openVerifiedFileSync(params) {
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
export { sameFileIdentity$1 as n, openVerifiedFileSync as t };
