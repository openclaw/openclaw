import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
//#region src/infra/npm-registry-spec.ts
const EXACT_SEMVER_VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const OPENCLAW_STABLE_CORRECTION_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-(?<correction>[1-9]\d*)$/;
const OPENCLAW_STABLE_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)$/;
const OPENCLAW_ALPHA_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-alpha\.(?<alpha>[1-9]\d*)$/;
const OPENCLAW_BETA_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-beta\.(?<beta>[1-9]\d*)$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function parseRegistryNpmSpecInternal(rawSpec) {
	const spec = rawSpec.trim();
	if (!spec) return {
		ok: false,
		error: "missing npm spec"
	};
	if (/\s/.test(spec)) return {
		ok: false,
		error: "unsupported npm spec: whitespace is not allowed"
	};
	if (spec.includes("://")) return {
		ok: false,
		error: "unsupported npm spec: URLs are not allowed"
	};
	if (spec.includes("#")) return {
		ok: false,
		error: "unsupported npm spec: git refs are not allowed"
	};
	if (spec.includes(":")) return {
		ok: false,
		error: "unsupported npm spec: protocol specs are not allowed"
	};
	const at = spec.lastIndexOf("@");
	const hasSelector = at > 0;
	const name = hasSelector ? spec.slice(0, at) : spec;
	const selector = hasSelector ? spec.slice(at + 1) : "";
	if (!(name.startsWith("@") ? /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/.test(name) : /^[a-z0-9][a-z0-9-._~]*$/.test(name))) return {
		ok: false,
		error: "unsupported npm spec: expected <name> or <name>@<version> from the npm registry"
	};
	if (!hasSelector) return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selectorKind: "none",
			selectorIsPrerelease: false
		}
	};
	if (!selector) return {
		ok: false,
		error: "unsupported npm spec: missing version/tag after @"
	};
	if (/[\\/]/.test(selector)) return {
		ok: false,
		error: "unsupported npm spec: invalid version/tag"
	};
	const exactVersionMatch = EXACT_SEMVER_VERSION_RE.exec(selector);
	if (exactVersionMatch) return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "exact-version",
			selectorIsPrerelease: Boolean(exactVersionMatch[4]) && !isOpenClawStableCorrectionVersion(selector)
		}
	};
	if (!DIST_TAG_RE.test(selector)) return {
		ok: false,
		error: "unsupported npm spec: use an exact version or dist-tag (ranges are not allowed)"
	};
	return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "tag",
			selectorIsPrerelease: false
		}
	};
}
function parseRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? parsed.parsed : null;
}
function isOpenClawOrgNpmSpec(rawSpec) {
	return (rawSpec ? parseRegistryNpmSpec(rawSpec) : null)?.name.startsWith("@openclaw/") === true;
}
function validateRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? null : parsed.error;
}
function isExactSemverVersion(value) {
	return EXACT_SEMVER_VERSION_RE.test(value.trim());
}
function parseOpenClawReleaseVersion(value) {
	const trimmed = value.trim();
	const candidate = [
		{
			match: OPENCLAW_STABLE_VERSION_RE.exec(trimmed),
			channel: "stable"
		},
		{
			match: OPENCLAW_STABLE_CORRECTION_VERSION_RE.exec(trimmed),
			channel: "stable"
		},
		{
			match: OPENCLAW_ALPHA_VERSION_RE.exec(trimmed),
			channel: "alpha"
		},
		{
			match: OPENCLAW_BETA_VERSION_RE.exec(trimmed),
			channel: "beta"
		}
	].find((entry) => entry.match?.groups);
	if (!candidate?.match?.groups) return null;
	const year = Number.parseInt(candidate.match.groups.year ?? "", 10);
	const month = Number.parseInt(candidate.match.groups.month ?? "", 10);
	const day = Number.parseInt(candidate.match.groups.day ?? "", 10);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	const correctionNumber = candidate.channel === "stable" && candidate.match.groups.correction ? Number.parseInt(candidate.match.groups.correction, 10) : void 0;
	const alphaNumber = candidate.channel === "alpha" ? Number.parseInt(candidate.match.groups.alpha ?? "", 10) : void 0;
	const betaNumber = candidate.channel === "beta" ? Number.parseInt(candidate.match.groups.beta ?? "", 10) : void 0;
	return {
		channel: candidate.channel,
		dateTime: date.getTime(),
		correctionNumber,
		alphaNumber,
		betaNumber
	};
}
function isOpenClawStableCorrectionVersion(value) {
	const parsed = parseOpenClawReleaseVersion(value);
	return parsed?.channel === "stable" && parsed.correctionNumber !== void 0;
}
function compareOpenClawReleaseVersions(left, right) {
	const parsedLeft = parseOpenClawReleaseVersion(left);
	const parsedRight = parseOpenClawReleaseVersion(right);
	if (!parsedLeft || !parsedRight) return null;
	if (parsedLeft.dateTime !== parsedRight.dateTime) return parsedLeft.dateTime < parsedRight.dateTime ? -1 : 1;
	if (parsedLeft.channel !== parsedRight.channel) {
		const rank = {
			alpha: 0,
			beta: 1,
			stable: 2
		};
		return rank[parsedLeft.channel] < rank[parsedRight.channel] ? -1 : 1;
	}
	if (parsedLeft.channel === "alpha") return Math.sign((parsedLeft.alphaNumber ?? 0) - (parsedRight.alphaNumber ?? 0));
	if (parsedLeft.channel === "beta") return Math.sign((parsedLeft.betaNumber ?? 0) - (parsedRight.betaNumber ?? 0));
	return Math.sign((parsedLeft.correctionNumber ?? 0) - (parsedRight.correctionNumber ?? 0));
}
function isPrereleaseSemverVersion(value) {
	const trimmed = value.trim();
	const match = EXACT_SEMVER_VERSION_RE.exec(trimmed);
	return Boolean(match?.[4]) && !isOpenClawStableCorrectionVersion(trimmed);
}
function isPrereleaseResolutionAllowed(params) {
	if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) return true;
	if (params.spec.selectorKind === "none") return false;
	if (params.spec.selectorKind === "exact-version") return params.spec.selectorIsPrerelease;
	return normalizeLowercaseStringOrEmpty(params.spec.selector) !== "latest";
}
function formatPrereleaseResolutionError(params) {
	const selectorHint = params.spec.selectorKind === "none" || normalizeLowercaseStringOrEmpty(params.spec.selector) === "latest" ? `Use "${params.spec.name}@beta" (or another prerelease tag) or an exact prerelease version to opt in explicitly.` : `Use an explicit prerelease tag or exact prerelease version if you want prerelease installs.`;
	return `Resolved ${params.spec.raw} to prerelease version ${params.resolvedVersion}, but prereleases are only installed when explicitly requested. ${selectorHint}`;
}
//#endregion
export { isPrereleaseResolutionAllowed as a, validateRegistryNpmSpec as c, isOpenClawOrgNpmSpec as i, formatPrereleaseResolutionError as n, isPrereleaseSemverVersion as o, isExactSemverVersion as r, parseRegistryNpmSpec as s, compareOpenClawReleaseVersions as t };
