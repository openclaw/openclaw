import { n as comparePrereleaseIdentifiers, r as normalizeLegacyDotBetaVersion } from "./semver-compare-BoMHoO1q.js";
//#region src/config/version.ts
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function parseOpenClawVersion(raw) {
	if (!raw) return null;
	const match = normalizeLegacyDotBetaVersion(raw.trim()).match(VERSION_RE);
	if (!match) return null;
	const [, major, minor, patch, suffix] = match;
	const revision = suffix && /^[0-9]+$/.test(suffix) ? Number.parseInt(suffix, 10) : null;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		revision,
		prerelease: suffix && revision == null ? suffix.split(".").filter(Boolean) : null
	};
}
function normalizeOpenClawVersionBase(raw) {
	const parsed = parseOpenClawVersion(raw);
	if (!parsed) return null;
	return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}
function isSameOpenClawStableFamily(a, b) {
	const parsedA = parseOpenClawVersion(a);
	const parsedB = parseOpenClawVersion(b);
	if (!parsedA || !parsedB) return false;
	if (parsedA.prerelease?.length || parsedB.prerelease?.length) return false;
	return parsedA.major === parsedB.major && parsedA.minor === parsedB.minor && parsedA.patch === parsedB.patch;
}
function compareOpenClawVersions(a, b) {
	const parsedA = parseOpenClawVersion(a);
	const parsedB = parseOpenClawVersion(b);
	if (!parsedA || !parsedB) return null;
	if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
	if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
	if (parsedA.patch !== parsedB.patch) return parsedA.patch < parsedB.patch ? -1 : 1;
	const rankA = releaseRank(parsedA);
	const rankB = releaseRank(parsedB);
	if (rankA !== rankB) return rankA < rankB ? -1 : 1;
	if (parsedA.revision != null && parsedB.revision != null && parsedA.revision !== parsedB.revision) return parsedA.revision < parsedB.revision ? -1 : 1;
	if (parsedA.prerelease || parsedB.prerelease) return comparePrereleaseIdentifiers(parsedA.prerelease, parsedB.prerelease);
	return 0;
}
function shouldWarnOnTouchedVersion(current, touched) {
	const parsedCurrent = parseOpenClawVersion(current);
	const parsedTouched = parseOpenClawVersion(touched);
	if (parsedCurrent && parsedTouched && parsedCurrent.major === parsedTouched.major && parsedCurrent.minor === parsedTouched.minor && parsedCurrent.patch === parsedTouched.patch) {
		if (!parsedTouched.prerelease?.length) return false;
	}
	if (isSameOpenClawStableFamily(current, touched)) return false;
	const cmp = compareOpenClawVersions(current, touched);
	return cmp !== null && cmp < 0;
}
function releaseRank(version) {
	if (version.prerelease?.length) return 0;
	if (version.revision != null) return 2;
	return 1;
}
//#endregion
export { normalizeOpenClawVersionBase as n, shouldWarnOnTouchedVersion as r, compareOpenClawVersions as t };
