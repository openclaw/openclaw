import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
import "./shared-Cv5g0_Ch.js";
import { n as discoverConfigSecretTargets, t as discoverAuthProfileSecretTargets } from "./target-registry-t5xykQQS.js";
import { a as formatExecSecretRefIdValidationMessage, c as isValidSecretProviderAlias, l as resolveDefaultSecretProviderAlias, o as isValidExecSecretRefId } from "./ref-contract-D_h_G00C.js";
import { a as resolveSecretRefValue } from "./resolve-D1Ko6pWx.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { t as isSafeExecutableValue } from "./exec-safety-1iu4aOkR.js";
import "./constants-D_82oc2f.js";
import { g as loadPersistedAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as assertExpectedResolvedSecretValue } from "./secret-value-BZ8grP0G.js";
import { c as createSecretsConfigIO, o as getSkippedExecRefStaticError } from "./storage-scan-B8FlWLBo.js";
import { t as runSecretsApply } from "./apply-D3IF1c9d.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";
//#region src/secrets/configure-plan.ts
function getSecretProviders$1(config) {
	if (!isRecord(config.secrets?.providers)) return {};
	return config.secrets.providers;
}
function configureCandidateSortKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") return `auth-profiles:${candidate.agentId ?? ""}:${candidate.path}`;
	return `openclaw:${candidate.path}`;
}
function resolveAuthProfileProvider(store, pathSegments) {
	const profileId = pathSegments[1];
	if (!profileId) return;
	const profile = store.profiles?.[profileId];
	if (!isRecord(profile) || typeof profile.provider !== "string") return;
	const provider = profile.provider.trim();
	return provider.length > 0 ? provider : void 0;
}
function buildConfigureCandidatesForScope(params) {
	const authoredConfig = params.authoredOpenClawConfig ?? params.config;
	const hasPathInAuthoredConfig = (pathSegments) => hasPath(authoredConfig, pathSegments);
	const openclawCandidates = discoverConfigSecretTargets(params.config).filter((entry) => entry.entry.includeInConfigure).map((entry) => {
		const resolved = resolveSecretInputRef({
			value: entry.value,
			refValue: entry.refValue,
			defaults: params.config.secrets?.defaults
		});
		const pathExists = hasPathInAuthoredConfig(entry.pathSegments);
		const refPathExists = entry.refPathSegments ? hasPathInAuthoredConfig(entry.refPathSegments) : false;
		return Object.assign({
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: entry.path,
			configFile: `openclaw.json`,
			expectedResolvedValue: entry.entry.expectedResolvedValue
		}, resolved.ref ? { existingRef: resolved.ref } : {}, pathExists || refPathExists ? {} : { isDerived: true }, entry.providerId ? { providerId: entry.providerId } : {}, entry.accountId ? { accountId: entry.accountId } : {});
	});
	const authCandidates = params.authProfiles === void 0 ? [] : discoverAuthProfileSecretTargets(params.authProfiles.store).filter((entry) => entry.entry.includeInConfigure).map((entry) => {
		const authProfiles = params.authProfiles;
		if (!authProfiles) throw new Error("Missing auth profile scope for configure candidate discovery.");
		const authProfileProvider = resolveAuthProfileProvider(authProfiles.store, entry.pathSegments);
		const resolved = resolveSecretInputRef({
			value: entry.value,
			refValue: entry.refValue,
			defaults: params.config.secrets?.defaults
		});
		return Object.assign({
			type: entry.entry.targetType,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			label: `${entry.path} (auth profile, agent ${authProfiles.agentId})`,
			configFile: `auth-profiles.json`,
			expectedResolvedValue: entry.entry.expectedResolvedValue
		}, resolved.ref ? { existingRef: resolved.ref } : {}, { agentId: authProfiles.agentId }, authProfileProvider ? { authProfileProvider } : {});
	});
	return [...openclawCandidates, ...authCandidates].toSorted((a, b) => configureCandidateSortKey(a).localeCompare(configureCandidateSortKey(b)));
}
function hasPath(root, segments) {
	if (segments.length === 0) return false;
	let cursor = root;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!/^\d+$/.test(segment)) return false;
			const parsedIndex = Number.parseInt(segment, 10);
			if (!Number.isFinite(parsedIndex) || parsedIndex < 0 || parsedIndex >= cursor.length) return false;
			if (index === segments.length - 1) return true;
			cursor = cursor[parsedIndex];
			continue;
		}
		if (!isRecord(cursor)) return false;
		if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
		if (index === segments.length - 1) return true;
		cursor = cursor[segment];
	}
	return false;
}
function collectConfigureProviderChanges(params) {
	const originalProviders = getSecretProviders$1(params.original);
	const nextProviders = getSecretProviders$1(params.next);
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
function hasConfigurePlanChanges(params) {
	return params.selectedTargets.size > 0 || Object.keys(params.providerChanges.upserts).length > 0 || params.providerChanges.deletes.length > 0;
}
function buildSecretsConfigurePlan(params) {
	return {
		version: 1,
		protocolVersion: 1,
		generatedAt: params.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
		generatedBy: "openclaw secrets configure",
		targets: [...params.selectedTargets.values()].map((entry) => Object.assign({
			type: entry.type,
			path: entry.path,
			pathSegments: [...entry.pathSegments],
			ref: entry.ref
		}, entry.agentId ? { agentId: entry.agentId } : {}, entry.providerId ? { providerId: entry.providerId } : {}, entry.accountId ? { accountId: entry.accountId } : {}, entry.authProfileProvider ? { authProfileProvider: entry.authProfileProvider } : {})),
		...Object.keys(params.providerChanges.upserts).length > 0 ? { providerUpserts: params.providerChanges.upserts } : {},
		...params.providerChanges.deletes.length > 0 ? { providerDeletes: params.providerChanges.deletes } : {},
		options: {
			scrubEnv: true,
			scrubAuthProfilesForProviderTargets: true,
			scrubLegacyAuthJson: true
		}
	};
}
//#endregion
//#region src/secrets/configure.ts
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
const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
function validateEnvNameCsv(value) {
	const entries = parseCsv(value);
	for (const entry of entries) if (!ENV_NAME_PATTERN.test(entry)) return `Invalid env name: ${entry}`;
}
async function promptEnvNameCsv(params) {
	return parseCsv(assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue,
		validate: (value) => validateEnvNameCsv(value ?? "")
	}), "Secrets configure cancelled.") ?? "");
}
async function promptOptionalPositiveInt(params) {
	return parseOptionalPositiveInt(normalizeStringifiedOptionalString(assertNoCancel(await text({
		message: params.message,
		initialValue: params.initialValue === void 0 ? "" : String(params.initialValue),
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return;
			if (parseOptionalPositiveInt(trimmed, params.max) === void 0) return `Must be an integer between 1 and ${params.max}`;
		}
	}), "Secrets configure cancelled.")) ?? "", params.max);
}
function configureCandidateKey(candidate) {
	if (candidate.configFile === "auth-profiles.json") return `auth-profiles:${normalizeOptionalString(candidate.agentId) ?? ""}:${candidate.path}`;
	return `openclaw:${candidate.path}`;
}
function hasSourceChoice(sourceChoices, source) {
	return sourceChoices.some((entry) => entry.value === source);
}
function resolveCandidateProviderHint(candidate) {
	return normalizeOptionalLowercaseString(candidate.authProfileProvider) ?? normalizeOptionalLowercaseString(candidate.providerId);
}
function resolveSuggestedEnvSecretId(candidate) {
	const hintedProvider = resolveCandidateProviderHint(candidate);
	if (!hintedProvider) return;
	const envCandidates = getProviderEnvVars(hintedProvider);
	if (!Array.isArray(envCandidates) || envCandidates.length === 0) return;
	return envCandidates[0];
}
function resolveConfigureAgentId(config, explicitAgentId) {
	const knownAgentIds = new Set(listAgentIds(config));
	if (!explicitAgentId) return resolveDefaultAgentId(config);
	const normalized = normalizeAgentId(explicitAgentId);
	if (knownAgentIds.has(normalized)) return normalized;
	const known = [...knownAgentIds].toSorted().join(", ");
	throw new Error(`Unknown agent id "${explicitAgentId}". Known agents: ${known || "none configured"}.`);
}
function loadAuthProfileStoreForConfigure(params) {
	return loadPersistedAuthProfileStore(resolveAgentDir(params.config, params.agentId)) ?? {
		version: 1,
		profiles: {}
	};
}
async function promptNewAuthProfileCandidate(agentId) {
	const profileId = assertNoCancel(await text({
		message: "Auth profile id",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!AUTH_PROFILE_ID_PATTERN.test(trimmed)) return "Use letters/numbers/\":\"/\"_\"/\"-\" only.";
		}
	}), "Secrets configure cancelled.");
	const credentialType = assertNoCancel(await select({
		message: "Auth profile credential type",
		options: [{
			value: "api_key",
			label: "api_key (key/keyRef)"
		}, {
			value: "token",
			label: "token (token/tokenRef)"
		}]
	}), "Secrets configure cancelled.");
	const provider = assertNoCancel(await text({
		message: "Provider id",
		validate: (value) => normalizeStringifiedOptionalString(value) ? void 0 : "Required"
	}), "Secrets configure cancelled.");
	const profileIdTrimmed = normalizeStringifiedOptionalString(profileId) ?? "";
	const providerTrimmed = normalizeStringifiedOptionalString(provider) ?? "";
	if (credentialType === "token") return {
		type: "auth-profiles.token.token",
		path: `profiles.${profileIdTrimmed}.token`,
		pathSegments: [
			"profiles",
			profileIdTrimmed,
			"token"
		],
		label: `profiles.${profileIdTrimmed}.token (auth profile, agent ${agentId})`,
		configFile: "auth-profiles.json",
		agentId,
		authProfileProvider: providerTrimmed,
		expectedResolvedValue: "string"
	};
	return {
		type: "auth-profiles.api_key.key",
		path: `profiles.${profileIdTrimmed}.key`,
		pathSegments: [
			"profiles",
			profileIdTrimmed,
			"key"
		],
		label: `profiles.${profileIdTrimmed}.key (auth profile, agent ${agentId})`,
		configFile: "auth-profiles.json",
		agentId,
		authProfileProvider: providerTrimmed,
		expectedResolvedValue: "string"
	};
}
async function promptProviderAlias(params) {
	return normalizeStringifiedOptionalString(assertNoCancel(await text({
		message: "Provider alias",
		initialValue: "default",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!isValidSecretProviderAlias(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
			if (params.existingAliases.has(trimmed)) return "Alias already exists";
		}
	}), "Secrets configure cancelled.")) ?? "";
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
	const allowlist = await promptEnvNameCsv({
		message: "Env allowlist (comma-separated, blank for unrestricted)",
		initialValue: base?.allowlist?.join(",") ?? ""
	});
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
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
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
	const timeoutMs = await promptOptionalPositiveInt({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs,
		max: 12e4
	});
	const maxBytes = await promptOptionalPositiveInt({
		message: "Max bytes (blank for default)",
		initialValue: base?.maxBytes,
		max: 20 * 1024 * 1024
	});
	const allowInsecurePath = assertNoCancel(await confirm({
		message: "Allow insecure file path checks?",
		initialValue: base?.allowInsecurePath ?? false
	}), "Secrets configure cancelled.");
	return {
		source: "file",
		path: normalizeStringifiedOptionalString(filePath) ?? "",
		mode,
		...timeoutMs ? { timeoutMs } : {},
		...maxBytes ? { maxBytes } : {},
		...allowInsecurePath ? { allowInsecurePath: true } : {}
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
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return "Required";
			if (!isAbsolutePathValue(trimmed)) return "Must be an absolute path";
			if (!isSafeExecutableValue(trimmed)) return "Command value is not allowed";
		}
	}), "Secrets configure cancelled.");
	const argsRaw = assertNoCancel(await text({
		message: "Args JSON array (blank for none)",
		initialValue: JSON.stringify(base?.args ?? []),
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
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
	const timeoutMs = await promptOptionalPositiveInt({
		message: "Timeout ms (blank for default)",
		initialValue: base?.timeoutMs,
		max: 12e4
	});
	const noOutputTimeoutMs = await promptOptionalPositiveInt({
		message: "No-output timeout ms (blank for default)",
		initialValue: base?.noOutputTimeoutMs,
		max: 12e4
	});
	const maxOutputBytes = await promptOptionalPositiveInt({
		message: "Max output bytes (blank for default)",
		initialValue: base?.maxOutputBytes,
		max: 20 * 1024 * 1024
	});
	const jsonOnly = assertNoCancel(await confirm({
		message: "Require JSON-only response?",
		initialValue: base?.jsonOnly ?? true
	}), "Secrets configure cancelled.");
	const passEnv = await promptEnvNameCsv({
		message: "Pass-through env vars (comma-separated, blank for none)",
		initialValue: base?.passEnv?.join(",") ?? ""
	});
	const trustedDirsRaw = assertNoCancel(await text({
		message: "Trusted dirs (comma-separated absolute paths, blank for none)",
		initialValue: base?.trustedDirs?.join(",") ?? "",
		validate: (value) => {
			const entries = parseCsv(value ?? "");
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
	const args = await parseArgsInput(normalizeStringifiedOptionalString(argsRaw) ?? "");
	const trustedDirs = parseCsv(trustedDirsRaw ?? "");
	return {
		source: "exec",
		command: normalizeStringifiedOptionalString(command) ?? "",
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
async function runSecretsConfigureInteractive(params = {}) {
	if (!process.stdin.isTTY) throw new Error("secrets configure requires an interactive TTY.");
	if (params.providersOnly && params.skipProviderSetup) throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
	const env = params.env ?? process.env;
	const allowExecInPreflight = Boolean(params.allowExecInPreflight);
	const { snapshot } = await createSecretsConfigIO({ env }).readConfigFileSnapshotForWrite();
	if (!snapshot.valid) throw new Error("Cannot run interactive secrets configure because config is invalid.");
	const stagedConfig = structuredClone(snapshot.config);
	if (!params.skipProviderSetup) await configureProvidersInteractive(stagedConfig);
	const providerChanges = collectConfigureProviderChanges({
		original: snapshot.config,
		next: stagedConfig
	});
	const selectedByPath = /* @__PURE__ */ new Map();
	if (!params.providersOnly) {
		const configureAgentId = resolveConfigureAgentId(snapshot.config, params.agentId);
		const authStore = loadAuthProfileStoreForConfigure({
			config: snapshot.config,
			agentId: configureAgentId
		});
		const candidates = buildConfigureCandidatesForScope({
			config: stagedConfig,
			authoredOpenClawConfig: snapshot.resolved,
			authProfiles: {
				agentId: configureAgentId,
				store: authStore
			}
		});
		if (candidates.length === 0) throw new Error("No configurable secret-bearing fields found for this agent scope.");
		const sourceChoices = toSourceChoices(stagedConfig);
		const hasDerivedCandidates = candidates.some((candidate) => candidate.isDerived === true);
		let showDerivedCandidates = false;
		while (true) {
			const visibleCandidates = showDerivedCandidates ? candidates : candidates.filter((candidate) => candidate.isDerived !== true);
			const options = visibleCandidates.map((candidate) => ({
				value: configureCandidateKey(candidate),
				label: candidate.label,
				hint: [candidate.configFile === "auth-profiles.json" ? "auth-profiles.json" : "openclaw.json", candidate.isDerived === true ? "derived" : void 0].filter(Boolean).join(" | ")
			}));
			options.push({
				value: "__create_auth_profile__",
				label: "Create auth profile mapping",
				hint: `Add a new auth-profiles target for agent ${configureAgentId}`
			});
			if (hasDerivedCandidates) options.push({
				value: "__toggle_derived__",
				label: showDerivedCandidates ? "Hide derived targets" : "Show derived targets",
				hint: showDerivedCandidates ? "Show only fields authored directly in config" : "Include normalized/derived aliases"
			});
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
			if (selectedPath === "__create_auth_profile__") {
				const createdCandidate = await promptNewAuthProfileCandidate(configureAgentId);
				const key = configureCandidateKey(createdCandidate);
				const existingIndex = candidates.findIndex((entry) => configureCandidateKey(entry) === key);
				if (existingIndex >= 0) candidates[existingIndex] = createdCandidate;
				else candidates.push(createdCandidate);
				continue;
			}
			if (selectedPath === "__toggle_derived__") {
				showDerivedCandidates = !showDerivedCandidates;
				continue;
			}
			const candidate = visibleCandidates.find((entry) => configureCandidateKey(entry) === selectedPath);
			if (!candidate) throw new Error(`Unknown configure target: ${selectedPath}`);
			const candidateKey = configureCandidateKey(candidate);
			const existingRef = selectedByPath.get(candidateKey)?.ref ?? candidate.existingRef;
			const source = assertNoCancel(await select({
				message: "Secret source",
				options: sourceChoices,
				initialValue: existingRef && hasSourceChoice(sourceChoices, existingRef.source) ? existingRef.source : void 0
			}), "Secrets configure cancelled.");
			const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, { preferFirstProviderForSource: true });
			const providerAlias = normalizeStringifiedOptionalString(assertNoCancel(await text({
				message: "Provider alias",
				initialValue: existingRef?.source === source ? existingRef.provider : defaultAlias,
				validate: (value) => {
					const trimmed = normalizeStringifiedOptionalString(value) ?? "";
					if (!trimmed) return "Required";
					if (!isValidSecretProviderAlias(trimmed)) return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
				}
			}), "Secrets configure cancelled.")) ?? "";
			let suggestedId = existingRef?.source === source ? existingRef.id : void 0;
			if (!suggestedId && source === "env") suggestedId = resolveSuggestedEnvSecretId(candidate);
			if (!suggestedId && source === "file") {
				const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
				if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") suggestedId = "value";
			}
			const ref = {
				source,
				provider: providerAlias,
				id: normalizeStringifiedOptionalString(assertNoCancel(await text({
					message: "Secret id",
					initialValue: suggestedId,
					validate: (value) => {
						const trimmed = normalizeStringifiedOptionalString(value) ?? "";
						if (!trimmed) return "Required";
						if (source === "exec" && !isValidExecSecretRefId(trimmed)) return formatExecSecretRefIdValidationMessage();
					}
				}), "Secrets configure cancelled.")) ?? ""
			};
			if (ref.source === "exec" && !allowExecInPreflight) {
				const staticError = getSkippedExecRefStaticError({
					ref,
					config: stagedConfig
				});
				if (staticError) throw new Error(staticError);
			} else assertExpectedResolvedSecretValue({
				value: await resolveSecretRefValue(ref, {
					config: stagedConfig,
					env
				}),
				expected: candidate.expectedResolvedValue,
				errorMessage: candidate.expectedResolvedValue === "string" ? `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a non-empty string.` : `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a supported value type.`
			});
			const next = {
				...candidate,
				ref
			};
			selectedByPath.set(candidateKey, next);
			if (!assertNoCancel(await confirm({
				message: "Configure another credential?",
				initialValue: true
			}), "Secrets configure cancelled.")) break;
		}
	}
	if (!hasConfigurePlanChanges({
		selectedTargets: selectedByPath,
		providerChanges
	})) throw new Error("No secrets changes were selected.");
	const plan = buildSecretsConfigurePlan({
		selectedTargets: selectedByPath,
		providerChanges
	});
	return {
		plan,
		preflight: await runSecretsApply({
			plan,
			env,
			write: false,
			allowExec: allowExecInPreflight
		})
	};
}
//#endregion
export { runSecretsConfigureInteractive };
