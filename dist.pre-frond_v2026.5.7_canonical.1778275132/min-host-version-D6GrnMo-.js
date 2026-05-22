import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { a as parseSemver, n as isAtLeast } from "./runtime-guard-BSNxAzOt.js";
//#region src/plugins/min-host-version.ts
const MIN_HOST_VERSION_FORMAT = "openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z[-prerelease][+build]\"";
const SEMVER_LABEL_RE = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const MIN_HOST_VERSION_RE = new RegExp(`^>=(${SEMVER_LABEL_RE})$`);
const LEGACY_MIN_HOST_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parseMinHostVersionRequirement(raw, options = {}) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const match = trimmed.match(MIN_HOST_VERSION_RE) ?? (options.allowLegacyBareSemver ? trimmed.match(LEGACY_MIN_HOST_VERSION_RE) : null);
	if (!match) return null;
	const minimumLabel = match.length >= 4 ? `${match[1]}.${match[2]}.${match[3]}` : match[1] ?? "";
	if (!parseSemver(minimumLabel)) return null;
	return {
		raw: trimmed,
		minimumLabel
	};
}
function checkMinHostVersion(params) {
	if (params.minHostVersion === void 0) return {
		ok: true,
		requirement: null
	};
	const requirement = parseMinHostVersionRequirement(params.minHostVersion, { allowLegacyBareSemver: params.allowLegacyBareSemver });
	if (!requirement) return {
		ok: false,
		kind: "invalid",
		error: MIN_HOST_VERSION_FORMAT
	};
	const currentVersion = normalizeOptionalString(params.currentVersion) || "unknown";
	const currentSemver = parseSemver(currentVersion);
	if (!currentSemver) return {
		ok: false,
		kind: "unknown_host_version",
		requirement
	};
	if (!isAtLeast(currentSemver, parseSemver(requirement.minimumLabel))) return {
		ok: false,
		kind: "incompatible",
		requirement,
		currentVersion
	};
	return {
		ok: true,
		requirement
	};
}
//#endregion
export { parseMinHostVersionRequirement as n, checkMinHostVersion as t };
