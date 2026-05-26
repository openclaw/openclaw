import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as parseSemver, n as isAtLeast } from "./runtime-guard-DLdnBLFm.js";
import { i as parseComparableSemver, t as compareComparableSemver } from "./semver-compare-BoMHoO1q.js";
import { n as readResponseWithLimit } from "./read-response-with-limit-S6PVjcFB.js";
import { n as createTempDownloadTarget } from "./temp-download-b1j3o1mX.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
//#region src/infra/clawhub.ts
const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_FETCH_TIMEOUT_MS = 3e4;
var ClawHubRequestError = class extends Error {
	constructor(params) {
		super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
		this.name = "ClawHubRequestError";
		this.status = params.status;
		this.requestPath = params.path;
		this.responseBody = params.body;
	}
};
function normalizeBaseUrl(baseUrl) {
	const envValue = normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_URL) || normalizeOptionalString(process.env.CLAWHUB_URL) || DEFAULT_CLAWHUB_URL;
	return (normalizeOptionalString(baseUrl) || envValue).replace(/\/+$/, "") || DEFAULT_CLAWHUB_URL;
}
function extractTokenFromClawHubConfig(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	return normalizeOptionalString(record.accessToken) ?? normalizeOptionalString(record.authToken) ?? normalizeOptionalString(record.apiToken) ?? normalizeOptionalString(record.token) ?? extractTokenFromClawHubConfig(record.auth) ?? extractTokenFromClawHubConfig(record.session) ?? extractTokenFromClawHubConfig(record.credentials) ?? extractTokenFromClawHubConfig(record.user);
}
function resolveClawHubConfigPaths() {
	const explicit = normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_CONFIG_PATH) || normalizeOptionalString(process.env.CLAWHUB_CONFIG_PATH) || normalizeOptionalString(process.env.CLAWDHUB_CONFIG_PATH);
	if (explicit) return [explicit];
	const xdgConfigHome = normalizeOptionalString(process.env.XDG_CONFIG_HOME);
	const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
	const xdgPath = path.join(configHome, "clawhub", "config.json");
	if (process.platform === "darwin") return [path.join(os.homedir(), "Library", "Application Support", "clawhub", "config.json"), xdgPath];
	return [xdgPath];
}
async function resolveClawHubAuthToken() {
	const envToken = normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_TOKEN) || normalizeOptionalString(process.env.CLAWHUB_TOKEN) || normalizeOptionalString(process.env.CLAWHUB_AUTH_TOKEN);
	if (envToken) return envToken;
	for (const configPath of resolveClawHubConfigPaths()) try {
		const raw = await fs.readFile(configPath, "utf8");
		const token = extractTokenFromClawHubConfig(JSON.parse(raw));
		if (token) return token;
	} catch {}
}
function normalizePartialComparableVersion(version) {
	const trimmed = version.trim();
	return /^[vV]?[0-9]+\.[0-9]+$/.test(trimmed) ? {
		version: `${trimmed}.0`,
		isPartial: true
	} : {
		version: trimmed,
		isPartial: false
	};
}
function compareSemver(left, right) {
	return compareComparableSemver(parseComparableSemver(normalizePartialComparableVersion(left).version), parseComparableSemver(normalizePartialComparableVersion(right).version));
}
function upperBoundForCaret(version) {
	const parsed = parseComparableSemver(normalizePartialComparableVersion(version).version);
	if (!parsed) return null;
	if (parsed.major > 0) return `${parsed.major + 1}.0.0`;
	if (parsed.minor > 0) return `0.${parsed.minor + 1}.0`;
	return `0.0.${parsed.patch + 1}`;
}
function matchWildcardComparator(token) {
	const match = /^(>=|<=|>|<|=|\^|~)?\s*([*xX])$/.exec(token);
	if (!match) return null;
	const operator = match[1];
	return operator === ">" || operator === "<" ? "none" : "any";
}
function satisfiesComparator(version, token) {
	const trimmed = token.trim();
	if (!trimmed) return true;
	const wildcard = matchWildcardComparator(trimmed);
	if (wildcard) return wildcard === "any" && parseComparableSemver(version) != null;
	if (trimmed.startsWith("^")) {
		const base = trimmed.slice(1).trim();
		const upperBound = upperBoundForCaret(base);
		const lowerCmp = compareSemver(version, base);
		const upperCmp = upperBound ? compareSemver(version, upperBound) : null;
		return lowerCmp != null && upperCmp != null && lowerCmp >= 0 && upperCmp < 0;
	}
	const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
	if (!match) return false;
	const operator = match[1];
	const target = match[2]?.trim();
	if (!target) return false;
	const normalizedTarget = normalizePartialComparableVersion(target);
	const cmp = compareSemver(version, normalizedTarget.version);
	if (cmp == null) return false;
	switch (operator) {
		case ">=": return cmp >= 0;
		case "<=": return cmp <= 0;
		case ">": return cmp > 0;
		case "<": return cmp < 0;
		default: return normalizedTarget.isPartial && !operator ? cmp >= 0 : cmp === 0;
	}
}
function satisfiesSemverRange(version, range) {
	const tokens = range.trim().split(/\s+/).map((token) => token.trim()).filter(Boolean);
	if (tokens.length === 0) return false;
	return tokens.every((token) => satisfiesComparator(version, token));
}
const OPENCLAW_CALVER_STABLE_CORRECTION_PATTERN = /^[vV]?(\d{4}\.\d{1,2}\.\d{1,2})-\d+$/;
function normalizeCalVerCorrectionForPluginApi(pluginApiVersion) {
	return OPENCLAW_CALVER_STABLE_CORRECTION_PATTERN.exec(pluginApiVersion.trim())?.[1] ?? pluginApiVersion;
}
function buildUrl(params) {
	const url = new URL(`${normalizeBaseUrl(params.baseUrl)}/`);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${params.path.startsWith("/") ? params.path : `/${params.path}`}`;
	for (const [key, value] of Object.entries(params.search ?? {})) {
		if (!value) continue;
		url.searchParams.set(key, value);
	}
	return url;
}
async function clawhubRequest(params) {
	const url = buildUrl(params);
	const token = normalizeOptionalString(params.token) || await resolveClawHubAuthToken();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`)), params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
	try {
		return {
			response: await (params.fetchImpl ?? fetch)(url, {
				headers: token ? { Authorization: `Bearer ${token}` } : void 0,
				signal: controller.signal
			}),
			url,
			hasToken: Boolean(token)
		};
	} finally {
		clearTimeout(timeout);
	}
}
async function readErrorBody(response) {
	try {
		return (await response.text()).trim() || response.statusText || `HTTP ${response.status}`;
	} catch {
		return response.statusText || `HTTP ${response.status}`;
	}
}
async function buildClawHubError(response, url, hasToken) {
	let body = await readErrorBody(response);
	if (response.status === 429) {
		const suffix = formatRateLimitSuffix(response.headers, hasToken);
		if (suffix) body = `${body} ${suffix}`;
	}
	return new ClawHubRequestError({
		path: url.pathname,
		status: response.status,
		body
	});
}
function formatRateLimitSuffix(headers, hasToken) {
	const reset = normalizeHeaderValue(headers.get("RateLimit-Reset")) ?? normalizeHeaderValue(headers.get("Retry-After"));
	const segments = [];
	if (reset && Number.isFinite(Number(reset))) segments.push(`(resets in ${reset}s)`);
	if (!hasToken) segments.push("Sign in for higher rate limits.");
	return segments.join(" ");
}
async function fetchJson(params) {
	const { response, url, hasToken } = await clawhubRequest(params);
	if (!response.ok) throw await buildClawHubError(response, url, hasToken);
	try {
		return await response.json();
	} catch (cause) {
		throw new Error(`ClawHub ${url.pathname} returned malformed JSON`, { cause });
	}
}
async function readClawHubResponseBytes(params) {
	const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	return await readResponseWithLimit(params.response, Number.MAX_SAFE_INTEGER, {
		chunkTimeoutMs: timeoutMs,
		onIdleTimeout: ({ chunkTimeoutMs }) => /* @__PURE__ */ new Error(`ClawHub ${params.resourceLabel} body stalled after ${chunkTimeoutMs}ms`)
	});
}
function resolveClawHubBaseUrl(baseUrl) {
	return normalizeBaseUrl(baseUrl);
}
function formatSha256Integrity(bytes) {
	return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}
function formatSha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
function formatSha512Integrity(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
function formatSha1Hex(bytes) {
	return createHash("sha1").update(bytes).digest("hex");
}
function normalizeHeaderValue(value) {
	const normalized = normalizeOptionalString(value);
	return normalized && normalized.length > 0 ? normalized : void 0;
}
function safePackageTarballName(name, version) {
	return `${name.replace(/^@/, "").replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-") || "package"}-${version}.tgz`;
}
function normalizeClawHubSha256Integrity(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const prefixedBase64 = /^sha256-([A-Za-z0-9+/]+={0,1})$/.exec(trimmed);
	if (prefixedBase64?.[1]) {
		try {
			const decoded = Buffer.from(prefixedBase64[1], "base64");
			if (decoded.length === 32) return `sha256-${decoded.toString("base64")}`;
		} catch {
			return null;
		}
		return null;
	}
	const prefixedHex = /^sha256:([A-Fa-f0-9]{64})$/.exec(trimmed);
	if (prefixedHex?.[1]) return `sha256-${Buffer.from(prefixedHex[1], "hex").toString("base64")}`;
	if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return `sha256-${Buffer.from(trimmed, "hex").toString("base64")}`;
	return null;
}
function normalizeClawHubSha256Hex(value) {
	const trimmed = value.trim();
	if (!/^[A-Fa-f0-9]{64}$/.test(trimmed)) return null;
	return normalizeLowercaseStringOrEmpty(trimmed);
}
async function fetchClawHubPackageDetail(params) {
	return await fetchJson({
		baseUrl: params.baseUrl,
		path: `/api/v1/packages/${encodeURIComponent(params.name)}`,
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl
	});
}
async function fetchClawHubPackageVersion(params) {
	return await fetchJson({
		baseUrl: params.baseUrl,
		path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(params.version)}`,
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl
	});
}
async function fetchClawHubPackageArtifact(params) {
	return await fetchJson({
		baseUrl: params.baseUrl,
		path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(params.version)}/artifact`,
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl
	});
}
async function searchClawHubPackages(params) {
	return (await fetchJson({
		baseUrl: params.baseUrl,
		path: "/api/v1/packages/search",
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		search: {
			q: params.query.trim(),
			family: params.family,
			limit: params.limit ? String(params.limit) : void 0
		}
	})).results ?? [];
}
async function searchClawHubSkills(params) {
	return (await fetchJson({
		baseUrl: params.baseUrl,
		path: "/api/v1/search",
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		search: {
			q: params.query.trim(),
			limit: params.limit ? String(params.limit) : void 0
		}
	})).results ?? [];
}
async function fetchClawHubSkillDetail(params) {
	return await fetchJson({
		baseUrl: params.baseUrl,
		path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl
	});
}
async function downloadClawHubPackageArchive(params) {
	if (params.artifact === "clawpack") {
		if (!params.version) throw new Error("ClawPack package downloads require an explicit version.");
		const { response, url, hasToken } = await clawhubRequest({
			baseUrl: params.baseUrl,
			path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(params.version)}/artifact/download`,
			token: params.token,
			timeoutMs: params.timeoutMs,
			fetchImpl: params.fetchImpl
		});
		if (!response.ok) throw await buildClawHubError(response, url, hasToken);
		const bytes = await readClawHubResponseBytes({
			response,
			timeoutMs: params.timeoutMs,
			resourceLabel: `ClawPack download for ${params.name}@${params.version}`
		});
		const sha256Hex = formatSha256Hex(bytes);
		const npmIntegrity = formatSha512Integrity(bytes);
		const npmShasum = formatSha1Hex(bytes);
		const headerSha256 = normalizeClawHubSha256Hex(response.headers.get("X-ClawHub-Artifact-Sha256") ?? response.headers.get("X-ClawHub-ClawPack-Sha256") ?? "");
		if (!headerSha256) throw new Error(`ClawHub ClawPack download for "${params.name}@${params.version}" is missing X-ClawHub-Artifact-Sha256.`);
		if (headerSha256 !== sha256Hex) throw new Error(`ClawHub ClawPack download for "${params.name}@${params.version}" declared sha256 ${headerSha256}, got ${sha256Hex}.`);
		const headerNpmIntegrity = normalizeHeaderValue(response.headers.get("X-ClawHub-Npm-Integrity"));
		if (headerNpmIntegrity && headerNpmIntegrity !== npmIntegrity) throw new Error(`ClawHub ClawPack download for "${params.name}@${params.version}" declared npm integrity ${headerNpmIntegrity}, got ${npmIntegrity}.`);
		const headerNpmShasum = normalizeHeaderValue(response.headers.get("X-ClawHub-Npm-Shasum"));
		if (headerNpmShasum && headerNpmShasum !== npmShasum) throw new Error(`ClawHub ClawPack download for "${params.name}@${params.version}" declared npm shasum ${headerNpmShasum}, got ${npmShasum}.`);
		const npmTarballName = normalizeHeaderValue(response.headers.get("X-ClawHub-Npm-Tarball-Name")) ?? safePackageTarballName(params.name, params.version);
		const rawSpecVersion = response.headers.get("X-ClawHub-ClawPack-Spec-Version");
		const specVersion = rawSpecVersion ? Number.parseInt(rawSpecVersion, 10) : void 0;
		const target = await createTempDownloadTarget({
			prefix: "openclaw-clawhub-clawpack",
			fileName: npmTarballName,
			tmpDir: os.tmpdir()
		});
		await fs.writeFile(target.path, bytes);
		return {
			archivePath: target.path,
			integrity: normalizeClawHubSha256Integrity(sha256Hex) ?? formatSha256Integrity(bytes),
			sha256Hex,
			artifact: "clawpack",
			clawpackHeaderSha256: headerSha256,
			...typeof specVersion === "number" && Number.isSafeInteger(specVersion) && specVersion >= 0 ? { clawpackHeaderSpecVersion: specVersion } : {},
			npmIntegrity,
			npmShasum,
			npmTarballName,
			cleanup: target.cleanup
		};
	}
	const search = params.version ? { version: params.version } : params.tag ? { tag: params.tag } : void 0;
	const { response, url, hasToken } = await clawhubRequest({
		baseUrl: params.baseUrl,
		path: `/api/v1/packages/${encodeURIComponent(params.name)}/download`,
		search,
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl
	});
	if (!response.ok) throw await buildClawHubError(response, url, hasToken);
	const bytes = await readClawHubResponseBytes({
		response,
		timeoutMs: params.timeoutMs,
		resourceLabel: `package archive download for ${params.name}`
	});
	const sha256Hex = formatSha256Hex(bytes);
	const target = await createTempDownloadTarget({
		prefix: "openclaw-clawhub-package",
		fileName: `${params.name}.zip`,
		tmpDir: os.tmpdir()
	});
	await fs.writeFile(target.path, bytes);
	return {
		archivePath: target.path,
		integrity: formatSha256Integrity(bytes),
		sha256Hex,
		artifact: "archive",
		cleanup: target.cleanup
	};
}
async function downloadClawHubSkillArchive(params) {
	const { response, url, hasToken } = await clawhubRequest({
		baseUrl: params.baseUrl,
		path: "/api/v1/download",
		token: params.token,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		search: {
			slug: params.slug,
			version: params.version,
			tag: params.version ? void 0 : params.tag
		}
	});
	if (!response.ok) throw await buildClawHubError(response, url, hasToken);
	const bytes = await readClawHubResponseBytes({
		response,
		timeoutMs: params.timeoutMs,
		resourceLabel: `skill archive download for ${params.slug}`
	});
	const sha256Hex = formatSha256Hex(bytes);
	const target = await createTempDownloadTarget({
		prefix: "openclaw-clawhub-skill",
		fileName: `${params.slug}.zip`,
		tmpDir: os.tmpdir()
	});
	await fs.writeFile(target.path, bytes);
	return {
		archivePath: target.path,
		integrity: formatSha256Integrity(bytes),
		sha256Hex,
		artifact: "archive",
		cleanup: target.cleanup
	};
}
function resolveLatestVersionFromPackage(detail) {
	return detail.package?.latestVersion ?? detail.package?.tags?.latest ?? null;
}
function satisfiesPluginApiRange(pluginApiVersion, pluginApiRange) {
	if (!pluginApiRange) return true;
	return satisfiesSemverRange(normalizeCalVerCorrectionForPluginApi(pluginApiVersion), pluginApiRange);
}
function satisfiesGatewayMinimum(currentVersion, minGatewayVersion) {
	if (!minGatewayVersion) return true;
	const current = parseSemver(currentVersion);
	const minimum = parseSemver(minGatewayVersion);
	if (!current || !minimum) return false;
	return isAtLeast(current, minimum);
}
//#endregion
export { fetchClawHubPackageDetail as a, normalizeClawHubSha256Hex as c, resolveLatestVersionFromPackage as d, satisfiesGatewayMinimum as f, searchClawHubSkills as h, fetchClawHubPackageArtifact as i, normalizeClawHubSha256Integrity as l, searchClawHubPackages as m, downloadClawHubPackageArchive as n, fetchClawHubPackageVersion as o, satisfiesPluginApiRange as p, downloadClawHubSkillArchive as r, fetchClawHubSkillDetail as s, ClawHubRequestError as t, resolveClawHubBaseUrl as u };
