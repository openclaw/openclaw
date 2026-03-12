import { $t as resolveStateDir, Ot as theme, gt as danger, it as resolveConfigDir, st as resolveUserPath, v as defaultRuntime } from "./entry.js";
import { $ as secretRefKey, A as createConfigIO, Jr as coerceSecretRef, Q as resolveDefaultSecretProviderAlias, Qt as isSafeExecutableValue, Sn as loadAuthProfileStoreForSecretsRuntime, Tn as resolveAuthStorePath, Vn as normalizeProviderId, Y as SecretProviderSchema, _ as isNonEmptyString, g as resolveSecretRefValues, h as resolveSecretRefValue, v as isRecord, y as writeTextFileAtomic } from "./auth-profiles-D6H-HVV8.js";
import { a as resolveAgentDir, r as listAgentIds } from "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./message-channel-CJUwnCYd.js";
import "./client-C2kv9X_7.js";
import "./call-D6IYi30Z.js";
import "./pairing-token-DzfCmsrM.js";
import "./net-DBrsyv8q.js";
import "./ip-BDxIP8rd.js";
import "./tailnet-Ca1WnFBq.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import "./progress-bvyZjsUc.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-BHrtynWc.js";
import { i as prepareSecretsRuntimeSnapshot } from "./runtime-B1Vh8h8y.js";
import { n as listKnownSecretEnvVarNames } from "./provider-env-vars-DTeLcDQm.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";

//#region src/secrets/config-io.ts
const silentConfigIoLogger = {
	error: () => {},
	warn: () => {}
};
function createSecretsConfigIO(params) {
	return createConfigIO({
		env: params.env,
		logger: silentConfigIoLogger
	});
}

//#endregion
//#region src/secrets/plan.ts
const PROVIDER_ALIAS_PATTERN$1 = /^[a-z][a-z0-9_-]{0,63}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isSecretsPlanTargetType(value) {
	return value === "models.providers.apiKey" || value === "skills.entries.apiKey" || value === "channels.googlechat.serviceAccount";
}
function isObjectRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSecretProviderConfigShape(value) {
	return SecretProviderSchema.safeParse(value).success;
}
function parseDotPath(pathname) {
	return pathname.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
function hasForbiddenPathSegment(segments) {
	return segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}
function hasMatchingPathShape(candidate, segments) {
	if (candidate.type === "models.providers.apiKey") {
		if (segments.length !== 4 || segments[0] !== "models" || segments[1] !== "providers" || segments[3] !== "apiKey") return false;
		return candidate.providerId === void 0 || candidate.providerId.trim().length === 0 || candidate.providerId === segments[2];
	}
	if (candidate.type === "skills.entries.apiKey") return segments.length === 4 && segments[0] === "skills" && segments[1] === "entries" && segments[3] === "apiKey";
	if (segments.length === 3 && segments[0] === "channels" && segments[1] === "googlechat" && segments[2] === "serviceAccount") return candidate.accountId === void 0 || candidate.accountId.trim().length === 0;
	if (segments.length === 5 && segments[0] === "channels" && segments[1] === "googlechat" && segments[2] === "accounts" && segments[4] === "serviceAccount") return candidate.accountId === void 0 || candidate.accountId.trim().length === 0 || candidate.accountId === segments[3];
	return false;
}
function resolveValidatedTargetPathSegments(candidate) {
	if (!isSecretsPlanTargetType(candidate.type)) return null;
	const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
	if (!path) return null;
	const segments = Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0 ? candidate.pathSegments.map((segment) => String(segment).trim()).filter(Boolean) : parseDotPath(path);
	if (segments.length === 0 || hasForbiddenPathSegment(segments) || path !== segments.join(".") || !hasMatchingPathShape({
		type: candidate.type,
		providerId: candidate.providerId,
		accountId: candidate.accountId
	}, segments)) return null;
	return segments;
}
function isSecretsApplyPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const typed = value;
	if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) return false;
	for (const target of typed.targets) {
		if (!target || typeof target !== "object") return false;
		const candidate = target;
		const ref = candidate.ref;
		if (candidate.type !== "models.providers.apiKey" && candidate.type !== "skills.entries.apiKey" && candidate.type !== "channels.googlechat.serviceAccount" || typeof candidate.path !== "string" || !candidate.path.trim() || candidate.pathSegments !== void 0 && !Array.isArray(candidate.pathSegments) || !resolveValidatedTargetPathSegments({
			type: candidate.type,
			path: candidate.path,
			pathSegments: candidate.pathSegments,
			providerId: candidate.providerId,
			accountId: candidate.accountId
		}) || !ref || typeof ref !== "object" || ref.source !== "env" && ref.source !== "file" && ref.source !== "exec" || typeof ref.provider !== "string" || ref.provider.trim().length === 0 || typeof ref.id !== "string" || ref.id.trim().length === 0) return false;
	}
	if (typed.providerUpserts !== void 0) {
		if (!isObjectRecord(typed.providerUpserts)) return false;
		for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
			if (!PROVIDER_ALIAS_PATTERN$1.test(providerAlias)) return false;
			if (!isSecretProviderConfigShape(providerValue)) return false;
		}
	}
	if (typed.providerDeletes !== void 0) {
		if (!Array.isArray(typed.providerDeletes) || typed.providerDeletes.some((providerAlias) => typeof providerAlias !== "string" || !PROVIDER_ALIAS_PATTERN$1.test(providerAlias))) return false;
	}
	return true;
}
function normalizeSecretsPlanOptions(options) {
	return {
		scrubEnv: options?.scrubEnv ?? true,
		scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
		scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true
	};
}

//#endregion
//#region src/secrets/apply.ts
function getByPathSegments(root, segments) {
	if (segments.length === 0) return;
	let cursor = root;
	for (const segment of segments) {
		if (!isRecord(cursor)) return;
		cursor = cursor[segment];
	}
	return cursor;
}
function setByPathSegments(root, segments, value) {
	if (segments.length === 0) throw new Error("Target path is empty.");
	let cursor = root;
	let changed = false;
	for (const segment of segments.slice(0, -1)) {
		const existing = cursor[segment];
		if (!isRecord(existing)) {
			cursor[segment] = {};
			changed = true;
		}
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	const previous = cursor[leaf];
	if (!isDeepStrictEqual(previous, value)) {
		cursor[leaf] = value;
		changed = true;
	}
	return changed;
}
function deleteByPathSegments(root, segments) {
	if (segments.length === 0) return false;
	let cursor = root;
	for (const segment of segments.slice(0, -1)) {
		const existing = cursor[segment];
		if (!isRecord(existing)) return false;
		cursor = existing;
	}
	const leaf = segments[segments.length - 1] ?? "";
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
	delete cursor[leaf];
	return true;
}
function resolveTargetPathSegments(target) {
	const resolved = resolveValidatedTargetPathSegments(target);
	if (!resolved) throw new Error(`Invalid plan target path for ${target.type}: ${target.path}`);
	return resolved;
}
function parseEnvValue$1(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}
function scrubEnvRaw(raw, migratedValues, allowedEnvKeys) {
	if (migratedValues.size === 0 || allowedEnvKeys.size === 0) return {
		nextRaw: raw,
		removed: 0
	};
	const lines = raw.split(/\r?\n/);
	const nextLines = [];
	let removed = 0;
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) {
			nextLines.push(line);
			continue;
		}
		const envKey = match[1] ?? "";
		if (!allowedEnvKeys.has(envKey)) {
			nextLines.push(line);
			continue;
		}
		const parsedValue = parseEnvValue$1(match[2] ?? "");
		if (migratedValues.has(parsedValue)) {
			removed += 1;
			continue;
		}
		nextLines.push(line);
	}
	const hadTrailingNewline = raw.endsWith("\n");
	const joined = nextLines.join("\n");
	return {
		nextRaw: hadTrailingNewline || joined.length === 0 ? `${joined}${joined.endsWith("\n") ? "" : "\n"}` : joined,
		removed
	};
}
function collectAuthStorePaths$1(config, stateDir) {
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (fs.existsSync(agentsRoot)) for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
	}
	for (const agentId of listAgentIds(config)) {
		if (agentId === "main") {
			paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
			continue;
		}
		const agentDir = resolveAgentDir(config, agentId);
		paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
	}
	return [...paths];
}
function collectAuthJsonPaths(stateDir) {
	const out = [];
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (!fs.existsSync(agentsRoot)) return out;
	for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
		if (fs.existsSync(candidate)) out.push(candidate);
	}
	return out;
}
function resolveGoogleChatRefPathSegments(pathSegments) {
	if (pathSegments.at(-1) === "serviceAccount") return [...pathSegments.slice(0, -1), "serviceAccountRef"];
	throw new Error(`Google Chat target path must end with "serviceAccount": ${pathSegments.join(".")}`);
}
function applyProviderPlanMutations(params) {
	const currentProviders = isRecord(params.config.secrets?.providers) ? structuredClone(params.config.secrets?.providers) : {};
	let changed = false;
	for (const providerAlias of params.deletes ?? []) {
		if (!Object.prototype.hasOwnProperty.call(currentProviders, providerAlias)) continue;
		delete currentProviders[providerAlias];
		changed = true;
	}
	for (const [providerAlias, providerConfig] of Object.entries(params.upserts ?? {})) {
		const previous = currentProviders[providerAlias];
		if (isDeepStrictEqual(previous, providerConfig)) continue;
		currentProviders[providerAlias] = structuredClone(providerConfig);
		changed = true;
	}
	if (!changed) return false;
	params.config.secrets ??= {};
	if (Object.keys(currentProviders).length === 0) {
		if ("providers" in params.config.secrets) delete params.config.secrets.providers;
		return true;
	}
	params.config.secrets.providers = currentProviders;
	return true;
}
async function projectPlanState(params) {
	const { snapshot, writeOptions } = await createSecretsConfigIO({ env: params.env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) throw new Error("Cannot apply secrets plan: config is invalid.");
	const options = normalizeSecretsPlanOptions(params.plan.options);
	const nextConfig = structuredClone(snapshot.config);
	const stateDir = resolveStateDir(params.env, os.homedir);
	const changedFiles = /* @__PURE__ */ new Set();
	const warnings = [];
	const scrubbedValues = /* @__PURE__ */ new Set();
	const providerTargets = /* @__PURE__ */ new Set();
	const configPath = resolveUserPath(snapshot.path);
	if (applyProviderPlanMutations({
		config: nextConfig,
		upserts: params.plan.providerUpserts,
		deletes: params.plan.providerDeletes
	})) changedFiles.add(configPath);
	for (const target of params.plan.targets) {
		const targetPathSegments = resolveTargetPathSegments(target);
		if (target.type === "channels.googlechat.serviceAccount") {
			const previous = getByPathSegments(nextConfig, targetPathSegments);
			if (isNonEmptyString(previous)) scrubbedValues.add(previous.trim());
			const wroteRef = setByPathSegments(nextConfig, resolveGoogleChatRefPathSegments(targetPathSegments), target.ref);
			const deletedLegacy = deleteByPathSegments(nextConfig, targetPathSegments);
			if (wroteRef || deletedLegacy) changedFiles.add(configPath);
			continue;
		}
		const previous = getByPathSegments(nextConfig, targetPathSegments);
		if (isNonEmptyString(previous)) scrubbedValues.add(previous.trim());
		if (setByPathSegments(nextConfig, targetPathSegments, target.ref)) changedFiles.add(configPath);
		if (target.type === "models.providers.apiKey" && target.providerId) providerTargets.add(normalizeProviderId(target.providerId));
	}
	const authStoreByPath = /* @__PURE__ */ new Map();
	if (options.scrubAuthProfilesForProviderTargets && providerTargets.size > 0) for (const authStorePath of collectAuthStorePaths$1(nextConfig, stateDir)) {
		if (!fs.existsSync(authStorePath)) continue;
		const raw = fs.readFileSync(authStorePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.profiles)) continue;
		const nextStore = structuredClone(parsed);
		let mutated = false;
		for (const profileValue of Object.values(nextStore.profiles)) {
			if (!isRecord(profileValue) || !isNonEmptyString(profileValue.provider)) continue;
			const provider = normalizeProviderId(String(profileValue.provider));
			if (!providerTargets.has(provider)) continue;
			if (profileValue.type === "api_key") {
				if (isNonEmptyString(profileValue.key)) scrubbedValues.add(profileValue.key.trim());
				if ("key" in profileValue) {
					delete profileValue.key;
					mutated = true;
				}
				if ("keyRef" in profileValue) {
					delete profileValue.keyRef;
					mutated = true;
				}
				continue;
			}
			if (profileValue.type === "token") {
				if (isNonEmptyString(profileValue.token)) scrubbedValues.add(profileValue.token.trim());
				if ("token" in profileValue) {
					delete profileValue.token;
					mutated = true;
				}
				if ("tokenRef" in profileValue) {
					delete profileValue.tokenRef;
					mutated = true;
				}
				continue;
			}
			if (profileValue.type === "oauth") warnings.push(`Provider "${provider}" has OAuth credentials in ${authStorePath}; those still take precedence and are out of scope for static SecretRef migration.`);
		}
		if (mutated) {
			authStoreByPath.set(authStorePath, nextStore);
			changedFiles.add(authStorePath);
		}
	}
	const authJsonByPath = /* @__PURE__ */ new Map();
	if (options.scrubLegacyAuthJson) for (const authJsonPath of collectAuthJsonPaths(stateDir)) {
		const raw = fs.readFileSync(authJsonPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) continue;
		let mutated = false;
		const nextParsed = structuredClone(parsed);
		for (const [providerId, value] of Object.entries(nextParsed)) {
			if (!isRecord(value)) continue;
			if (value.type === "api_key" && isNonEmptyString(value.key)) {
				delete nextParsed[providerId];
				mutated = true;
			}
		}
		if (mutated) {
			authJsonByPath.set(authJsonPath, nextParsed);
			changedFiles.add(authJsonPath);
		}
	}
	const envRawByPath = /* @__PURE__ */ new Map();
	if (options.scrubEnv && scrubbedValues.size > 0) {
		const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
		if (fs.existsSync(envPath)) {
			const current = fs.readFileSync(envPath, "utf8");
			const scrubbed = scrubEnvRaw(current, scrubbedValues, new Set(listKnownSecretEnvVarNames()));
			if (scrubbed.removed > 0 && scrubbed.nextRaw !== current) {
				envRawByPath.set(envPath, scrubbed.nextRaw);
				changedFiles.add(envPath);
			}
		}
	}
	const cache = {};
	for (const target of params.plan.targets) {
		const resolved = await resolveSecretRefValue(target.ref, {
			config: nextConfig,
			env: params.env,
			cache
		});
		if (target.type === "channels.googlechat.serviceAccount") {
			if (!(isNonEmptyString(resolved) || isRecord(resolved))) throw new Error(`Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not string/object.`);
			continue;
		}
		if (!isNonEmptyString(resolved)) throw new Error(`Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not a non-empty string.`);
	}
	const authStoreLookup = /* @__PURE__ */ new Map();
	for (const [authStorePath, store] of authStoreByPath.entries()) authStoreLookup.set(resolveUserPath(authStorePath), store);
	await prepareSecretsRuntimeSnapshot({
		config: nextConfig,
		env: params.env,
		loadAuthStore: (agentDir) => {
			const storePath = resolveUserPath(resolveAuthStorePath(agentDir));
			const override = authStoreLookup.get(storePath);
			if (override) return structuredClone(override);
			return loadAuthProfileStoreForSecretsRuntime(agentDir);
		}
	});
	return {
		nextConfig,
		configPath,
		configWriteOptions: writeOptions,
		authStoreByPath,
		authJsonByPath,
		envRawByPath,
		changedFiles,
		warnings
	};
}
function captureFileSnapshot(pathname) {
	if (!fs.existsSync(pathname)) return {
		existed: false,
		content: "",
		mode: 384
	};
	const stat = fs.statSync(pathname);
	return {
		existed: true,
		content: fs.readFileSync(pathname, "utf8"),
		mode: stat.mode & 511
	};
}
function restoreFileSnapshot(pathname, snapshot) {
	if (!snapshot.existed) {
		if (fs.existsSync(pathname)) fs.rmSync(pathname, { force: true });
		return;
	}
	writeTextFileAtomic(pathname, snapshot.content, snapshot.mode || 384);
}
function toJsonWrite(pathname, value) {
	return {
		path: pathname,
		content: `${JSON.stringify(value, null, 2)}\n`,
		mode: 384
	};
}
async function runSecretsApply(params) {
	const env = params.env ?? process.env;
	const projected = await projectPlanState({
		plan: params.plan,
		env
	});
	const changedFiles = [...projected.changedFiles].toSorted();
	if (!params.write) return {
		mode: "dry-run",
		changed: changedFiles.length > 0,
		changedFiles,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
	if (changedFiles.length === 0) return {
		mode: "write",
		changed: false,
		changedFiles: [],
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
	const io = createSecretsConfigIO({ env });
	const snapshots = /* @__PURE__ */ new Map();
	const capture = (pathname) => {
		if (!snapshots.has(pathname)) snapshots.set(pathname, captureFileSnapshot(pathname));
	};
	capture(projected.configPath);
	const writes = [];
	for (const [pathname, value] of projected.authStoreByPath.entries()) {
		capture(pathname);
		writes.push(toJsonWrite(pathname, value));
	}
	for (const [pathname, value] of projected.authJsonByPath.entries()) {
		capture(pathname);
		writes.push(toJsonWrite(pathname, value));
	}
	for (const [pathname, raw] of projected.envRawByPath.entries()) {
		capture(pathname);
		writes.push({
			path: pathname,
			content: raw,
			mode: 384
		});
	}
	try {
		await io.writeConfigFile(projected.nextConfig, projected.configWriteOptions);
		for (const write of writes) writeTextFileAtomic(write.path, write.content, write.mode);
	} catch (err) {
		for (const [pathname, snapshot] of snapshots.entries()) try {
			restoreFileSnapshot(pathname, snapshot);
		} catch {}
		throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
	}
	return {
		mode: "write",
		changed: changedFiles.length > 0,
		changedFiles,
		warningCount: projected.warnings.length,
		warnings: projected.warnings
	};
}

//#endregion
//#region src/secrets/audit.ts
function addFinding(collector, finding) {
	collector.findings.push(finding);
}
function collectProviderRefPath(collector, providerId, configPath) {
	const key = normalizeProviderId(providerId);
	const existing = collector.configProviderRefPaths.get(key);
	if (existing) {
		existing.push(configPath);
		return;
	}
	collector.configProviderRefPaths.set(key, [configPath]);
}
function trackAuthProviderState(collector, provider, mode) {
	const key = normalizeProviderId(provider);
	const existing = collector.authProviderState.get(key);
	if (existing) {
		existing.hasUsableStaticOrOAuth = true;
		existing.modes.add(mode);
		return;
	}
	collector.authProviderState.set(key, {
		hasUsableStaticOrOAuth: true,
		modes: new Set([mode])
	});
}
function parseEnvValue(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}
function collectEnvPlaintext(params) {
	if (!fs.existsSync(params.envPath)) return;
	params.collector.filesScanned.add(params.envPath);
	const knownKeys = new Set(listKnownSecretEnvVarNames());
	const lines = fs.readFileSync(params.envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) continue;
		const key = match[1] ?? "";
		if (!knownKeys.has(key)) continue;
		if (!parseEnvValue(match[2] ?? "")) continue;
		addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.envPath,
			jsonPath: `$env.${key}`,
			message: `Potential secret found in .env (${key}).`
		});
	}
}
function readJsonObject(filePath) {
	if (!fs.existsSync(filePath)) return { value: null };
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return { value: null };
		return { value: parsed };
	} catch (err) {
		return {
			value: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function collectConfigSecrets(params) {
	const defaults = params.config.secrets?.defaults;
	const providers = params.config.models?.providers;
	if (providers) for (const [providerId, provider] of Object.entries(providers)) {
		const pathLabel = `models.providers.${providerId}.apiKey`;
		const ref = coerceSecretRef(provider.apiKey, defaults);
		if (ref) {
			params.collector.refAssignments.push({
				file: params.configPath,
				path: pathLabel,
				ref,
				expected: "string",
				provider: providerId
			});
			collectProviderRefPath(params.collector, providerId, pathLabel);
			continue;
		}
		if (isNonEmptyString(provider.apiKey)) addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.configPath,
			jsonPath: pathLabel,
			message: "Provider apiKey is stored as plaintext.",
			provider: providerId
		});
	}
	const entries = params.config.skills?.entries;
	if (entries) for (const [entryId, entry] of Object.entries(entries)) {
		const pathLabel = `skills.entries.${entryId}.apiKey`;
		const ref = coerceSecretRef(entry.apiKey, defaults);
		if (ref) {
			params.collector.refAssignments.push({
				file: params.configPath,
				path: pathLabel,
				ref,
				expected: "string"
			});
			continue;
		}
		if (isNonEmptyString(entry.apiKey)) addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.configPath,
			jsonPath: pathLabel,
			message: "Skill apiKey is stored as plaintext."
		});
	}
	const googlechat = params.config.channels?.googlechat;
	if (!googlechat) return;
	const collectGoogleChatValue = (value, refValue, pathLabel, accountId) => {
		const explicitRef = coerceSecretRef(refValue, defaults);
		const inlineRef = explicitRef ? null : coerceSecretRef(value, defaults);
		const ref = explicitRef ?? inlineRef;
		if (ref) {
			params.collector.refAssignments.push({
				file: params.configPath,
				path: pathLabel,
				ref,
				expected: "string-or-object",
				provider: accountId ? "googlechat" : void 0
			});
			return;
		}
		if (isNonEmptyString(value) || isRecord(value) && Object.keys(value).length > 0) addFinding(params.collector, {
			code: "PLAINTEXT_FOUND",
			severity: "warn",
			file: params.configPath,
			jsonPath: pathLabel,
			message: "Google Chat serviceAccount is stored as plaintext."
		});
	};
	collectGoogleChatValue(googlechat.serviceAccount, googlechat.serviceAccountRef, "channels.googlechat.serviceAccount");
	if (!isRecord(googlechat.accounts)) return;
	for (const [accountId, accountValue] of Object.entries(googlechat.accounts)) {
		if (!isRecord(accountValue)) continue;
		collectGoogleChatValue(accountValue.serviceAccount, accountValue.serviceAccountRef, `channels.googlechat.accounts.${accountId}.serviceAccount`, accountId);
	}
}
function collectAuthStorePaths(config, stateDir) {
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
	const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
	if (fs.existsSync(agentsRoot)) for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
	}
	for (const agentId of listAgentIds(config)) {
		if (agentId === "main") {
			paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));
			continue;
		}
		const agentDir = resolveAgentDir(config, agentId);
		paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
	}
	return [...paths];
}
function collectAuthStoreSecrets(params) {
	if (!fs.existsSync(params.authStorePath)) return;
	params.collector.filesScanned.add(params.authStorePath);
	const parsedResult = readJsonObject(params.authStorePath);
	if (parsedResult.error) {
		addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: params.authStorePath,
			jsonPath: "<root>",
			message: `Invalid JSON in auth-profiles store: ${parsedResult.error}`
		});
		return;
	}
	const parsed = parsedResult.value;
	if (!parsed || !isRecord(parsed.profiles)) return;
	for (const [profileId, profileValue] of Object.entries(parsed.profiles)) {
		if (!isRecord(profileValue) || !isNonEmptyString(profileValue.provider)) continue;
		const provider = String(profileValue.provider);
		if (profileValue.type === "api_key") {
			const keyRef = coerceSecretRef(profileValue.keyRef, params.defaults);
			const inlineRef = keyRef ? null : coerceSecretRef(profileValue.key, params.defaults);
			const ref = keyRef ?? inlineRef;
			if (ref) {
				params.collector.refAssignments.push({
					file: params.authStorePath,
					path: `profiles.${profileId}.key`,
					ref,
					expected: "string",
					provider
				});
				trackAuthProviderState(params.collector, provider, "api_key");
			}
			if (isNonEmptyString(profileValue.key)) {
				addFinding(params.collector, {
					code: "PLAINTEXT_FOUND",
					severity: "warn",
					file: params.authStorePath,
					jsonPath: `profiles.${profileId}.key`,
					message: "Auth profile API key is stored as plaintext.",
					provider,
					profileId
				});
				trackAuthProviderState(params.collector, provider, "api_key");
			}
			continue;
		}
		if (profileValue.type === "token") {
			const tokenRef = coerceSecretRef(profileValue.tokenRef, params.defaults);
			const inlineRef = tokenRef ? null : coerceSecretRef(profileValue.token, params.defaults);
			const ref = tokenRef ?? inlineRef;
			if (ref) {
				params.collector.refAssignments.push({
					file: params.authStorePath,
					path: `profiles.${profileId}.token`,
					ref,
					expected: "string",
					provider
				});
				trackAuthProviderState(params.collector, provider, "token");
			}
			if (isNonEmptyString(profileValue.token)) {
				addFinding(params.collector, {
					code: "PLAINTEXT_FOUND",
					severity: "warn",
					file: params.authStorePath,
					jsonPath: `profiles.${profileId}.token`,
					message: "Auth profile token is stored as plaintext.",
					provider,
					profileId
				});
				trackAuthProviderState(params.collector, provider, "token");
			}
			continue;
		}
		if (profileValue.type === "oauth") {
			const hasAccess = isNonEmptyString(profileValue.access);
			const hasRefresh = isNonEmptyString(profileValue.refresh);
			if (hasAccess || hasRefresh) {
				addFinding(params.collector, {
					code: "LEGACY_RESIDUE",
					severity: "info",
					file: params.authStorePath,
					jsonPath: `profiles.${profileId}`,
					message: "OAuth credentials are present (out of scope for static SecretRef migration).",
					provider,
					profileId
				});
				trackAuthProviderState(params.collector, provider, "oauth");
			}
		}
	}
}
function collectAuthJsonResidue(params) {
	const agentsRoot = path.join(resolveUserPath(params.stateDir), "agents");
	if (!fs.existsSync(agentsRoot)) return;
	for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const authJsonPath = path.join(agentsRoot, entry.name, "agent", "auth.json");
		if (!fs.existsSync(authJsonPath)) continue;
		params.collector.filesScanned.add(authJsonPath);
		const parsedResult = readJsonObject(authJsonPath);
		if (parsedResult.error) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: authJsonPath,
				jsonPath: "<root>",
				message: `Invalid JSON in legacy auth.json: ${parsedResult.error}`
			});
			continue;
		}
		const parsed = parsedResult.value;
		if (!parsed) continue;
		for (const [providerId, value] of Object.entries(parsed)) {
			if (!isRecord(value)) continue;
			if (value.type === "api_key" && isNonEmptyString(value.key)) addFinding(params.collector, {
				code: "LEGACY_RESIDUE",
				severity: "warn",
				file: authJsonPath,
				jsonPath: providerId,
				message: "Legacy auth.json contains static api_key credentials.",
				provider: providerId
			});
		}
	}
}
async function collectUnresolvedRefFindings(params) {
	const cache = {};
	const refsByProvider = /* @__PURE__ */ new Map();
	for (const assignment of params.collector.refAssignments) {
		const providerKey = `${assignment.ref.source}:${assignment.ref.provider}`;
		let refsForProvider = refsByProvider.get(providerKey);
		if (!refsForProvider) {
			refsForProvider = /* @__PURE__ */ new Map();
			refsByProvider.set(providerKey, refsForProvider);
		}
		refsForProvider.set(secretRefKey(assignment.ref), assignment.ref);
	}
	const resolvedByRefKey = /* @__PURE__ */ new Map();
	const errorsByRefKey = /* @__PURE__ */ new Map();
	for (const refsForProvider of refsByProvider.values()) {
		const refs = [...refsForProvider.values()];
		try {
			const resolved = await resolveSecretRefValues(refs, {
				config: params.config,
				env: params.env,
				cache
			});
			for (const [key, value] of resolved.entries()) resolvedByRefKey.set(key, value);
			continue;
		} catch {}
		for (const ref of refs) {
			const key = secretRefKey(ref);
			try {
				const resolved = await resolveSecretRefValue(ref, {
					config: params.config,
					env: params.env,
					cache
				});
				resolvedByRefKey.set(key, resolved);
			} catch (err) {
				errorsByRefKey.set(key, err);
			}
		}
	}
	for (const assignment of params.collector.refAssignments) {
		const key = secretRefKey(assignment.ref);
		const resolveErr = errorsByRefKey.get(key);
		if (resolveErr) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (${describeUnknownError(resolveErr)}).`,
				provider: assignment.provider
			});
			continue;
		}
		if (!resolvedByRefKey.has(key)) {
			addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is missing).`,
				provider: assignment.provider
			});
			continue;
		}
		const resolved = resolvedByRefKey.get(key);
		if (assignment.expected === "string") {
			if (!isNonEmptyString(resolved)) addFinding(params.collector, {
				code: "REF_UNRESOLVED",
				severity: "error",
				file: assignment.file,
				jsonPath: assignment.path,
				message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a non-empty string).`,
				provider: assignment.provider
			});
			continue;
		}
		if (!(isNonEmptyString(resolved) || isRecord(resolved))) addFinding(params.collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: assignment.file,
			jsonPath: assignment.path,
			message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a string/object).`,
			provider: assignment.provider
		});
	}
}
function collectShadowingFindings(collector) {
	for (const [provider, paths] of collector.configProviderRefPaths.entries()) {
		const authState = collector.authProviderState.get(provider);
		if (!authState?.hasUsableStaticOrOAuth) continue;
		const modeText = [...authState.modes].join("/");
		for (const configPath of paths) addFinding(collector, {
			code: "REF_SHADOWED",
			severity: "warn",
			file: "openclaw.json",
			jsonPath: configPath,
			message: `Auth profile credentials (${modeText}) take precedence for provider "${provider}", so this config ref may never be used.`,
			provider
		});
	}
}
function describeUnknownError(err) {
	if (err instanceof Error && err.message.trim().length > 0) return err.message;
	if (typeof err === "string" && err.trim().length > 0) return err;
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
function summarizeFindings(findings) {
	return {
		plaintextCount: findings.filter((entry) => entry.code === "PLAINTEXT_FOUND").length,
		unresolvedRefCount: findings.filter((entry) => entry.code === "REF_UNRESOLVED").length,
		shadowedRefCount: findings.filter((entry) => entry.code === "REF_SHADOWED").length,
		legacyResidueCount: findings.filter((entry) => entry.code === "LEGACY_RESIDUE").length
	};
}
async function runSecretsAudit(params = {}) {
	const env = params.env ?? process.env;
	const previousAuthStoreReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
	process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
	try {
		const snapshot = await createSecretsConfigIO({ env }).readConfigFileSnapshot();
		const configPath = resolveUserPath(snapshot.path);
		const defaults = snapshot.valid ? snapshot.config.secrets?.defaults : void 0;
		const collector = {
			findings: [],
			refAssignments: [],
			configProviderRefPaths: /* @__PURE__ */ new Map(),
			authProviderState: /* @__PURE__ */ new Map(),
			filesScanned: new Set([configPath])
		};
		const stateDir = resolveStateDir(env, os.homedir);
		const envPath = path.join(resolveConfigDir(env, os.homedir), ".env");
		const config = snapshot.valid ? snapshot.config : {};
		if (snapshot.valid) {
			collectConfigSecrets({
				config,
				configPath,
				collector
			});
			for (const authStorePath of collectAuthStorePaths(config, stateDir)) collectAuthStoreSecrets({
				authStorePath,
				collector,
				defaults
			});
			await collectUnresolvedRefFindings({
				collector,
				config,
				env
			});
			collectShadowingFindings(collector);
		} else addFinding(collector, {
			code: "REF_UNRESOLVED",
			severity: "error",
			file: configPath,
			jsonPath: "<root>",
			message: "Config is invalid; cannot validate secret references reliably."
		});
		collectEnvPlaintext({
			envPath,
			collector
		});
		collectAuthJsonResidue({
			stateDir,
			collector
		});
		const summary = summarizeFindings(collector.findings);
		return {
			version: 1,
			status: summary.unresolvedRefCount > 0 ? "unresolved" : collector.findings.length > 0 ? "findings" : "clean",
			filesScanned: [...collector.filesScanned].toSorted(),
			summary,
			findings: collector.findings
		};
	} finally {
		if (previousAuthStoreReadOnly === void 0) delete process.env.OPENCLAW_AUTH_STORE_READONLY;
		else process.env.OPENCLAW_AUTH_STORE_READONLY = previousAuthStoreReadOnly;
	}
}
function resolveSecretsAuditExitCode(report, check) {
	if (report.summary.unresolvedRefCount > 0) return 2;
	if (check && report.findings.length > 0) return 1;
	return 0;
}

//#endregion
//#region src/secrets/configure.ts
const PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
function isAbsolutePathValue(value) {
	return path.isAbsolute(value) || WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}
function parseCsv(value) {
	return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function parseOptionalPositiveInt(value, max) {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (!/^\d+$/.test(trimmed)) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) return;
	return parsed;
}
function getSecretProviders(config) {
	if (!isRecord(config.secrets?.providers)) return {};
	return config.secrets.providers;
}
function setSecretProvider(config, providerAlias, providerConfig) {
	config.secrets ??= {};
	if (!isRecord(config.secrets.providers)) config.secrets.providers = {};
	config.secrets.providers[providerAlias] = providerConfig;
}
function removeSecretProvider(config, providerAlias) {
	if (!isRecord(config.secrets?.providers)) return false;
	const providers = config.secrets.providers;
	if (!Object.prototype.hasOwnProperty.call(providers, providerAlias)) return false;
	delete providers[providerAlias];
	if (Object.keys(providers).length === 0) delete config.secrets?.providers;
	if (isRecord(config.secrets?.defaults)) {
		const defaults = config.secrets.defaults;
		if (defaults?.env === providerAlias) delete defaults.env;
		if (defaults?.file === providerAlias) delete defaults.file;
		if (defaults?.exec === providerAlias) delete defaults.exec;
		if (defaults && defaults.env === void 0 && defaults.file === void 0 && defaults.exec === void 0) delete config.secrets?.defaults;
	}
	return true;
}
function providerHint(provider) {
	if (provider.source === "env") return provider.allowlist?.length ? `env (${provider.allowlist.length} allowlisted)` : "env";
	if (provider.source === "file") return `file (${provider.mode ?? "json"})`;
	return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}
function buildCandidates(config) {
	const out = [];
	const providers = config.models?.providers;
	if (providers) for (const [providerId, providerValue] of Object.entries(providers)) {
		if (!isRecord(providerValue)) continue;
		out.push({
			type: "models.providers.apiKey",
			path: `models.providers.${providerId}.apiKey`,
			pathSegments: [
				"models",
				"providers",
				providerId,
				"apiKey"
			],
			label: `Provider API key: ${providerId}`,
			providerId
		});
	}
	const entries = config.skills?.entries;
	if (entries) for (const [entryId, entryValue] of Object.entries(entries)) {
		if (!isRecord(entryValue)) continue;
		out.push({
			type: "skills.entries.apiKey",
			path: `skills.entries.${entryId}.apiKey`,
			pathSegments: [
				"skills",
				"entries",
				entryId,
				"apiKey"
			],
			label: `Skill API key: ${entryId}`
		});
	}
	const googlechat = config.channels?.googlechat;
	if (isRecord(googlechat)) {
		out.push({
			type: "channels.googlechat.serviceAccount",
			path: "channels.googlechat.serviceAccount",
			pathSegments: [
				"channels",
				"googlechat",
				"serviceAccount"
			],
			label: "Google Chat serviceAccount (default)"
		});
		const accounts = googlechat.accounts;
		if (isRecord(accounts)) for (const [accountId, value] of Object.entries(accounts)) {
			if (!isRecord(value)) continue;
			out.push({
				type: "channels.googlechat.serviceAccount",
				path: `channels.googlechat.accounts.${accountId}.serviceAccount`,
				pathSegments: [
					"channels",
					"googlechat",
					"accounts",
					accountId,
					"serviceAccount"
				],
				label: `Google Chat serviceAccount (${accountId})`,
				accountId
			});
		}
	}
	return out;
}
function toSourceChoices(config) {
	const hasSource = (source) => Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
	const choices = [{
		value: "env",
		label: "env"
	}];
	if (hasSource("file")) choices.push({
		value: "file",
		label: "file"
	});
	if (hasSource("exec")) choices.push({
		value: "exec",
		label: "exec"
	});
	return choices;
}
function assertNoCancel(value, message) {
	if (typeof value === "symbol") throw new Error(message);
	return value;
}
async function promptProviderAlias(params) {
	const alias = assertNoCancel(await text({
		message: "Provider alias",
		initialValue: "default",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return "Required";
			if (!PROVIDER_ALIAS_PATTERN.test(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
			if (params.existingAliases.has(trimmed)) return "Alias already exists";
		}
	}), "Secrets configure cancelled.");
	return String(alias).trim();
}
async function promptProviderSource(initial) {
	return assertNoCancel(await select({
		message: "Provider source",
		options: [
			{
				value: "env",
				label: "env"
			},
			{
				value: "file",
				label: "file"
			},
			{
				value: "exec",
				label: "exec"
			}
		],
		initialValue: initial
	}), "Secrets configure cancelled.");
}
async function promptEnvProvider(base) {
	const allowlistRaw = assertNoCancel(await text({
		message: "Env allowlist (comma-separated, blank for unrestricted)",
		initialValue: base?.allowlist?.join(",") ?? "",
		validate: (value) => {
			const entries = parseCsv(String(value ?? ""));
			for (const entry of entries) if (!ENV_NAME_PATTERN.test(entry)) return `Invalid env name: ${entry}`;
		}
	}), "Secrets configure cancelled.");
	const allowlist = parseCsv(String(allowlistRaw ?? ""));
	return {
		source: "env",
		...allowlist.length > 0 ? { allowlist } : {}
	};
}
async function promptFileProvider(base) {
	const filePath = assertNoCancel(await text({
		message: "File path (absolute)",
		initialValue: base?.path ?? "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return "Required";
			if (!isAbsolutePathValue(trimmed)) return "Must be an absolute path";
		}
	}), "Secrets configure cancelled.");
	const mode = assertNoCancel(await select({
		message: "File mode",
		options: [{
			value: "json",
			label: "json"
		}, {
			value: "singleValue",
			label: "singleValue"
		}],
		initialValue: base?.mode ?? "json"
	}), "Secrets configure cancelled.");
	const timeoutMsRaw = assertNoCancel(await text({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs ? String(base.timeoutMs) : "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, 12e4) === void 0) return "Must be an integer between 1 and 120000";
		}
	}), "Secrets configure cancelled.");
	const maxBytesRaw = assertNoCancel(await text({
		message: "Max bytes (blank for default)",
		initialValue: base?.maxBytes ? String(base.maxBytes) : "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, 20 * 1024 * 1024) === void 0) return "Must be an integer between 1 and 20971520";
		}
	}), "Secrets configure cancelled.");
	const timeoutMs = parseOptionalPositiveInt(String(timeoutMsRaw ?? ""), 12e4);
	const maxBytes = parseOptionalPositiveInt(String(maxBytesRaw ?? ""), 20 * 1024 * 1024);
	return {
		source: "file",
		path: String(filePath).trim(),
		mode,
		...timeoutMs ? { timeoutMs } : {},
		...maxBytes ? { maxBytes } : {}
	};
}
async function parseArgsInput(rawValue) {
	const trimmed = rawValue.trim();
	if (!trimmed) return;
	const parsed = JSON.parse(trimmed);
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("args must be a JSON array of strings");
	return parsed;
}
async function promptExecProvider(base) {
	const command = assertNoCancel(await text({
		message: "Command path (absolute)",
		initialValue: base?.command ?? "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return "Required";
			if (!isAbsolutePathValue(trimmed)) return "Must be an absolute path";
			if (!isSafeExecutableValue(trimmed)) return "Command value is not allowed";
		}
	}), "Secrets configure cancelled.");
	const argsRaw = assertNoCancel(await text({
		message: "Args JSON array (blank for none)",
		initialValue: JSON.stringify(base?.args ?? []),
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			try {
				const parsed = JSON.parse(trimmed);
				if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return "Must be a JSON array of strings";
				return;
			} catch {
				return "Must be valid JSON";
			}
		}
	}), "Secrets configure cancelled.");
	const timeoutMsRaw = assertNoCancel(await text({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs ? String(base.timeoutMs) : "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, 12e4) === void 0) return "Must be an integer between 1 and 120000";
		}
	}), "Secrets configure cancelled.");
	const noOutputTimeoutMsRaw = assertNoCancel(await text({
		message: "No-output timeout ms (blank for default)",
		initialValue: base?.noOutputTimeoutMs ? String(base.noOutputTimeoutMs) : "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, 12e4) === void 0) return "Must be an integer between 1 and 120000";
		}
	}), "Secrets configure cancelled.");
	const maxOutputBytesRaw = assertNoCancel(await text({
		message: "Max output bytes (blank for default)",
		initialValue: base?.maxOutputBytes ? String(base.maxOutputBytes) : "",
		validate: (value) => {
			const trimmed = String(value ?? "").trim();
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, 20 * 1024 * 1024) === void 0) return "Must be an integer between 1 and 20971520";
		}
	}), "Secrets configure cancelled.");
	const jsonOnly = assertNoCancel(await confirm({
		message: "Require JSON-only response?",
		initialValue: base?.jsonOnly ?? true
	}), "Secrets configure cancelled.");
	const passEnvRaw = assertNoCancel(await text({
		message: "Pass-through env vars (comma-separated, blank for none)",
		initialValue: base?.passEnv?.join(",") ?? "",
		validate: (value) => {
			const entries = parseCsv(String(value ?? ""));
			for (const entry of entries) if (!ENV_NAME_PATTERN.test(entry)) return `Invalid env name: ${entry}`;
		}
	}), "Secrets configure cancelled.");
	const trustedDirsRaw = assertNoCancel(await text({
		message: "Trusted dirs (comma-separated absolute paths, blank for none)",
		initialValue: base?.trustedDirs?.join(",") ?? "",
		validate: (value) => {
			const entries = parseCsv(String(value ?? ""));
			for (const entry of entries) if (!isAbsolutePathValue(entry)) return `Trusted dir must be absolute: ${entry}`;
		}
	}), "Secrets configure cancelled.");
	const allowInsecurePath = assertNoCancel(await confirm({
		message: "Allow insecure command path checks?",
		initialValue: base?.allowInsecurePath ?? false
	}), "Secrets configure cancelled.");
	const allowSymlinkCommand = assertNoCancel(await confirm({
		message: "Allow symlink command path?",
		initialValue: base?.allowSymlinkCommand ?? false
	}), "Secrets configure cancelled.");
	const args = await parseArgsInput(String(argsRaw ?? ""));
	const timeoutMs = parseOptionalPositiveInt(String(timeoutMsRaw ?? ""), 12e4);
	const noOutputTimeoutMs = parseOptionalPositiveInt(String(noOutputTimeoutMsRaw ?? ""), 12e4);
	const maxOutputBytes = parseOptionalPositiveInt(String(maxOutputBytesRaw ?? ""), 20 * 1024 * 1024);
	const passEnv = parseCsv(String(passEnvRaw ?? ""));
	const trustedDirs = parseCsv(String(trustedDirsRaw ?? ""));
	return {
		source: "exec",
		command: String(command).trim(),
		...args && args.length > 0 ? { args } : {},
		...timeoutMs ? { timeoutMs } : {},
		...noOutputTimeoutMs ? { noOutputTimeoutMs } : {},
		...maxOutputBytes ? { maxOutputBytes } : {},
		...jsonOnly ? { jsonOnly } : { jsonOnly: false },
		...passEnv.length > 0 ? { passEnv } : {},
		...trustedDirs.length > 0 ? { trustedDirs } : {},
		...allowInsecurePath ? { allowInsecurePath: true } : {},
		...allowSymlinkCommand ? { allowSymlinkCommand: true } : {},
		...isRecord(base?.env) ? { env: base.env } : {}
	};
}
async function promptProviderConfig(source, current) {
	if (source === "env") return await promptEnvProvider(current?.source === "env" ? current : void 0);
	if (source === "file") return await promptFileProvider(current?.source === "file" ? current : void 0);
	return await promptExecProvider(current?.source === "exec" ? current : void 0);
}
async function configureProvidersInteractive(config) {
	while (true) {
		const providers = getSecretProviders(config);
		const providerEntries = Object.entries(providers).toSorted(([left], [right]) => left.localeCompare(right));
		const actionOptions = [{
			value: "add",
			label: "Add provider",
			hint: "Define a new env/file/exec provider"
		}];
		if (providerEntries.length > 0) {
			actionOptions.push({
				value: "edit",
				label: "Edit provider",
				hint: "Update an existing provider"
			});
			actionOptions.push({
				value: "remove",
				label: "Remove provider",
				hint: "Delete a provider alias"
			});
		}
		actionOptions.push({
			value: "continue",
			label: "Continue",
			hint: "Move to credential mapping"
		});
		const action = assertNoCancel(await select({
			message: providerEntries.length > 0 ? "Configure secret providers" : "Configure secret providers (only env refs are available until file/exec providers are added)",
			options: actionOptions
		}), "Secrets configure cancelled.");
		if (action === "continue") return;
		if (action === "add") {
			const source = await promptProviderSource();
			setSecretProvider(config, await promptProviderAlias({ existingAliases: new Set(providerEntries.map(([providerAlias]) => providerAlias)) }), await promptProviderConfig(source));
			continue;
		}
		if (action === "edit") {
			const alias = assertNoCancel(await select({
				message: "Select provider to edit",
				options: providerEntries.map(([providerAlias, providerConfig]) => ({
					value: providerAlias,
					label: providerAlias,
					hint: providerHint(providerConfig)
				}))
			}), "Secrets configure cancelled.");
			const current = providers[alias];
			if (!current) continue;
			const nextProviderConfig = await promptProviderConfig(await promptProviderSource(current.source), current);
			if (!isDeepStrictEqual(current, nextProviderConfig)) setSecretProvider(config, alias, nextProviderConfig);
			continue;
		}
		if (action === "remove") {
			const alias = assertNoCancel(await select({
				message: "Select provider to remove",
				options: providerEntries.map(([providerAlias, providerConfig]) => ({
					value: providerAlias,
					label: providerAlias,
					hint: providerHint(providerConfig)
				}))
			}), "Secrets configure cancelled.");
			if (assertNoCancel(await confirm({
				message: `Remove provider "${alias}"?`,
				initialValue: false
			}), "Secrets configure cancelled.")) removeSecretProvider(config, alias);
		}
	}
}
function collectProviderPlanChanges(params) {
	const originalProviders = getSecretProviders(params.original);
	const nextProviders = getSecretProviders(params.next);
	const upserts = {};
	const deletes = [];
	for (const [providerAlias, nextProviderConfig] of Object.entries(nextProviders)) {
		const current = originalProviders[providerAlias];
		if (isDeepStrictEqual(current, nextProviderConfig)) continue;
		upserts[providerAlias] = structuredClone(nextProviderConfig);
	}
	for (const providerAlias of Object.keys(originalProviders)) if (!Object.prototype.hasOwnProperty.call(nextProviders, providerAlias)) deletes.push(providerAlias);
	return {
		upserts,
		deletes: deletes.toSorted()
	};
}
async function runSecretsConfigureInteractive(params = {}) {
	if (!process.stdin.isTTY) throw new Error("secrets configure requires an interactive TTY.");
	if (params.providersOnly && params.skipProviderSetup) throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
	const env = params.env ?? process.env;
	const { snapshot } = await createSecretsConfigIO({ env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) throw new Error("Cannot run interactive secrets configure because config is invalid.");
	const stagedConfig = structuredClone(snapshot.config);
	if (!params.skipProviderSetup) await configureProvidersInteractive(stagedConfig);
	const providerChanges = collectProviderPlanChanges({
		original: snapshot.config,
		next: stagedConfig
	});
	const selectedByPath = /* @__PURE__ */ new Map();
	if (!params.providersOnly) {
		const candidates = buildCandidates(stagedConfig);
		if (candidates.length === 0) throw new Error("No configurable secret-bearing fields found in openclaw.json.");
		const sourceChoices = toSourceChoices(stagedConfig);
		while (true) {
			const options = candidates.map((candidate) => ({
				value: candidate.path,
				label: candidate.label,
				hint: candidate.path
			}));
			if (selectedByPath.size > 0) options.unshift({
				value: "__done__",
				label: "Done",
				hint: "Finish and run preflight"
			});
			const selectedPath = assertNoCancel(await select({
				message: "Select credential field",
				options
			}), "Secrets configure cancelled.");
			if (selectedPath === "__done__") break;
			const candidate = candidates.find((entry) => entry.path === selectedPath);
			if (!candidate) throw new Error(`Unknown configure target: ${selectedPath}`);
			const source = assertNoCancel(await select({
				message: "Secret source",
				options: sourceChoices
			}), "Secrets configure cancelled.");
			const provider = assertNoCancel(await text({
				message: "Provider alias",
				initialValue: resolveDefaultSecretProviderAlias(stagedConfig, source, { preferFirstProviderForSource: true }),
				validate: (value) => {
					const trimmed = String(value ?? "").trim();
					if (!trimmed) return "Required";
					if (!PROVIDER_ALIAS_PATTERN.test(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
				}
			}), "Secrets configure cancelled.");
			const id = assertNoCancel(await text({
				message: "Secret id",
				validate: (value) => String(value ?? "").trim().length > 0 ? void 0 : "Required"
			}), "Secrets configure cancelled.");
			const ref = {
				source,
				provider: String(provider).trim(),
				id: String(id).trim()
			};
			const next = {
				...candidate,
				ref
			};
			selectedByPath.set(candidate.path, next);
			if (!assertNoCancel(await confirm({
				message: "Configure another credential?",
				initialValue: true
			}), "Secrets configure cancelled.")) break;
		}
	}
	if (selectedByPath.size === 0 && Object.keys(providerChanges.upserts).length === 0 && providerChanges.deletes.length === 0) throw new Error("No secrets changes were selected.");
	const plan = {
		version: 1,
		protocolVersion: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		generatedBy: "openclaw secrets configure",
		targets: [...selectedByPath.values()].map((entry) => ({
			type: entry.type,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			ref: entry.ref,
			...entry.providerId ? { providerId: entry.providerId } : {},
			...entry.accountId ? { accountId: entry.accountId } : {}
		})),
		...Object.keys(providerChanges.upserts).length > 0 ? { providerUpserts: providerChanges.upserts } : {},
		...providerChanges.deletes.length > 0 ? { providerDeletes: providerChanges.deletes } : {},
		options: {
			scrubEnv: true,
			scrubAuthProfilesForProviderTargets: true,
			scrubLegacyAuthJson: true
		}
	};
	return {
		plan,
		preflight: await runSecretsApply({
			plan,
			env,
			write: false
		})
	};
}

//#endregion
//#region src/cli/secrets-cli.ts
function readPlanFile(pathname) {
	const raw = fs.readFileSync(pathname, "utf8");
	const parsed = JSON.parse(raw);
	if (!isSecretsApplyPlan(parsed)) throw new Error(`Invalid secrets plan file: ${pathname}`);
	return parsed;
}
function registerSecretsCli(program) {
	const secrets = program.command("secrets").description("Secrets runtime controls").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/security", "docs.openclaw.ai/gateway/security")}\n`);
	addGatewayClientOptions(secrets.command("reload").description("Re-resolve secret references and atomically swap runtime snapshot").option("--json", "Output JSON", false)).action(async (opts) => {
		try {
			const result = await callGatewayFromCli("secrets.reload", opts, void 0, { expectFinal: false });
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const warningCount = Number(result?.warningCount ?? 0);
			if (Number.isFinite(warningCount) && warningCount > 0) {
				defaultRuntime.log(`Secrets reloaded with ${warningCount} warning(s).`);
				return;
			}
			defaultRuntime.log("Secrets reloaded.");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("audit").description("Audit plaintext secrets, unresolved refs, and precedence drift").option("--check", "Exit non-zero when findings are present", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const report = await runSecretsAudit();
			if (opts.json) defaultRuntime.log(JSON.stringify(report, null, 2));
			else {
				defaultRuntime.log(`Secrets audit: ${report.status}. plaintext=${report.summary.plaintextCount}, unresolved=${report.summary.unresolvedRefCount}, shadowed=${report.summary.shadowedRefCount}, legacy=${report.summary.legacyResidueCount}.`);
				if (report.findings.length > 0) {
					for (const finding of report.findings.slice(0, 20)) defaultRuntime.log(`- [${finding.code}] ${finding.file}:${finding.jsonPath} ${finding.message}`);
					if (report.findings.length > 20) defaultRuntime.log(`... ${report.findings.length - 20} more finding(s).`);
				}
			}
			const exitCode = resolveSecretsAuditExitCode(report, Boolean(opts.check));
			if (exitCode !== 0) defaultRuntime.exit(exitCode);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(2);
		}
	});
	secrets.command("configure").description("Interactive secrets helper (provider setup + SecretRef mapping + preflight)").option("--apply", "Apply changes immediately after preflight", false).option("--yes", "Skip apply confirmation prompt", false).option("--providers-only", "Configure secrets.providers only, skip credential mapping", false).option("--skip-provider-setup", "Skip provider setup and only map credential fields to existing providers", false).option("--plan-out <path>", "Write generated plan JSON to a file").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const configured = await runSecretsConfigureInteractive({
				providersOnly: Boolean(opts.providersOnly),
				skipProviderSetup: Boolean(opts.skipProviderSetup)
			});
			if (opts.planOut) fs.writeFileSync(opts.planOut, `${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");
			if (opts.json) defaultRuntime.log(JSON.stringify({
				plan: configured.plan,
				preflight: configured.preflight
			}, null, 2));
			else {
				defaultRuntime.log(`Preflight: changed=${configured.preflight.changed}, files=${configured.preflight.changedFiles.length}, warnings=${configured.preflight.warningCount}.`);
				if (configured.preflight.warningCount > 0) for (const warning of configured.preflight.warnings) defaultRuntime.log(`- warning: ${warning}`);
				const providerUpserts = Object.keys(configured.plan.providerUpserts ?? {}).length;
				const providerDeletes = configured.plan.providerDeletes?.length ?? 0;
				defaultRuntime.log(`Plan: targets=${configured.plan.targets.length}, providerUpserts=${providerUpserts}, providerDeletes=${providerDeletes}.`);
				if (opts.planOut) defaultRuntime.log(`Plan written to ${opts.planOut}`);
			}
			let shouldApply = Boolean(opts.apply);
			if (!shouldApply && !opts.json) {
				const approved = await confirm({
					message: "Apply this plan now?",
					initialValue: true
				});
				if (typeof approved === "boolean") shouldApply = approved;
			}
			if (shouldApply) {
				if (Boolean(opts.apply) && !opts.yes && !opts.json) {
					if (await confirm({
						message: "This migration is one-way for migrated plaintext values. Continue with apply?",
						initialValue: true
					}) !== true) {
						defaultRuntime.log("Apply cancelled.");
						return;
					}
				}
				const result = await runSecretsApply({
					plan: configured.plan,
					write: true
				});
				if (opts.json) {
					defaultRuntime.log(JSON.stringify(result, null, 2));
					return;
				}
				defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
			}
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	secrets.command("apply").description("Apply a previously generated secrets plan").requiredOption("--from <path>", "Path to plan JSON").option("--dry-run", "Validate/preflight only", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const result = await runSecretsApply({
				plan: readPlanFile(opts.from),
				write: !opts.dryRun
			});
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (opts.dryRun) {
				defaultRuntime.log(result.changed ? `Secrets apply dry run: ${result.changedFiles.length} file(s) would change.` : "Secrets apply dry run: no changes.");
				return;
			}
			defaultRuntime.log(result.changed ? `Secrets applied. Updated ${result.changedFiles.length} file(s).` : "Secrets apply: no changes.");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
export { registerSecretsCli };