//#region node_modules/@openclaw/fs-safe/dist/file-identity.js
function isZero(value) {
	return value === 0 || value === 0n;
}
function sameFileIdentity(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
//#endregion
export { sameFileIdentity as t };
