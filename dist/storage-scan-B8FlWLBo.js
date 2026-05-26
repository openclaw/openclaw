import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as isRecord, p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
import { a as parseEnvValue, n as isNonEmptyString } from "./shared-Cv5g0_Ch.js";
import { a as listAuthProfileSecretTargetEntries } from "./target-registry-t5xykQQS.js";
import { a as formatExecSecretRefIdValidationMessage, o as isValidExecSecretRefId } from "./ref-contract-D_h_G00C.js";
import { r as createConfigIO } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import "./paths-DuwII6c5.js";
import fs from "node:fs";
import path from "node:path";
//#region src/secrets/auth-profiles-scan.ts
function getAuthProfileFieldName(pathPattern) {
	const segments = pathPattern.split(".").filter(Boolean);
	return segments[segments.length - 1] ?? "";
}
const AUTH_PROFILE_FIELD_SPEC_BY_TYPE = (() => {
	const defaults = {
		api_key: {
			valueField: "key",
			refField: "keyRef"
		},
		token: {
			valueField: "token",
			refField: "tokenRef"
		}
	};
	for (const target of listAuthProfileSecretTargetEntries()) {
		if (!target.authProfileType) continue;
		defaults[target.authProfileType] = {
			valueField: getAuthProfileFieldName(target.pathPattern),
			refField: target.refPathPattern !== void 0 ? getAuthProfileFieldName(target.refPathPattern) : defaults[target.authProfileType].refField
		};
	}
	return defaults;
})();
function getAuthProfileFieldSpec(type) {
	return AUTH_PROFILE_FIELD_SPEC_BY_TYPE[type];
}
function toSecretCredentialVisit(params) {
	const spec = getAuthProfileFieldSpec(params.kind);
	return {
		kind: params.kind,
		profileId: params.profileId,
		provider: params.provider,
		profile: params.profile,
		valueField: spec.valueField,
		refField: spec.refField,
		value: params.profile[spec.valueField],
		refValue: params.profile[spec.refField]
	};
}
function* iterateAuthProfileCredentials(profiles) {
	for (const [profileId, value] of Object.entries(profiles)) {
		if (!isRecord(value) || !isNonEmptyString(value.provider)) continue;
		const provider = value.provider;
		if (value.type === "api_key" || value.type === "token") {
			yield toSecretCredentialVisit({
				kind: value.type,
				profileId,
				provider,
				profile: value
			});
			continue;
		}
		if (value.type === "oauth") yield {
			kind: "oauth",
			profileId,
			provider,
			profile: value,
			hasAccess: isNonEmptyString(value.access),
			hasRefresh: isNonEmptyString(value.refresh)
		};
	}
}
//#endregion
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
//#region src/secrets/exec-resolution-policy.ts
function selectRefsForExecPolicy(params) {
	const refsToResolve = [];
	const skippedExecRefs = [];
	for (const ref of params.refs) {
		if (ref.source === "exec" && !params.allowExec) {
			skippedExecRefs.push(ref);
			continue;
		}
		refsToResolve.push(ref);
	}
	return {
		refsToResolve,
		skippedExecRefs
	};
}
function getSkippedExecRefStaticError(params) {
	const id = params.ref.id.trim();
	const refLabel = `${params.ref.source}:${params.ref.provider}:${id}`;
	if (!id) return "Error: Secret reference id is empty.";
	if (!isValidExecSecretRefId(id)) return `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`;
	const providerConfig = params.config.secrets?.providers?.[params.ref.provider];
	if (!providerConfig) return `Error: Secret provider "${params.ref.provider}" is not configured (ref: ${refLabel}).`;
	if (providerConfig.source !== params.ref.source) return `Error: Secret provider "${params.ref.provider}" has source "${providerConfig.source}" but ref requests "${params.ref.source}".`;
	return null;
}
//#endregion
//#region src/secrets/auth-store-paths.ts
function listAuthProfileStorePaths$1(config, stateDir) {
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
//#endregion
//#region src/secrets/storage-scan.ts
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseEnvAssignmentValue(raw) {
	return parseEnvValue(raw);
}
function listAuthProfileStorePaths(config, stateDir) {
	return listAuthProfileStorePaths$1(config, stateDir);
}
function listLegacyAuthJsonPaths(stateDir) {
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
function resolveActiveAgentDir(stateDir, env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override) return resolveUserPath(override);
	return path.join(resolveUserPath(stateDir), "agents", "main", "agent");
}
function listAgentModelsJsonPaths(config, stateDir, env = process.env) {
	const resolvedStateDir = resolveUserPath(stateDir);
	const paths = /* @__PURE__ */ new Set();
	paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
	paths.add(path.join(resolveActiveAgentDir(stateDir, env), "models.json"));
	const agentsRoot = path.join(resolvedStateDir, "agents");
	if (fs.existsSync(agentsRoot)) for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		paths.add(path.join(agentsRoot, entry.name, "agent", "models.json"));
	}
	for (const agentId of listAgentIds(config)) {
		if (agentId === "main") {
			paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
			continue;
		}
		const agentDir = resolveAgentDir(config, agentId);
		paths.add(path.join(resolveUserPath(agentDir), "models.json"));
	}
	return [...paths];
}
function readJsonObjectIfExists(filePath, options = {}) {
	if (!fs.existsSync(filePath)) return { value: null };
	try {
		const stats = fs.statSync(filePath);
		if (options.requireRegularFile && !stats.isFile()) return {
			value: null,
			error: `Refusing to read non-regular file: ${filePath}`
		};
		if (typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes >= 0 && stats.size > options.maxBytes) return {
			value: null,
			error: `Refusing to read oversized JSON (${stats.size} bytes): ${filePath}`
		};
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isJsonObject(parsed)) return { value: null };
		return { value: parsed };
	} catch (err) {
		return {
			value: null,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
export { readJsonObjectIfExists as a, createSecretsConfigIO as c, parseEnvAssignmentValue as i, iterateAuthProfileCredentials as l, listAuthProfileStorePaths as n, getSkippedExecRefStaticError as o, listLegacyAuthJsonPaths as r, selectRefsForExecPolicy as s, listAgentModelsJsonPaths as t };
