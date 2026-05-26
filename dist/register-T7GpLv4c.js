import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./provider-model-shared-DtsPmvDx.js";
import "./secret-input-CWnTb0tw.js";
import { i as registerHealthCheck } from "./health-check-registry-DxXQHCTW.js";
import "./health-B1sNnMi-.js";
import JSON5 from "json5";
import { basename, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
//#region extensions/policy/src/policy-state.ts
const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;
function policyDocumentHash(policy) {
	return sha256(stableJson(policy));
}
function policyWorkspaceHash(evidence) {
	return sha256(stableJson(evidence));
}
function policyFindingsHash(findings) {
	return sha256(stableJson(findings));
}
function policyAttestationHash(input) {
	return sha256(stableJson(input));
}
function createPolicyAttestation(input) {
	const workspaceHash = policyWorkspaceHash(input.evidence);
	const findingsHash = policyFindingsHash(input.findings);
	return {
		checkedAt: input.checkedAt,
		...input.policyHash === void 0 ? {} : { policy: {
			path: input.policyPath,
			hash: input.policyHash
		} },
		workspace: {
			scope: "policy",
			hash: workspaceHash
		},
		findingsHash,
		attestationHash: policyAttestationHash({
			ok: input.ok,
			policyHash: input.policyHash,
			workspaceHash,
			findingsHash
		})
	};
}
function collectPolicyEvidence(cfg, options = {}) {
	const evidence = {
		channels: scanPolicyChannels(cfg),
		mcpServers: scanPolicyMcpServers(cfg),
		modelProviders: scanPolicyModelProviders(cfg),
		modelRefs: scanPolicyModelRefs(cfg),
		network: scanPolicyNetwork(cfg),
		...options.includeGatewayExposure === false ? {} : { gatewayExposure: scanPolicyGatewayExposure(cfg) },
		...options.includeAgentWorkspace === false ? {} : { agentWorkspace: scanPolicyAgentWorkspace(cfg) },
		...options.includeSecrets === false ? {} : { secrets: scanPolicySecrets(cfg) },
		...options.includeAuthProfiles === false ? {} : { authProfiles: scanPolicyAuthProfiles(cfg) }
	};
	if (options.toolsRaw === void 0) return evidence;
	return scanPolicyTools(options.toolsRaw).then((tools) => ({
		...evidence,
		tools
	}));
}
function scanPolicyChannels(cfg) {
	return Object.entries(configuredChannels(cfg)).filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id)).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
		const entry = {
			id,
			provider: id,
			source: `oc://openclaw.config/channels/${id}`
		};
		if (isRecord$1(value) && typeof value.enabled === "boolean") entry.enabled = value.enabled;
		return entry;
	});
}
function scanPolicyMcpServers(cfg) {
	return Object.entries(configuredMcpServers(cfg)).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
		const entry = {
			id,
			transport: mcpServerTransport(value),
			source: `oc://openclaw.config/mcp/servers/${ocPathSegment(id)}`
		};
		if (isRecord$1(value)) {
			if (typeof value.command === "string") entry.command = value.command;
			if (typeof value.url === "string") entry.url = redactMcpUrlForEvidence(value.url);
		}
		return entry;
	});
}
function scanPolicyModelProviders(cfg) {
	return Object.keys(configuredModelProviders(cfg)).toSorted((a, b) => a.localeCompare(b)).map((id) => ({
		id: normalizeProviderId(id),
		source: `oc://openclaw.config/models/providers/${id}`
	}));
}
function scanPolicyModelRefs(cfg) {
	const refs = [];
	if (isRecord$1(cfg.agents)) {
		collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
		collectModelRefsFromAgentAllowlist(refs, cfg.agents);
	}
	return refs.toSorted((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
function scanPolicyNetwork(cfg) {
	return [
		networkBooleanEvidence(cfg, "browser-private-network", [
			"browser",
			"ssrfPolicy",
			"dangerouslyAllowPrivateNetwork"
		], "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork"),
		networkBooleanEvidence(cfg, "browser-private-network-legacy", [
			"browser",
			"ssrfPolicy",
			"allowPrivateNetwork"
		], "oc://openclaw.config/browser/ssrfPolicy/allowPrivateNetwork"),
		networkBooleanEvidence(cfg, "web-fetch-private-network", [
			"tools",
			"web",
			"fetch",
			"ssrfPolicy",
			"dangerouslyAllowPrivateNetwork"
		], "oc://openclaw.config/tools/web/fetch/ssrfPolicy/dangerouslyAllowPrivateNetwork"),
		networkBooleanEvidence(cfg, "web-fetch-private-network-legacy", [
			"tools",
			"web",
			"fetch",
			"ssrfPolicy",
			"allowPrivateNetwork"
		], "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowPrivateNetwork"),
		networkBooleanEvidence(cfg, "web-fetch-rfc2544-benchmark-range", [
			"tools",
			"web",
			"fetch",
			"ssrfPolicy",
			"allowRfc2544BenchmarkRange"
		], "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowRfc2544BenchmarkRange"),
		networkBooleanEvidence(cfg, "web-fetch-ipv6-unique-local-range", [
			"tools",
			"web",
			"fetch",
			"ssrfPolicy",
			"allowIpv6UniqueLocalRange"
		], "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange")
	].filter((entry) => entry !== void 0);
}
function scanPolicyGatewayExposure(cfg) {
	const gateway = isRecord$1(cfg.gateway) ? cfg.gateway : {};
	const entries = [];
	const bind = typeof gateway.bind === "string" ? gateway.bind : void 0;
	const customBindHost = typeof gateway.customBindHost === "string" ? gateway.customBindHost : void 0;
	const hasCustomBindHost = customBindHost !== void 0 && customBindHost.trim() !== "";
	const tailscale = isRecord$1(gateway.tailscale) ? gateway.tailscale : {};
	const tailscaleForcesLoopback = tailscale.mode === "serve" || tailscale.mode === "funnel";
	entries.push({
		id: bind === void 0 ? "gateway-bind-default" : "gateway-bind",
		kind: "bind",
		source: "oc://openclaw.config/gateway/bind",
		value: bind ?? (tailscaleForcesLoopback ? "loopback" : "runtime-default"),
		nonLoopback: bind === void 0 ? !tailscaleForcesLoopback : bind === "custom" ? false : isGatewayNonLoopbackBind(bind),
		explicit: bind !== void 0
	});
	if (bind === "custom" && hasCustomBindHost) entries.push({
		id: "gateway-custom-bind-host",
		kind: "bind",
		source: "oc://openclaw.config/gateway/customBindHost",
		value: customBindHost,
		nonLoopback: isRuntimeNonLoopbackCustomBindHost(customBindHost)
	});
	const auth = isRecord$1(gateway.auth) ? gateway.auth : {};
	entries.push({
		id: "gateway-auth-mode",
		kind: "auth",
		source: "oc://openclaw.config/gateway/auth/mode",
		value: typeof auth.mode === "string" ? auth.mode : "token",
		explicit: typeof auth.mode === "string"
	});
	entries.push({
		id: "gateway-auth-rate-limit",
		kind: "authRateLimit",
		source: "oc://openclaw.config/gateway/auth/rateLimit",
		value: isRecord$1(auth.rateLimit),
		explicit: isRecord$1(auth.rateLimit)
	});
	const controlUi = isRecord$1(gateway.controlUi) ? gateway.controlUi : {};
	pushGatewayBooleanEvidence(entries, "gateway-control-ui-enabled", "controlUi", controlUi.enabled, "oc://openclaw.config/gateway/controlUi/enabled");
	pushGatewayBooleanEvidence(entries, "gateway-control-ui-insecure-auth", "controlUi", controlUi.allowInsecureAuth, "oc://openclaw.config/gateway/controlUi/allowInsecureAuth");
	pushGatewayBooleanEvidence(entries, "gateway-control-ui-device-auth-disabled", "controlUi", controlUi.dangerouslyDisableDeviceAuth, "oc://openclaw.config/gateway/controlUi/dangerouslyDisableDeviceAuth");
	pushGatewayBooleanEvidence(entries, "gateway-control-ui-host-origin-fallback", "controlUi", controlUi.dangerouslyAllowHostHeaderOriginFallback, "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback");
	if (typeof tailscale.mode === "string") entries.push({
		id: "gateway-tailscale-mode",
		kind: "tailscale",
		source: "oc://openclaw.config/gateway/tailscale/mode",
		value: tailscale.mode
	});
	if (tailscale.mode === "serve" && tailscale.preserveFunnel === true) entries.push({
		id: "gateway-tailscale-preserve-funnel",
		kind: "tailscale",
		source: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
		value: "funnel"
	});
	const remote = isRecord$1(gateway.remote) ? gateway.remote : {};
	if (gateway.mode === "remote") {
		entries.push({
			id: "gateway-mode-remote",
			kind: "remote",
			source: "oc://openclaw.config/gateway/mode",
			value: "remote"
		});
		if (typeof remote.url === "string" && remote.url.trim() !== "") entries.push({
			id: "gateway-remote-url",
			kind: "remote",
			source: "oc://openclaw.config/gateway/remote/url",
			value: true
		});
	}
	const http = isRecord$1(gateway.http) ? gateway.http : {};
	const endpoints = isRecord$1(http.endpoints) ? http.endpoints : {};
	pushGatewayHttpEndpointEvidence(entries, endpoints, "chatCompletions");
	pushGatewayHttpEndpointEvidence(entries, endpoints, "responses");
	return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}
function scanPolicyAgentWorkspace(cfg) {
	const agents = isRecord$1(cfg.agents) ? cfg.agents : {};
	const defaults = isRecord$1(agents.defaults) ? agents.defaults : {};
	const defaultSandbox = isRecord$1(defaults.sandbox) ? defaults.sandbox : {};
	const defaultTools = isRecord$1(cfg.tools) ? cfg.tools : {};
	const entries = [];
	pushAgentWorkspaceEvidence(entries, {
		id: "agents-defaults",
		scope: "defaults",
		sandbox: defaultSandbox,
		inheritedSandbox: {},
		tools: defaultTools,
		inheritedTools: {},
		workspaceSourceBase: "oc://openclaw.config/agents/defaults",
		inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
		toolsSourceBase: "oc://openclaw.config/tools",
		inheritedToolsSourceBase: "oc://openclaw.config/tools"
	});
	(Array.isArray(agents.list) ? agents.list : []).forEach((agent, index) => {
		if (!isRecord$1(agent)) return;
		const agentId = typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : void 0;
		const sandbox = isRecord$1(agent.sandbox) ? agent.sandbox : {};
		const tools = isRecord$1(agent.tools) ? agent.tools : {};
		pushAgentWorkspaceEvidence(entries, {
			id: agentId ?? `agent-${index}`,
			scope: "agent",
			agentId,
			sandbox,
			inheritedSandbox: defaultSandbox,
			tools,
			inheritedTools: defaultTools,
			workspaceSourceBase: `oc://openclaw.config/agents/list/#${index}`,
			inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
			toolsSourceBase: `oc://openclaw.config/agents/list/#${index}/tools`,
			inheritedToolsSourceBase: "oc://openclaw.config/tools"
		});
	});
	return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
function scanPolicySecrets(cfg) {
	return [...scanPolicySecretProviders(cfg), ...scanPolicySecretInputs(cfg)].toSorted((a, b) => a.source.localeCompare(b.source));
}
function scanPolicyAuthProfiles(cfg) {
	const auth = isRecord$1(cfg.auth) ? cfg.auth : {};
	const profiles = isRecord$1(auth.profiles) ? auth.profiles : {};
	return Object.entries(profiles).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
		const entry = {
			id,
			source: `oc://openclaw.config/auth/profiles/${ocPathSegment(id)}`,
			validMetadata: isValidAuthProfileMetadata(value)
		};
		if (isRecord$1(value)) {
			if (typeof value.provider === "string") entry.provider = value.provider;
			if (typeof value.mode === "string") entry.mode = value.mode;
		}
		return entry;
	});
}
function scanPolicySecretProviders(cfg) {
	const secrets = isRecord$1(cfg.secrets) ? cfg.secrets : {};
	const providers = isRecord$1(secrets.providers) ? secrets.providers : {};
	return Object.entries(providers).map(([id, value]) => {
		const insecure = secretProviderInsecureFlags(value);
		const entry = {
			id,
			kind: "provider",
			source: `oc://openclaw.config/secrets/providers/${ocPathSegment(id)}`
		};
		if (isRecord$1(value) && typeof value.source === "string") entry.providerSource = value.source;
		if (insecure.length > 0) entry.insecure = insecure;
		return entry;
	});
}
function scanPolicySecretInputs(cfg) {
	const entries = [];
	collectSecretInputs(entries, cfg, [], secretRefDefaults((isRecord$1(cfg.secrets) ? cfg.secrets : {}).defaults));
	return entries;
}
function collectSecretInputs(entries, value, path, defaults) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectSecretInputs(entries, item, [...path, `#${index}`], defaults));
		return;
	}
	if (!isRecord$1(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const childPath = [...path, key];
		const source = configPathSource(childPath);
		const ref = isSecretInputPath(childPath) ? secretRefEvidence(child, defaults) : void 0;
		if (ref !== void 0) {
			entries.push({
				id: source,
				kind: "input",
				source,
				provenance: "secretRef",
				refSource: ref.source,
				refProvider: ref.provider
			});
			continue;
		}
		collectSecretInputs(entries, child, childPath, defaults);
	}
}
function configPathSource(path) {
	return `oc://openclaw.config/${path.map(ocPathSegment).join("/")}`;
}
function isSecretInputPath(path) {
	const key = path.at(-1);
	if (key === void 0) return false;
	if (matchesConfigPath(path, [
		"plugins",
		"entries",
		"acpx",
		"config",
		"mcpServers",
		"*",
		"env",
		"*"
	])) return true;
	if (isRawEnvMapValuePath(path)) return false;
	if (isSecretInputKey(key)) return true;
	return matchesConfigPath(path, [
		"models",
		"providers",
		"*",
		"headers",
		"*"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"models",
		"providers",
		"*"
	]) || isMediaConfiguredProviderRequestSecretPath(path) || matchesConfigPath(path, [
		"agents",
		"defaults",
		"memorySearch",
		"remote",
		"headers",
		"*"
	]) || matchesConfigPath(path, [
		"diagnostics",
		"otel",
		"headers",
		"*"
	]);
}
function isRawEnvMapValuePath(path) {
	return path.length >= 2 && path.at(-2) === "env";
}
function isMediaConfiguredProviderRequestSecretPath(path) {
	return isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"models",
		"#"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"audio"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"audio",
		"models",
		"#"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"image"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"image",
		"models",
		"#"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"video"
	]) || isConfiguredProviderRequestSecretPath(path, [
		"tools",
		"media",
		"video",
		"models",
		"#"
	]);
}
function pushAgentWorkspaceEvidence(entries, params) {
	const explicitSandboxMode = readString(params.sandbox.mode);
	const inheritedSandboxMode = readString(params.inheritedSandbox.mode);
	const sandboxMode = explicitSandboxMode ?? inheritedSandboxMode ?? "off";
	const sandboxModeCoversAgentMain = sandboxMode === "all";
	const sandboxModeSource = explicitSandboxMode !== void 0 ? `${params.workspaceSourceBase}/sandbox/mode` : inheritedSandboxMode !== void 0 ? `${params.inheritedWorkspaceSourceBase}/sandbox/mode` : "oc://openclaw.config/agents/defaults/sandbox/mode";
	const explicitWorkspaceAccess = readString(params.sandbox.workspaceAccess);
	const inheritedWorkspaceAccess = readString(params.inheritedSandbox.workspaceAccess);
	entries.push({
		id: `${params.id}-workspace-access`,
		kind: "workspaceAccess",
		source: explicitWorkspaceAccess !== void 0 ? `${params.workspaceSourceBase}/sandbox/workspaceAccess` : inheritedWorkspaceAccess !== void 0 ? `${params.inheritedWorkspaceSourceBase}/sandbox/workspaceAccess` : "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
		scope: params.scope,
		...params.agentId === void 0 ? {} : { agentId: params.agentId },
		value: explicitWorkspaceAccess ?? inheritedWorkspaceAccess ?? "none",
		sandboxMode,
		sandboxModeSource,
		sandboxEnabled: sandboxModeCoversAgentMain,
		explicit: explicitWorkspaceAccess !== void 0
	});
	for (const tool of AGENT_WORKSPACE_POLICY_TOOLS) {
		const denyEvidence = agentWorkspaceToolDenyEvidence(params, tool, sandboxModeCoversAgentMain);
		entries.push({
			id: `${params.id}-tool-${tool}`,
			kind: "toolDeny",
			source: denyEvidence.source,
			scope: params.scope,
			...params.agentId === void 0 ? {} : { agentId: params.agentId },
			tool,
			denied: denyEvidence.denied,
			explicit: denyEvidence.denied
		});
	}
}
function agentWorkspaceToolDenyEvidence(params, tool, sandboxModeCoversAgentMain) {
	const localSandboxToolDeny = configuredSandboxToolDenyEntries(params.tools);
	const inheritedSandboxToolDeny = configuredSandboxToolDenyEntries(params.inheritedTools);
	const match = [
		{
			entries: readStringArray(params.tools.deny),
			source: `${params.toolsSourceBase}/deny`
		},
		{
			entries: readStringArray(params.inheritedTools.deny),
			source: `${params.inheritedToolsSourceBase}/deny`
		},
		...sandboxModeCoversAgentMain ? [localSandboxToolDeny !== void 0 ? {
			entries: localSandboxToolDeny,
			source: `${params.toolsSourceBase}/sandbox/tools/deny`
		} : {
			entries: inheritedSandboxToolDeny ?? [],
			source: `${params.inheritedToolsSourceBase}/sandbox/tools/deny`
		}] : []
	].find((entry) => toolListCoversTool(entry.entries, tool));
	if (match !== void 0) return {
		denied: true,
		source: match.source
	};
	return {
		denied: false,
		source: `${params.toolsSourceBase}/deny`
	};
}
function configuredSandboxToolDenyEntries(tools) {
	const sandbox = isRecord$1(tools.sandbox) ? tools.sandbox : {};
	const sandboxTools = isRecord$1(sandbox.tools) ? sandbox.tools : {};
	return Array.isArray(sandboxTools.deny) ? readStringArray(sandboxTools.deny) : void 0;
}
const AGENT_WORKSPACE_POLICY_TOOLS = [
	"exec",
	"process",
	"write",
	"edit",
	"apply_patch"
];
const POLICY_TOOL_GROUPS = {
	"group:fs": [
		"read",
		"write",
		"edit",
		"apply_patch"
	],
	"group:runtime": [
		"exec",
		"process",
		"code_execution"
	]
};
function readString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function readStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
function normalizePolicyToolName(value) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "bash") return "exec";
	if (normalized === "apply-patch") return "apply_patch";
	return normalized;
}
function policyToolGlobMatches(tool, pattern) {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(tool);
}
function toolListCoversTool(list, tool) {
	for (const entry of list) {
		const normalized = normalizePolicyToolName(entry);
		if (normalized === "*" || normalized === tool) return true;
		if (POLICY_TOOL_GROUPS[normalized]?.includes(tool)) return true;
		if (normalized.includes("*") && policyToolGlobMatches(tool, normalized)) return true;
	}
	return false;
}
function isConfiguredProviderRequestSecretPath(path, prefix) {
	if (path.length < prefix.length + 3) return false;
	if (!matchesConfigPathPrefix(path, prefix)) return false;
	const requestIndex = prefix.length;
	if (path[requestIndex] !== "request") return false;
	const suffix = path.slice(requestIndex + 1);
	if (suffix.length === 2 && suffix[0] === "headers") return true;
	if (suffix.length === 2 && suffix[0] === "auth" && isConfiguredProviderAuthSecretKey(suffix[1])) return true;
	if (suffix.length === 2 && suffix[0] === "tls" && isConfiguredProviderTlsSecretKey(suffix[1])) return true;
	return suffix.length === 3 && suffix[0] === "proxy" && suffix[1] === "tls" && isConfiguredProviderTlsSecretKey(suffix[2]);
}
function matchesConfigPathPrefix(path, prefix) {
	if (path.length < prefix.length) return false;
	return prefix.every((segment, index) => {
		const value = path[index];
		if (segment === "*") return value !== void 0 && value !== "";
		if (segment === "#") return value?.startsWith("#") ?? false;
		return value === segment;
	});
}
function matchesConfigPath(path, pattern) {
	return path.length === pattern.length && matchesConfigPathPrefix(path, pattern);
}
function isConfiguredProviderTlsSecretKey(key) {
	return key === "ca" || key === "cert" || key === "key" || key === "passphrase";
}
function isConfiguredProviderAuthSecretKey(key) {
	return key === "token" || key === "value";
}
function isSecretInputKey(key) {
	const normalized = key.toLowerCase();
	return normalized === "apikey" || normalized === "keyref" || normalized === "token" || normalized === "tokenref" || normalized === "password" || normalized === "secret" || normalized === "encryptkey" || normalized === "webhooksecret" || normalized === "serviceaccount" || normalized === "serviceaccountref" || normalized === "privatekey" || normalized === "certificate" || normalized === "certificatedata" || normalized === "identitydata" || normalized === "knownhosts" || normalized === "knownhostsdata" || normalized.endsWith("apikey") || normalized.endsWith("token") || normalized.endsWith("secret") || normalized.endsWith("password");
}
function secretRefDefaults(value) {
	if (!isRecord$1(value)) return;
	const defaults = {};
	if (typeof value.env === "string") defaults.env = value.env;
	if (typeof value.file === "string") defaults.file = value.file;
	if (typeof value.exec === "string") defaults.exec = value.exec;
	return defaults;
}
function secretRefEvidence(value, defaults) {
	const ref = coerceSecretRef(value, defaults);
	return ref === null ? void 0 : {
		source: ref.source,
		provider: ref.provider,
		id: ref.id
	};
}
function secretProviderInsecureFlags(value) {
	if (!isRecord$1(value)) return [];
	return [...value.allowInsecurePath === true ? ["allowInsecurePath"] : [], ...value.allowSymlinkCommand === true ? ["allowSymlinkCommand"] : []];
}
function isValidAuthProfileMetadata(value) {
	if (!isRecord$1(value)) return false;
	return typeof value.provider === "string" && value.provider.trim() !== "" && isAuthProfileMode(value.mode);
}
function isAuthProfileMode(value) {
	return value === "api_key" || value === "aws-sdk" || value === "oauth" || value === "token";
}
function scanPolicyTools(raw) {
	return Promise.resolve(scanPolicyToolHeaders(raw));
}
function scanPolicyToolHeaders(raw) {
	const section = markdownSectionLines(raw, "tools");
	if (section.length === 0) return [];
	const tools = [];
	for (let index = 0; index < section.length; index += 1) {
		const line = section[index]?.text ?? "";
		const heading = /^###\s+([^\s#]+)(.*)$/.exec(line);
		const bullet = /^[-*+]\s+([^:\s][^:]*?)\s*:(.*)$/.exec(line);
		const match = heading ?? bullet;
		if (match === null || slugify(match[1]).length === 0) continue;
		const id = slugify(match[1]);
		const entry = {
			id,
			source: `oc://TOOLS.md/tools/${id}`,
			line: section[index]?.line ?? index + 1
		};
		const metaLines = [match[2] ?? ""];
		for (let metaIndex = index + 1; metaIndex < section.length; metaIndex += 1) {
			const metaLine = section[metaIndex]?.text ?? "";
			if (/^###\s+\S+/.test(metaLine.trim()) || /^[-*+]\s+[^:\s][^:]*?\s*:/.test(metaLine)) break;
			metaLines.push(metaLine);
		}
		const meta = metaLines.join("\n");
		const risk = riskFromMeta(meta);
		const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
		const owner = /\bowner\s*:\s*([^\s#]+)\b/i.exec(meta)?.[1];
		const capabilities = capabilityTokensFromMetaLines(metaLines);
		if (risk !== void 0) entry.risk = risk;
		if (sensitivity !== void 0) entry.sensitivity = sensitivity;
		if (owner !== void 0) entry.owner = owner;
		if (capabilities.length > 0) entry.capabilities = capabilities;
		tools.push(entry);
	}
	return tools;
}
function markdownSectionLines(raw, sectionSlug) {
	const lines = raw.split(/\r?\n/);
	let sectionDepth;
	const section = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading !== null) {
			const depth = heading[1]?.length ?? 0;
			const slug = slugify(heading[2] ?? "");
			if (sectionDepth !== void 0 && depth <= sectionDepth) break;
			if (sectionDepth !== void 0) {
				section.push({
					line: index + 1,
					text: line
				});
				continue;
			}
			if (sectionDepth === void 0 && slug === sectionSlug) sectionDepth = depth;
			continue;
		}
		if (sectionDepth !== void 0) section.push({
			line: index + 1,
			text: line
		});
	}
	return section;
}
function slugify(text) {
	return text.toLowerCase().replace(/_/g, "-").replace(NON_SLUG_CHARS, "-").replace(COLLAPSE_HYPHENS, "-").replace(TRIM_HYPHENS, "");
}
function riskFromMeta(meta) {
	const namedRisk = /\brisk\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1];
	if (namedRisk !== void 0) return namedRisk.toLowerCase();
	switch (/\bR([0-5])\b/.exec(meta)?.[1]) {
		case "0":
		case "1": return "low";
		case "2":
		case "3": return "medium";
		case "4": return "high";
		case "5": return "critical";
		default: return;
	}
}
function capabilityTokensFromMetaLines(lines) {
	return lines.flatMap((line, index) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return [];
		const tokens = trimmed.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
		if (index === 0 || /\bcapabilities\s*:/i.test(trimmed)) return tokens;
		const withoutTokens = tokens.reduce((remaining, token) => {
			return remaining.replace(token, "");
		}, trimmed);
		return /^[\s,;:[\](){}#*_-]*$/.test(withoutTokens) ? tokens : [];
	});
}
function configuredChannels(cfg) {
	return isRecord$1(cfg.channels) ? cfg.channels : {};
}
function configuredMcpServers(cfg) {
	return isRecord$1(cfg.mcp) && isRecord$1(cfg.mcp.servers) ? cfg.mcp.servers : {};
}
function mcpServerTransport(value) {
	if (!isRecord$1(value)) return "unknown";
	if (typeof value.command === "string") return "stdio";
	if (value.transport === "sse" || value.transport === "streamable-http") return value.transport;
	if (typeof value.url === "string") return "streamable-http";
	return "unknown";
}
function redactMcpUrlForEvidence(raw) {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}`;
	} catch {
		return "[redacted-url]";
	}
}
function configuredModelProviders(cfg) {
	return isRecord$1(cfg.models) && isRecord$1(cfg.models.providers) ? cfg.models.providers : {};
}
function networkBooleanEvidence(cfg, id, path, source) {
	const value = readBooleanPath(cfg, path);
	return value === void 0 ? void 0 : {
		id,
		source,
		value
	};
}
function pushGatewayBooleanEvidence(entries, id, kind, value, source) {
	if (typeof value !== "boolean") return;
	entries.push({
		id,
		kind,
		source,
		value
	});
}
function pushGatewayHttpEndpointEvidence(entries, endpoints, endpoint) {
	const config = endpoints[endpoint];
	if (!isRecord$1(config)) return;
	const source = `oc://openclaw.config/gateway/http/endpoints/${endpoint}`;
	const enabled = config.enabled === true;
	if (enabled) entries.push({
		id: `gateway-http-${endpoint}`,
		kind: "httpEndpoint",
		source: `${source}/enabled`,
		value: true,
		endpoint
	});
	if (!enabled) return;
	if (endpoint === "chatCompletions") {
		pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
		return;
	}
	pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["files"], config.files);
	pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
}
function pushGatewayHttpUrlFetchEvidence(entries, endpointSource, endpoint, path, value) {
	const allowUrl = isRecord$1(value) ? value.allowUrl : void 0;
	if (allowUrl === false || allowUrl !== true && endpoint !== "responses") return;
	const allowlist = isRecord$1(value) ? value.urlAllowlist : void 0;
	const hasEffectiveAllowlist = Array.isArray(allowlist) && allowlist.some((entry) => isEffectiveGatewayUrlAllowlistEntry(entry));
	entries.push({
		id: `gateway-http-${endpoint}-${path.join("-")}-url-fetch`,
		kind: "httpUrlFetch",
		source: `${endpointSource}/${path.map(ocPathSegment).join("/")}/allowUrl`,
		value: true,
		endpoint,
		explicit: allowUrl === true,
		hasAllowlist: hasEffectiveAllowlist
	});
}
function isEffectiveGatewayUrlAllowlistEntry(value) {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "*" && normalized !== "*.";
}
function isGatewayNonLoopbackBind(value) {
	return value === "auto" || value === "lan" || value === "custom" || value === "tailnet";
}
function isRuntimeNonLoopbackCustomBindHost(value) {
	const normalized = value.trim().toLowerCase();
	return isCanonicalDottedDecimalIPv4(normalized) && !normalized.startsWith("127.");
}
function isCanonicalDottedDecimalIPv4(value) {
	return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value);
}
function readBooleanPath(value, path) {
	let current = value;
	for (const part of path) {
		if (!isRecord$1(current)) return;
		current = current[part];
	}
	return typeof current === "boolean" ? current : void 0;
}
function collectModelRefsFromValue(refs, value, source) {
	if (typeof value === "string") {
		pushModelRef(refs, value, source);
		return;
	}
	if (!isRecord$1(value)) return;
	if (typeof value.primary === "string") pushModelRef(refs, value.primary, `${source}/primary`);
	if (Array.isArray(value.fallbacks)) {
		for (const [index, fallback] of value.fallbacks.entries()) if (typeof fallback === "string") pushModelRef(refs, fallback, `${source}/fallbacks/#${index}`);
	}
}
function collectModelRefsFromRecord(refs, value, source) {
	for (const [key, child] of Object.entries(value)) {
		const childPath = `${source}/${key}`;
		if (isModelSettingKey(key)) {
			collectModelRefsFromValue(refs, child, childPath);
			continue;
		}
		if (Array.isArray(child)) {
			for (const [index, item] of child.entries()) if (isRecord$1(item)) collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
			continue;
		}
		if (isRecord$1(child)) collectModelRefsFromRecord(refs, child, childPath);
	}
}
function collectModelRefsFromAgentAllowlist(refs, agents) {
	const defaults = agents.defaults;
	if (isRecord$1(defaults) && isRecord$1(defaults.models)) collectModelRefsFromModelMap(refs, defaults.models, "oc://openclaw.config/agents/defaults/models");
	const list = agents.list;
	if (!Array.isArray(list)) return;
	for (const [index, agent] of list.entries()) {
		if (!isRecord$1(agent) || !isRecord$1(agent.models)) continue;
		collectModelRefsFromModelMap(refs, agent.models, `oc://openclaw.config/agents/list/#${index}/models`);
	}
}
function collectModelRefsFromModelMap(refs, models, source) {
	for (const ref of Object.keys(models)) pushModelRef(refs, ref, `${source}/${ocPathSegment(ref)}`);
}
function isModelSettingKey(key) {
	return key === "model" || key.endsWith("Model");
}
function ocPathSegment(value) {
	if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) return value;
	if (value.includes("\"") || value.includes("\\")) return value;
	return `"${value}"`;
}
function pushModelRef(refs, ref, source) {
	const parsed = parseModelRef(ref);
	if (parsed === void 0) return;
	refs.push({
		ref,
		provider: parsed.provider,
		model: parsed.model,
		source
	});
}
function parseModelRef(ref) {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return;
	return {
		provider: normalizeProviderId(trimmed.slice(0, slash)),
		model: trimmed.slice(slash + 1)
	};
}
function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord$1(value)) return `{${Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
	return JSON.stringify(value);
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region extensions/policy/src/doctor/register.ts
const CHECK_IDS = {
	policyAttestationMismatch: "policy/attestation-hash-mismatch",
	policyDeniedChannelProvider: "policy/channels-denied-provider",
	policyHashMismatch: "policy/policy-hash-mismatch",
	policyInvalidFile: "policy/policy-jsonc-invalid",
	policyMissingFile: "policy/policy-jsonc-missing",
	policyDeniedMcpServer: "policy/mcp-denied-server",
	policyUnapprovedMcpServer: "policy/mcp-unapproved-server",
	policyDeniedModelProvider: "policy/models-denied-provider",
	policyUnapprovedModelProvider: "policy/models-unapproved-provider",
	policyPrivateNetworkAccess: "policy/network-private-access-enabled",
	policyGatewayNonLoopbackBind: "policy/gateway-non-loopback-bind",
	policyGatewayAuthDisabled: "policy/gateway-auth-disabled",
	policyGatewayRateLimitMissing: "policy/gateway-rate-limit-missing",
	policyGatewayControlUiInsecure: "policy/gateway-control-ui-insecure",
	policyGatewayTailscaleFunnel: "policy/gateway-tailscale-funnel",
	policyGatewayRemoteEnabled: "policy/gateway-remote-enabled",
	policyGatewayHttpEndpointEnabled: "policy/gateway-http-endpoint-enabled",
	policyGatewayHttpUrlFetchUnrestricted: "policy/gateway-http-url-fetch-unrestricted",
	policyAgentsWorkspaceAccessDenied: "policy/agents-workspace-access-denied",
	policyAgentsToolNotDenied: "policy/agents-tool-not-denied",
	policySecretsUnmanagedProvider: "policy/secrets-unmanaged-provider",
	policySecretsDeniedProviderSource: "policy/secrets-denied-provider-source",
	policySecretsInsecureProvider: "policy/secrets-insecure-provider",
	policyAuthProfileInvalidMetadata: "policy/auth-profile-invalid-metadata",
	policyAuthProfileUnapprovedMode: "policy/auth-profile-unapproved-mode",
	policyMissingToolOwner: "policy/tools-missing-owner",
	policyMissingToolRisk: "policy/tools-missing-risk-level",
	policyMissingToolSensitivity: "policy/tools-missing-sensitivity-token",
	policyUnknownToolRisk: "policy/tools-unknown-risk-level",
	policyUnknownToolSensitivity: "policy/tools-unknown-sensitivity-token"
};
const POLICY_CHECK_IDS = [
	CHECK_IDS.policyMissingFile,
	CHECK_IDS.policyInvalidFile,
	CHECK_IDS.policyHashMismatch,
	CHECK_IDS.policyAttestationMismatch,
	CHECK_IDS.policyDeniedChannelProvider,
	CHECK_IDS.policyDeniedMcpServer,
	CHECK_IDS.policyUnapprovedMcpServer,
	CHECK_IDS.policyDeniedModelProvider,
	CHECK_IDS.policyUnapprovedModelProvider,
	CHECK_IDS.policyPrivateNetworkAccess,
	CHECK_IDS.policyGatewayNonLoopbackBind,
	CHECK_IDS.policyGatewayAuthDisabled,
	CHECK_IDS.policyGatewayRateLimitMissing,
	CHECK_IDS.policyGatewayControlUiInsecure,
	CHECK_IDS.policyGatewayTailscaleFunnel,
	CHECK_IDS.policyGatewayRemoteEnabled,
	CHECK_IDS.policyGatewayHttpEndpointEnabled,
	CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
	CHECK_IDS.policyAgentsWorkspaceAccessDenied,
	CHECK_IDS.policyAgentsToolNotDenied,
	CHECK_IDS.policySecretsUnmanagedProvider,
	CHECK_IDS.policySecretsDeniedProviderSource,
	CHECK_IDS.policySecretsInsecureProvider,
	CHECK_IDS.policyAuthProfileInvalidMetadata,
	CHECK_IDS.policyAuthProfileUnapprovedMode,
	CHECK_IDS.policyMissingToolRisk,
	CHECK_IDS.policyUnknownToolRisk,
	CHECK_IDS.policyMissingToolSensitivity,
	CHECK_IDS.policyMissingToolOwner,
	CHECK_IDS.policyUnknownToolSensitivity
];
const KNOWN_RISK_LEVELS = [
	"low",
	"medium",
	"high",
	"critical"
];
const KNOWN_SENSITIVITY_LEVELS = [
	"public",
	"internal",
	"confidential",
	"restricted"
];
const SUPPORTED_TOOL_METADATA = [
	"risk",
	"sensitivity",
	"owner"
];
const SUPPORTED_AUTH_PROFILE_METADATA = ["provider", "mode"];
const SUPPORTED_AUTH_PROFILE_MODES = [
	"api_key",
	"aws-sdk",
	"oauth",
	"token"
];
const SUPPORTED_GATEWAY_HTTP_ENDPOINTS = ["chatCompletions", "responses"];
const SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS = [
	"exec",
	"process",
	"write",
	"edit",
	"apply_patch"
];
let registered = false;
const policyEvaluationCache = /* @__PURE__ */ new WeakMap();
function registerPolicyDoctorChecks(host) {
	if (registered) return;
	const registerHealthCheck$1 = host?.registerHealthCheck ?? registerHealthCheck;
	registerHealthCheck$1(policyMissingFileCheck);
	registerHealthCheck$1(policyInvalidFileCheck);
	registerHealthCheck$1(policyHashMismatchCheck);
	registerHealthCheck$1(policyAttestationMismatchCheck);
	registerHealthCheck$1(policyChannelsDeniedProviderCheck);
	registerHealthCheck$1(policyMcpDeniedServerCheck);
	registerHealthCheck$1(policyMcpUnapprovedServerCheck);
	registerHealthCheck$1(policyModelsDeniedProviderCheck);
	registerHealthCheck$1(policyModelsUnapprovedProviderCheck);
	registerHealthCheck$1(policyNetworkPrivateAccessCheck);
	registerHealthCheck$1(policyGatewayNonLoopbackBindCheck);
	registerHealthCheck$1(policyGatewayAuthDisabledCheck);
	registerHealthCheck$1(policyGatewayRateLimitMissingCheck);
	registerHealthCheck$1(policyGatewayControlUiInsecureCheck);
	registerHealthCheck$1(policyGatewayTailscaleFunnelCheck);
	registerHealthCheck$1(policyGatewayRemoteEnabledCheck);
	registerHealthCheck$1(policyGatewayHttpEndpointEnabledCheck);
	registerHealthCheck$1(policyGatewayHttpUrlFetchUnrestrictedCheck);
	registerHealthCheck$1(policyAgentsWorkspaceAccessDeniedCheck);
	registerHealthCheck$1(policyAgentsToolNotDeniedCheck);
	registerHealthCheck$1(policySecretsUnmanagedProviderCheck);
	registerHealthCheck$1(policySecretsDeniedProviderSourceCheck);
	registerHealthCheck$1(policySecretsInsecureProviderCheck);
	registerHealthCheck$1(policyAuthProfileInvalidMetadataCheck);
	registerHealthCheck$1(policyAuthProfileUnapprovedModeCheck);
	registerHealthCheck$1(policyToolsMissingRiskCheck);
	registerHealthCheck$1(policyToolsUnknownRiskCheck);
	registerHealthCheck$1(policyToolsMissingSensitivityCheck);
	registerHealthCheck$1(policyToolsMissingOwnerCheck);
	registerHealthCheck$1(policyToolsUnknownSensitivityCheck);
	registered = true;
}
function evaluatePolicy(ctx) {
	const cached = policyEvaluationCache.get(ctx);
	if (cached !== void 0) return cached;
	const next = evaluatePolicyUncached(ctx);
	policyEvaluationCache.set(ctx, next);
	return next;
}
const policyMissingFileCheck = {
	id: CHECK_IDS.policyMissingFile,
	kind: "plugin",
	description: "The enabled Policy plugin has a policy file to verify.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
	}
};
const policyHashMismatchCheck = {
	id: CHECK_IDS.policyHashMismatch,
	kind: "plugin",
	description: "The policy file matches the configured expected hash.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
	}
};
const policyAttestationMismatchCheck = {
	id: CHECK_IDS.policyAttestationMismatch,
	kind: "plugin",
	description: "The current policy check matches the accepted attestation.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAttestationMismatch);
	}
};
const policyInvalidFileCheck = {
	id: CHECK_IDS.policyInvalidFile,
	kind: "plugin",
	description: "The enabled policy file parses before policy checks run.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyInvalidFile);
	}
};
const policyChannelsDeniedProviderCheck = {
	id: CHECK_IDS.policyDeniedChannelProvider,
	kind: "plugin",
	description: "Configured channels satisfy policy deny rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
	},
	async repair(ctx, findings) {
		if (!workspaceRepairsEnabled(ctx)) return workspaceRepairsDisabledResult("channel config");
		const channelIds = channelIdsFromFindings(findings);
		if (channelIds.length === 0) return {
			status: "skipped",
			reason: "no channel findings matched a configurable channel",
			changes: []
		};
		const next = disableChannels(ctx.cfg, channelIds);
		if (next.changed.length === 0) return {
			status: "skipped",
			reason: "matching channels were already disabled or missing",
			changes: []
		};
		return {
			config: next.config,
			changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`)
		};
	}
};
const policyMcpDeniedServerCheck = {
	id: CHECK_IDS.policyDeniedMcpServer,
	kind: "plugin",
	description: "Configured MCP servers do not match policy deny rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedMcpServer);
	}
};
const policyMcpUnapprovedServerCheck = {
	id: CHECK_IDS.policyUnapprovedMcpServer,
	kind: "plugin",
	description: "Configured MCP servers do not match policy allow rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedMcpServer);
	}
};
const policyModelsDeniedProviderCheck = {
	id: CHECK_IDS.policyDeniedModelProvider,
	kind: "plugin",
	description: "Configured model providers do not match policy deny rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedModelProvider);
	}
};
const policyModelsUnapprovedProviderCheck = {
	id: CHECK_IDS.policyUnapprovedModelProvider,
	kind: "plugin",
	description: "Configured model providers do not match policy allow rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedModelProvider);
	}
};
const policyNetworkPrivateAccessCheck = {
	id: CHECK_IDS.policyPrivateNetworkAccess,
	kind: "plugin",
	description: "Network SSRF policy settings match private-network requirements.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyPrivateNetworkAccess);
	}
};
const policyGatewayNonLoopbackBindCheck = {
	id: CHECK_IDS.policyGatewayNonLoopbackBind,
	kind: "plugin",
	description: "Gateway bind posture matches policy exposure requirements.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayNonLoopbackBind);
	}
};
const policyGatewayAuthDisabledCheck = {
	id: CHECK_IDS.policyGatewayAuthDisabled,
	kind: "plugin",
	description: "Gateway authentication remains enabled when required by policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayAuthDisabled);
	}
};
const policyGatewayRateLimitMissingCheck = {
	id: CHECK_IDS.policyGatewayRateLimitMissing,
	kind: "plugin",
	description: "Gateway authentication rate-limit posture is explicit when required by policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayRateLimitMissing);
	}
};
const policyGatewayControlUiInsecureCheck = {
	id: CHECK_IDS.policyGatewayControlUiInsecure,
	kind: "plugin",
	description: "Gateway Control UI insecure exposure toggles remain disabled by policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayControlUiInsecure);
	}
};
const policyGatewayTailscaleFunnelCheck = {
	id: CHECK_IDS.policyGatewayTailscaleFunnel,
	kind: "plugin",
	description: "Gateway Tailscale Funnel exposure matches policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayTailscaleFunnel);
	}
};
const policyGatewayRemoteEnabledCheck = {
	id: CHECK_IDS.policyGatewayRemoteEnabled,
	kind: "plugin",
	description: "Remote gateway mode matches policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayRemoteEnabled);
	}
};
const policyGatewayHttpEndpointEnabledCheck = {
	id: CHECK_IDS.policyGatewayHttpEndpointEnabled,
	kind: "plugin",
	description: "Gateway HTTP API endpoints match policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayHttpEndpointEnabled);
	}
};
const policyGatewayHttpUrlFetchUnrestrictedCheck = {
	id: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
	kind: "plugin",
	description: "Gateway HTTP URL-fetch inputs have allowlists when required by policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted);
	}
};
const policyAgentsWorkspaceAccessDeniedCheck = {
	id: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
	kind: "plugin",
	description: "Agent sandbox workspace access matches policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAgentsWorkspaceAccessDenied);
	}
};
const policyAgentsToolNotDeniedCheck = {
	id: CHECK_IDS.policyAgentsToolNotDenied,
	kind: "plugin",
	description: "Agent workspace mutation/runtime tools are denied when policy requires it.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAgentsToolNotDenied);
	}
};
const policySecretsUnmanagedProviderCheck = {
	id: CHECK_IDS.policySecretsUnmanagedProvider,
	kind: "plugin",
	description: "OpenClaw config SecretRefs use configured secret providers when policy requires managed providers.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsUnmanagedProvider);
	}
};
const policySecretsDeniedProviderSourceCheck = {
	id: CHECK_IDS.policySecretsDeniedProviderSource,
	kind: "plugin",
	description: "OpenClaw config secret providers and SecretRefs do not use sources denied by policy.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsDeniedProviderSource);
	}
};
const policySecretsInsecureProviderCheck = {
	id: CHECK_IDS.policySecretsInsecureProvider,
	kind: "plugin",
	description: "Configured secret providers do not opt into insecure posture unless policy allows it.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsInsecureProvider);
	}
};
const policyAuthProfileInvalidMetadataCheck = {
	id: CHECK_IDS.policyAuthProfileInvalidMetadata,
	kind: "plugin",
	description: "OpenClaw config auth profiles declare required provider and mode metadata.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAuthProfileInvalidMetadata);
	}
};
const policyAuthProfileUnapprovedModeCheck = {
	id: CHECK_IDS.policyAuthProfileUnapprovedMode,
	kind: "plugin",
	description: "OpenClaw config auth profile modes stay within the policy allowlist.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAuthProfileUnapprovedMode);
	}
};
const policyToolsMissingRiskCheck = {
	id: CHECK_IDS.policyMissingToolRisk,
	kind: "plugin",
	description: "TOOLS.md policy entries declare explicit risk levels.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolRisk);
	}
};
const policyToolsUnknownRiskCheck = {
	id: CHECK_IDS.policyUnknownToolRisk,
	kind: "plugin",
	description: "TOOLS.md policy entries use known risk levels.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolRisk);
	}
};
const policyToolsMissingSensitivityCheck = {
	id: CHECK_IDS.policyMissingToolSensitivity,
	kind: "plugin",
	description: "TOOLS.md policy entries declare default artifact sensitivity.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolSensitivity);
	}
};
const policyToolsUnknownSensitivityCheck = {
	id: CHECK_IDS.policyUnknownToolSensitivity,
	kind: "plugin",
	description: "TOOLS.md policy entries use known sensitivity levels.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolSensitivity);
	}
};
const policyToolsMissingOwnerCheck = {
	id: CHECK_IDS.policyMissingToolOwner,
	kind: "plugin",
	description: "TOOLS.md policy entries declare an accountable owner.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolOwner);
	}
};
async function evaluatePolicyUncached(ctx) {
	const settings = policySettings(ctx);
	const policyPath = policyDisplayName(ctx);
	let evidence = collectPolicyEvidence(ctx.cfg, {
		includeGatewayExposure: false,
		includeAgentWorkspace: false,
		includeSecrets: false,
		includeAuthProfiles: false
	});
	const findings = [];
	if (!policyChecksEnabled(ctx, settings)) return {
		policyPath,
		evidence,
		expectedAttestationHash: settings.expectedAttestationHash,
		findings,
		attestedFindings: findings
	};
	const policyFile = await readPolicyFile(ctx);
	if (policyFile === null) {
		findings.push({
			checkId: CHECK_IDS.policyMissingFile,
			severity: "warning",
			message: `${policyPath} is missing for the enabled Policy plugin.`,
			source: "policy",
			path: policyPath,
			fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`
		});
		return {
			policyPath,
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const parsedPolicy = parsePolicyFile(policyFile.raw);
	if (!parsedPolicy.ok) {
		findings.push(policyParseFinding(policyFile.displayName, policyFile.ocDocName, parsedPolicy));
		return {
			policyPath,
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const policy = parsedPolicy.value;
	const policyHash = policyDocumentHash(policy);
	const expectedHash = settings.expectedHash;
	if (typeof expectedHash === "string" && expectedHash.trim() !== "" && policyHash !== expectedHash.trim()) {
		findings.push({
			checkId: CHECK_IDS.policyHashMismatch,
			severity: "error",
			message: `${policyFile.displayName} does not match the configured policy hash.`,
			source: "policy",
			path: policyFile.displayName,
			target: `oc://${policyFile.ocDocName}`,
			requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
			fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`
		});
		return {
			policyPath,
			policy: {
				value: policy,
				hash: policyHash
			},
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const metadataRequirementFindings = toolMetadataRequirementFindings(policy, policyFile.displayName, policyFile.ocDocName);
	const authMetadataRequirementFindings = authProfileMetadataRequirementFindings(policy, policyFile.displayName, policyFile.ocDocName);
	const requiredMetadata = metadataRequirementFindings.length === 0 ? requiredToolMetadata(policy) : /* @__PURE__ */ new Set();
	const includeSecrets = policyHasSecretRules(policy);
	const includeAuthProfiles = policyHasAuthProfileRules(policy);
	const includeGatewayExposure = policyHasGatewayRules(policy);
	const includeAgentWorkspace = policyHasAgentWorkspaceRules(policy);
	if (requiredMetadata.size > 0) {
		const toolsFile = await readWorkspaceFile(ctx, "TOOLS.md");
		evidence = await collectPolicyEvidence(ctx.cfg, {
			toolsRaw: toolsFile?.raw ?? "",
			includeGatewayExposure,
			includeAgentWorkspace,
			includeSecrets,
			includeAuthProfiles
		});
	} else evidence = collectPolicyEvidence(ctx.cfg, {
		includeGatewayExposure,
		includeAgentWorkspace,
		includeSecrets,
		includeAuthProfiles
	});
	const policyFindings = [
		...policyContainerShapeFindings(policy, policyFile.displayName, policyFile.ocDocName),
		...channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
		...mcpServerFindings(policy, policyFile.ocDocName, evidence),
		...modelProviderFindings(policy, policyFile.ocDocName, evidence),
		...networkFindings(policy, policyFile.ocDocName, evidence),
		...gatewayExposureFindings(policy, policyFile.ocDocName, evidence),
		...agentWorkspaceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
		...secretAuthProvenanceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
		...authMetadataRequirementFindings,
		...metadataRequirementFindings
	];
	if (requiredMetadata.has("risk")) {
		policyFindings.push(...toolRiskFindings(policyFile.ocDocName, evidence));
		policyFindings.push(...toolUnknownRiskFindings(policyFile.ocDocName, evidence));
	}
	if (requiredMetadata.has("sensitivity")) policyFindings.push(...toolSensitivityFindings(policyFile.ocDocName, evidence));
	if (requiredMetadata.has("owner")) policyFindings.push(...toolOwnerFindings(policyFile.ocDocName, evidence));
	const attestationFindings = policyAttestationFindings(policyFile.displayName, policyHash, evidence, policyFindings, settings);
	if (hasPolicyValidationFinding(policyFindings)) findings.push(...policyFindings);
	else if (attestationFindings.length > 0) findings.push(...attestationFindings);
	else findings.push(...policyFindings);
	return {
		policyPath,
		policy: {
			value: policy,
			hash: policyHash
		},
		evidence,
		expectedAttestationHash: settings.expectedAttestationHash,
		findings,
		attestedFindings: policyFindings
	};
}
function policyParseFinding(policyPath, policyDocName, parseError) {
	return {
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} could not be parsed: ${parseError.message}`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}`,
		fixHint: `Fix ${policyPath} so policy conformance checks can run.`
	};
}
function findingsForCheck(evaluation, checkId) {
	return evaluation.findings.filter((finding) => finding.checkId === checkId);
}
function hasPolicyValidationFinding(findings) {
	return findings.some((finding) => finding.checkId === CHECK_IDS.policyInvalidFile);
}
function channelFindings(policy, policyPath, policyDocName, evidence) {
	const invalidRules = invalidChannelDenyRuleFindings(policy, policyPath, policyDocName);
	if (invalidRules.length > 0) return invalidRules;
	const denyRules = readChannelDenyRules(policy, policyDocName);
	if (denyRules.length === 0) return [];
	return evidence.channels.flatMap((channel) => {
		if (channel.enabled === false) return [];
		const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
		if (rule === void 0) return [];
		return [{
			checkId: CHECK_IDS.policyDeniedChannelProvider,
			severity: "error",
			message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
			source: "policy",
			path: "openclaw config",
			ocPath: channel.source,
			target: channel.source,
			requirement: rule.requirement,
			fixHint: rule.reason ?? "Disable this channel, remove it from config, or update the policy deny rule."
		}];
	});
}
function policyAttestationFindings(policyPath, policyHash, evidence, findings, settings) {
	const expected = settings.expectedAttestationHash?.trim();
	if (!expected) return [];
	const current = createPolicyAttestation({
		ok: findings.length === 0,
		checkedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
		policyPath,
		policyHash,
		evidence,
		findings: findings.map(toAttestedFinding)
	});
	if (current.attestationHash === expected) return [];
	return [{
		checkId: CHECK_IDS.policyAttestationMismatch,
		severity: "error",
		message: "The current policy check no longer matches the accepted policy attestation.",
		source: "policy",
		path: "policy attestation",
		target: "oc://policy/attestation/current",
		requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedAttestationHash",
		fixHint: `Run policy check, review attestation ${current.attestationHash}, then update plugins.entries.policy.config.expectedAttestationHash and the supervisor/gateway accepted attestation.`
	}];
}
function toAttestedFinding(finding) {
	return {
		checkId: finding.checkId,
		severity: finding.severity,
		message: finding.message,
		...finding.source !== void 0 ? { source: finding.source } : {},
		...finding.path !== void 0 ? { path: finding.path } : {},
		...finding.line !== void 0 ? { line: finding.line } : {},
		...finding.column !== void 0 ? { column: finding.column } : {},
		...finding.ocPath !== void 0 ? { ocPath: finding.ocPath } : {},
		...finding.target !== void 0 ? { target: finding.target } : {},
		...finding.requirement !== void 0 ? { requirement: finding.requirement } : {},
		...finding.fixHint !== void 0 ? { fixHint: finding.fixHint } : {}
	};
}
function toolMetadataRequirementFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.tools) || policy.tools.requireMetadata === void 0) return [];
	if (!Array.isArray(policy.tools.requireMetadata)) return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} tools.requireMetadata must be an array of metadata keys.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/tools/requireMetadata`,
		fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`
	}];
	const invalidIndex = policy.tools.requireMetadata.findIndex((entry) => typeof entry !== "string" || !SUPPORTED_TOOL_METADATA.includes(entry.trim().toLowerCase()));
	if (invalidIndex < 0) return [];
	return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} tools.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/tools/requireMetadata/#${invalidIndex}`,
		fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`
	}];
}
function policyContainerShapeFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy)) return [policyShapeFinding(policyPath, `oc://${policyDocName}`, `${policyPath} must contain a policy object.`, `Fix ${policyPath} so the top-level policy is an object.`)];
	if (policy.tools !== void 0 && !isRecord(policy.tools)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/tools`, `${policyPath} tools must be an object.`, `Fix ${policyPath} so tools is an object.`)];
	if (isRecord(policy.tools)) {
		if (policy.tools.settings !== void 0 && !isRecord(policy.tools.settings)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/tools/settings`, `${policyPath} tools.settings must be an object.`, `Fix ${policyPath} so tools.settings is an object.`)];
		if (policy.tools.entries !== void 0 && !Array.isArray(policy.tools.entries)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/tools/entries`, `${policyPath} tools.entries must be an array.`, `Fix ${policyPath} so tools.entries is an array.`)];
	}
	if (policy.channels !== void 0 && !isRecord(policy.channels)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/channels`, `${policyPath} channels must be an object.`, `Fix ${policyPath} so channels is an object.`)];
	if (policy.mcp !== void 0 && !isRecord(policy.mcp)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/mcp`, `${policyPath} mcp must be an object.`, `Fix ${policyPath} so mcp is an object.`)];
	if (isRecord(policy.mcp)) {
		const finding = policyStringArrayShapeFinding(policy.mcp.servers, {
			property: "mcp.servers",
			policyDocName,
			policyPath,
			target: "mcp/servers",
			valueName: "MCP server id"
		});
		if (finding !== void 0) return [finding];
	}
	if (policy.models !== void 0 && !isRecord(policy.models)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/models`, `${policyPath} models must be an object.`, `Fix ${policyPath} so models is an object.`)];
	if (isRecord(policy.models)) {
		const finding = policyStringArrayShapeFinding(policy.models.providers, {
			property: "models.providers",
			policyDocName,
			policyPath,
			target: "models/providers",
			valueName: "model provider id"
		});
		if (finding !== void 0) return [finding];
	}
	if (policy.network !== void 0 && !isRecord(policy.network)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/network`, `${policyPath} network must be an object.`, `Fix ${policyPath} so network is an object.`)];
	if (isRecord(policy.network)) {
		if (policy.network.privateNetwork !== void 0 && !isRecord(policy.network.privateNetwork)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/network/privateNetwork`, `${policyPath} network.privateNetwork must be an object.`, `Fix ${policyPath} so network.privateNetwork is an object.`)];
		if (isRecord(policy.network.privateNetwork) && policy.network.privateNetwork.allow !== void 0 && typeof policy.network.privateNetwork.allow !== "boolean") return [policyShapeFinding(policyPath, `oc://${policyDocName}/network/privateNetwork/allow`, `${policyPath} network.privateNetwork.allow must be a boolean.`, `Fix ${policyPath} so network.privateNetwork.allow is true or false.`)];
	}
	if (policy.secrets !== void 0 && !isRecord(policy.secrets)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/secrets`, `${policyPath} secrets must be an object.`, `Fix ${policyPath} so secrets is an object.`)];
	if (policy.auth !== void 0 && !isRecord(policy.auth)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/auth`, `${policyPath} auth must be an object.`, `Fix ${policyPath} so auth is an object.`)];
	if (isRecord(policy.auth) && policy.auth.profiles !== void 0 && !isRecord(policy.auth.profiles)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/auth/profiles`, `${policyPath} auth.profiles must be an object.`, `Fix ${policyPath} so auth.profiles is an object.`)];
	const gatewayFinding = gatewayPolicyShapeFinding(policy.gateway, {
		policyDocName,
		policyPath
	});
	if (gatewayFinding !== void 0) return [gatewayFinding];
	const agentsFinding = agentsPolicyShapeFinding(policy.agents, {
		policyDocName,
		policyPath
	});
	if (agentsFinding !== void 0) return [agentsFinding];
	return [];
}
function agentsPolicyShapeFinding(value, params) {
	if (value === void 0) return;
	if (!isRecord(value)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents`, `${params.policyPath} agents must be an object.`, `Fix ${params.policyPath} so agents is an object.`);
	if (value.workspace !== void 0 && !isRecord(value.workspace)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents/workspace`, `${params.policyPath} agents.workspace must be an object.`, `Fix ${params.policyPath} so agents.workspace is an object.`);
	const workspace = isRecord(value.workspace) ? value.workspace : {};
	const allowedAccess = workspace.allowedAccess;
	if (allowedAccess !== void 0 && !Array.isArray(allowedAccess)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents/workspace/allowedAccess`, `${params.policyPath} agents.workspace.allowedAccess must be an array.`, "Use workspace access values such as [\"none\", \"ro\"].");
	if (Array.isArray(allowedAccess)) {
		const invalidIndex = allowedAccess.findIndex((entry) => entry !== "none" && entry !== "ro" && entry !== "rw");
		if (invalidIndex >= 0) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents/workspace/allowedAccess/#${invalidIndex}`, `${params.policyPath} agents.workspace.allowedAccess[${invalidIndex}] must be none, ro, or rw.`, "Use workspace access values such as [\"none\", \"ro\"].");
	}
	const denyTools = workspace.denyTools;
	if (denyTools !== void 0 && !Array.isArray(denyTools)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents/workspace/denyTools`, `${params.policyPath} agents.workspace.denyTools must be an array.`, "Use tool ids such as [\"exec\", \"process\", \"write\", \"edit\", \"apply_patch\"].");
	if (Array.isArray(denyTools)) {
		const invalidIndex = denyTools.findIndex((entry) => typeof entry !== "string" || !SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.includes(entry.trim()));
		if (invalidIndex >= 0) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/agents/workspace/denyTools/#${invalidIndex}`, `${params.policyPath} agents.workspace.denyTools[${invalidIndex}] must be a supported agent workspace tool id.`, `Use supported tool ids: ${SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.join(", ")}.`);
	}
}
function gatewayPolicyShapeFinding(value, params) {
	if (value === void 0) return;
	if (!isRecord(value)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/gateway`, `${params.policyPath} gateway must be an object.`, `Fix ${params.policyPath} so gateway is an object.`);
	for (const section of [
		"exposure",
		"auth",
		"controlUi",
		"remote",
		"http"
	]) if (value[section] !== void 0 && !isRecord(value[section])) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/gateway/${section}`, `${params.policyPath} gateway.${section} must be an object.`, `Fix ${params.policyPath} so gateway.${section} is an object.`);
	const exposure = isRecord(value.exposure) ? value.exposure : {};
	const auth = isRecord(value.auth) ? value.auth : {};
	const controlUi = isRecord(value.controlUi) ? value.controlUi : {};
	const remote = isRecord(value.remote) ? value.remote : {};
	const http = isRecord(value.http) ? value.http : {};
	const booleanRules = [
		[
			"gateway/exposure/allowNonLoopbackBind",
			"gateway.exposure.allowNonLoopbackBind",
			exposure.allowNonLoopbackBind
		],
		[
			"gateway/exposure/allowTailscaleFunnel",
			"gateway.exposure.allowTailscaleFunnel",
			exposure.allowTailscaleFunnel
		],
		[
			"gateway/auth/requireAuth",
			"gateway.auth.requireAuth",
			auth.requireAuth
		],
		[
			"gateway/auth/requireExplicitRateLimit",
			"gateway.auth.requireExplicitRateLimit",
			auth.requireExplicitRateLimit
		],
		[
			"gateway/controlUi/allowInsecure",
			"gateway.controlUi.allowInsecure",
			controlUi.allowInsecure
		],
		[
			"gateway/remote/allow",
			"gateway.remote.allow",
			remote.allow
		],
		[
			"gateway/http/requireUrlAllowlists",
			"gateway.http.requireUrlAllowlists",
			http.requireUrlAllowlists
		]
	];
	for (const [target, property, ruleValue] of booleanRules) if (ruleValue !== void 0 && typeof ruleValue !== "boolean") return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/${target}`, `${params.policyPath} ${property} must be a boolean.`, `Fix ${params.policyPath} so ${property} is true or false.`);
	const denyEndpoints = http.denyEndpoints;
	if (denyEndpoints !== void 0 && !Array.isArray(denyEndpoints)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/gateway/http/denyEndpoints`, `${params.policyPath} gateway.http.denyEndpoints must be an array.`, "Use an array of endpoint ids such as [\"responses\"] or remove gateway.http.denyEndpoints.");
	if (Array.isArray(denyEndpoints)) {
		const invalidIndex = denyEndpoints.findIndex((entry) => typeof entry !== "string" || !SUPPORTED_GATEWAY_HTTP_ENDPOINTS.includes(entry.trim()));
		if (invalidIndex >= 0) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/gateway/http/denyEndpoints/#${invalidIndex}`, `${params.policyPath} gateway.http.denyEndpoints[${invalidIndex}] must be a supported endpoint id.`, `Use supported endpoint ids: ${SUPPORTED_GATEWAY_HTTP_ENDPOINTS.join(", ")}.`);
	}
}
function policyStringArrayShapeFinding(value, params) {
	if (value === void 0) return;
	if (!isRecord(value)) return policyShapeFinding(params.policyPath, `oc://${params.policyDocName}/${params.target}`, `${params.policyPath} ${params.property} must be an object.`, `Fix ${params.policyPath} so ${params.property} is an object.`);
	for (const key of ["allow", "deny"]) {
		const entries = value[key];
		if (entries === void 0) continue;
		const target = `oc://${params.policyDocName}/${params.target}/${key}`;
		if (!Array.isArray(entries)) return policyShapeFinding(params.policyPath, target, `${params.policyPath} ${params.property}.${key} must be an array.`, `Fix ${params.policyPath} so ${params.property}.${key} is an array of ${params.valueName}s.`);
		const invalidIndex = entries.findIndex((entry) => typeof entry !== "string" || entry.trim() === "");
		if (invalidIndex >= 0) return policyShapeFinding(params.policyPath, `${target}/#${invalidIndex}`, `${params.policyPath} ${params.property}.${key}[${invalidIndex}] must be a non-empty string.`, `Fix ${params.policyPath} so each ${params.property}.${key} entry is a ${params.valueName}.`);
	}
}
function policyShapeFinding(policyPath, target, message, fixHint) {
	return {
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message,
		source: "policy",
		path: policyPath,
		target,
		fixHint
	};
}
function authProfileMetadataRequirementFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.auth) || !isRecord(policy.auth.profiles) || policy.auth.profiles.requireMetadata === void 0) return [];
	if (!Array.isArray(policy.auth.profiles.requireMetadata)) return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} auth.profiles.requireMetadata must be an array of metadata keys.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/auth/profiles/requireMetadata`,
		fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`
	}];
	const invalidIndex = policy.auth.profiles.requireMetadata.findIndex((entry) => typeof entry !== "string" || !SUPPORTED_AUTH_PROFILE_METADATA.includes(entry.trim().toLowerCase()));
	if (invalidIndex < 0) return [];
	return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} auth.profiles.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/auth/profiles/requireMetadata/#${invalidIndex}`,
		fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`
	}];
}
function invalidChannelDenyRuleFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === void 0) return [];
	if (!Array.isArray(policy.channels.denyRules)) return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} channels.denyRules must be an array.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/channels/denyRules`,
		fixHint: `Fix ${policyPath} so channel deny rules are an array.`
	}];
	const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
	if (invalid < 0) return [];
	return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
		fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`
	}];
}
function mcpServerFindings(policy, policyDocName, evidence) {
	const denied = new Set(readStringList(policy, [
		"mcp",
		"servers",
		"deny"
	], { lowercase: false }));
	const allowed = readStringList(policy, [
		"mcp",
		"servers",
		"allow"
	], { lowercase: false });
	const allowedSet = new Set(allowed);
	const findings = [];
	for (const server of evidence.mcpServers) {
		if (denied.has(server.id)) {
			findings.push({
				checkId: CHECK_IDS.policyDeniedMcpServer,
				severity: "error",
				message: `MCP server '${server.id}' is denied by policy.`,
				source: "policy",
				path: "openclaw config",
				ocPath: server.source,
				target: server.source,
				requirement: `oc://${policyDocName}/mcp/servers/deny`,
				fixHint: "Remove this configured MCP server or update the policy after review."
			});
			continue;
		}
		if (allowedSet.size > 0 && !allowedSet.has(server.id)) findings.push({
			checkId: CHECK_IDS.policyUnapprovedMcpServer,
			severity: "error",
			message: `MCP server '${server.id}' is not in the policy allowlist.`,
			source: "policy",
			path: "openclaw config",
			ocPath: server.source,
			target: server.source,
			requirement: `oc://${policyDocName}/mcp/servers/allow`,
			fixHint: "Use an approved MCP server or update the policy after review."
		});
	}
	return findings;
}
function modelProviderFindings(policy, policyDocName, evidence) {
	const denied = new Set(readModelProviderPolicyList(policy, [
		"models",
		"providers",
		"deny"
	]));
	const allowed = readModelProviderPolicyList(policy, [
		"models",
		"providers",
		"allow"
	]);
	const allowedSet = new Set(allowed);
	const findings = [];
	for (const provider of evidence.modelProviders) findings.push(...modelProviderConformanceFindings(provider, denied, allowedSet, policyDocName));
	for (const modelRef of evidence.modelRefs) findings.push(...modelRefConformanceFindings(modelRef, denied, allowedSet, policyDocName));
	return findings;
}
function readModelProviderPolicyList(policy, path) {
	return readStringList(policy, path).map((provider) => normalizeProviderId(provider));
}
function modelProviderConformanceFindings(provider, denied, allowed, policyDocName) {
	const findings = [];
	if (denied.has(provider.id)) findings.push({
		checkId: CHECK_IDS.policyDeniedModelProvider,
		severity: "error",
		message: `Model provider '${provider.id}' is denied by policy.`,
		source: "policy",
		path: "openclaw config",
		ocPath: provider.source,
		target: provider.source,
		requirement: `oc://${policyDocName}/models/providers/deny`,
		fixHint: "Remove this configured provider or update the policy after review."
	});
	if (!denied.has(provider.id) && allowed.size > 0 && !allowed.has(provider.id)) findings.push({
		checkId: CHECK_IDS.policyUnapprovedModelProvider,
		severity: "error",
		message: `Model provider '${provider.id}' is not in the policy allowlist.`,
		source: "policy",
		path: "openclaw config",
		ocPath: provider.source,
		target: provider.source,
		requirement: `oc://${policyDocName}/models/providers/allow`,
		fixHint: "Use an approved model provider or update the policy after review."
	});
	return findings;
}
function modelRefConformanceFindings(modelRef, denied, allowed, policyDocName) {
	const findings = [];
	if (denied.has(modelRef.provider)) findings.push({
		checkId: CHECK_IDS.policyDeniedModelProvider,
		severity: "error",
		message: `Model ref '${modelRef.ref}' uses denied provider '${modelRef.provider}'.`,
		source: "policy",
		path: "openclaw config",
		ocPath: modelRef.source,
		target: modelRef.source,
		requirement: `oc://${policyDocName}/models/providers/deny`,
		fixHint: "Select an approved model provider or update the policy after review."
	});
	if (!denied.has(modelRef.provider) && allowed.size > 0 && !allowed.has(modelRef.provider)) findings.push({
		checkId: CHECK_IDS.policyUnapprovedModelProvider,
		severity: "error",
		message: `Model ref '${modelRef.ref}' uses unapproved provider '${modelRef.provider}'.`,
		source: "policy",
		path: "openclaw config",
		ocPath: modelRef.source,
		target: modelRef.source,
		requirement: `oc://${policyDocName}/models/providers/allow`,
		fixHint: "Select an approved model provider or update the policy after review."
	});
	return findings;
}
function networkFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"network",
		"privateNetwork",
		"allow"
	]) !== false) return [];
	return evidence.network.filter((setting) => setting.value).map((setting) => {
		return {
			checkId: CHECK_IDS.policyPrivateNetworkAccess,
			severity: "error",
			message: `Network setting '${setting.id}' allows private-network access.`,
			source: "policy",
			path: "openclaw config",
			ocPath: setting.source,
			target: setting.source,
			requirement: `oc://${policyDocName}/network/privateNetwork/allow`,
			fixHint: "Disable this private-network access setting or update policy after review."
		};
	});
}
function gatewayExposureFindings(policy, policyDocName, evidence) {
	return [
		...gatewayNonLoopbackBindFindings(policy, policyDocName, evidence),
		...gatewayAuthFindings(policy, policyDocName, evidence),
		...gatewayControlUiFindings(policy, policyDocName, evidence),
		...gatewayTailscaleFindings(policy, policyDocName, evidence),
		...gatewayRemoteFindings(policy, policyDocName, evidence),
		...gatewayHttpEndpointFindings(policy, policyDocName, evidence),
		...gatewayHttpUrlFetchFindings(policy, policyDocName, evidence)
	];
}
function gatewayNonLoopbackBindFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"gateway",
		"exposure",
		"allowNonLoopbackBind"
	]) !== false) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "bind" && entry.nonLoopback === true).map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayNonLoopbackBind,
			severity: "error",
			message: entry.explicit === false ? "Gateway bind is omitted while the runtime default can permit non-loopback exposure." : `Gateway bind setting '${entry.id}' permits non-loopback exposure.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/exposure/allowNonLoopbackBind`,
			fixHint: "Use gateway.bind=loopback or update policy after review."
		};
	});
}
function gatewayAuthFindings(policy, policyDocName, evidence) {
	const findings = [];
	if (readPolicyBoolean(policy, [
		"gateway",
		"auth",
		"requireAuth"
	]) === true) findings.push(...(evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "auth" && entry.value === "none").map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayAuthDisabled,
			severity: "error",
			message: "Gateway authentication is disabled.",
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/auth/requireAuth`,
			fixHint: "Set gateway.auth.mode to token, password, or trusted-proxy."
		};
	}));
	if (readPolicyBoolean(policy, [
		"gateway",
		"auth",
		"requireExplicitRateLimit"
	]) === true) findings.push(...(evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "authRateLimit" && entry.explicit !== true).map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayRateLimitMissing,
			severity: "error",
			message: "Gateway authentication rate-limit posture is not explicit.",
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/auth/requireExplicitRateLimit`,
			fixHint: "Configure gateway.auth.rateLimit or update policy after review."
		};
	}));
	return findings;
}
function gatewayControlUiFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"gateway",
		"controlUi",
		"allowInsecure"
	]) !== false) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "controlUi" && entry.value === true && (entry.id === "gateway-control-ui-insecure-auth" || entry.id === "gateway-control-ui-device-auth-disabled" || entry.id === "gateway-control-ui-host-origin-fallback")).map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayControlUiInsecure,
			severity: "error",
			message: `Gateway Control UI insecure toggle '${entry.id}' is enabled.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/controlUi/allowInsecure`,
			fixHint: "Disable the insecure Control UI toggle or update policy after review."
		};
	});
}
function gatewayTailscaleFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"gateway",
		"exposure",
		"allowTailscaleFunnel"
	]) !== false) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "tailscale" && entry.value === "funnel").map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayTailscaleFunnel,
			severity: "error",
			message: "Gateway Tailscale Funnel exposure is enabled.",
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/exposure/allowTailscaleFunnel`,
			fixHint: "Use tailscale serve/off or update policy after review."
		};
	});
}
function gatewayRemoteFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"gateway",
		"remote",
		"allow"
	]) !== false) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "remote").map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayRemoteEnabled,
			severity: "error",
			message: `Gateway remote posture '${entry.id}' is enabled.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/remote/allow`,
			fixHint: "Disable remote gateway mode/config or update policy after review."
		};
	});
}
function gatewayHttpEndpointFindings(policy, policyDocName, evidence) {
	const denied = new Set(readStringList(policy, [
		"gateway",
		"http",
		"denyEndpoints"
	]).map((endpoint) => endpoint.toLowerCase()));
	if (denied.size === 0) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "httpEndpoint" && entry.endpoint !== void 0 && denied.has(entry.endpoint.toLowerCase())).map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayHttpEndpointEnabled,
			severity: "error",
			message: `Gateway HTTP endpoint '${entry.endpoint ?? entry.id}' is denied by policy.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/http/denyEndpoints`,
			fixHint: "Disable the HTTP endpoint or update policy after review."
		};
	});
}
function gatewayHttpUrlFetchFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, [
		"gateway",
		"http",
		"requireUrlAllowlists"
	]) !== true) return [];
	return (evidence.gatewayExposure ?? []).filter((entry) => entry.kind === "httpUrlFetch" && entry.hasAllowlist !== true).map((entry) => {
		return {
			checkId: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
			severity: "error",
			message: `Gateway HTTP URL-fetch input '${entry.id}' has no URL allowlist.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/gateway/http/requireUrlAllowlists`,
			fixHint: "Add a urlAllowlist for this URL-fetch input or update policy after review."
		};
	});
}
function agentWorkspaceFindings(policy, policyPath, policyDocName, evidence) {
	if (agentsPolicyShapeFinding(isRecord(policy) ? policy.agents : void 0, {
		policyDocName,
		policyPath
	}) !== void 0) return [];
	return [...agentWorkspaceAccessFindings(policy, policyDocName, evidence), ...agentWorkspaceToolDenyFindings(policy, policyDocName, evidence)];
}
function agentWorkspaceAccessFindings(policy, policyDocName, evidence) {
	const allowed = new Set(readStringList(policy, [
		"agents",
		"workspace",
		"allowedAccess"
	]));
	if (allowed.size === 0) return [];
	return (evidence.agentWorkspace ?? []).filter((entry) => entry.kind === "workspaceAccess" && entry.value !== void 0 && (entry.sandboxEnabled !== true || !allowed.has(entry.value))).map((entry) => {
		const label = entry.agentId === void 0 ? "agents.defaults" : `agent '${entry.agentId}'`;
		const sandboxDisabled = entry.sandboxEnabled !== true;
		const observed = sandboxDisabled ? `sandbox mode '${entry.sandboxMode ?? "off"}'` : `sandbox workspaceAccess '${entry.value ?? ""}'`;
		const ocPath = sandboxDisabled ? entry.sandboxModeSource ?? entry.source : entry.source;
		return {
			checkId: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
			severity: "error",
			message: `${label} ${observed} is not allowed by policy.`,
			source: "policy",
			path: "openclaw config",
			ocPath,
			target: ocPath,
			requirement: `oc://${policyDocName}/agents/workspace/allowedAccess`,
			fixHint: "Enable sandbox mode with workspaceAccess none/ro or update policy after review."
		};
	});
}
function agentWorkspaceToolDenyFindings(policy, policyDocName, evidence) {
	const requiredDeniedTools = new Set(readStringList(policy, [
		"agents",
		"workspace",
		"denyTools"
	]));
	if (requiredDeniedTools.size === 0) return [];
	return (evidence.agentWorkspace ?? []).filter((entry) => entry.kind === "toolDeny" && entry.tool !== void 0 && requiredDeniedTools.has(entry.tool) && entry.denied !== true).map((entry) => {
		const label = entry.agentId === void 0 ? "agents.defaults" : `agent '${entry.agentId}'`;
		return {
			checkId: CHECK_IDS.policyAgentsToolNotDenied,
			severity: "error",
			message: `${label} does not deny required tool '${entry.tool ?? ""}'.`,
			source: "policy",
			path: "openclaw config",
			ocPath: entry.source,
			target: entry.source,
			requirement: `oc://${policyDocName}/agents/workspace/denyTools`,
			fixHint: "Add the tool to tools.deny or agents.list[].tools.deny, or update policy after review."
		};
	});
}
function secretAuthProvenanceFindings(policy, policyPath, policyDocName, evidence) {
	const secretShapeFindings = secretPolicyShapeFindings(policy, policyPath, policyDocName);
	const authShapeFindings = authProfileAllowModesShapeFindings(policy, policyPath, policyDocName);
	return [...secretShapeFindings.length > 0 ? secretShapeFindings : [
		...secretManagedProviderFindings(policy, policyDocName, evidence),
		...secretDeniedSourceFindings(policy, policyDocName, evidence),
		...secretInsecureProviderFindings(policy, policyDocName, evidence)
	], ...authShapeFindings.length > 0 ? authShapeFindings : [...authProfileMetadataFindings(policy, policyDocName, evidence), ...authProfileModeFindings(policy, policyDocName, evidence)]];
}
function policyHasSecretRules(policy) {
	if (!isRecord(policy) || !isRecord(policy.secrets)) return false;
	return policy.secrets.requireManagedProviders !== void 0 || policy.secrets.denySources !== void 0 || policy.secrets.allowInsecureProviders !== void 0;
}
function policyHasAuthProfileRules(policy) {
	return isRecord(policy) && isRecord(policy.auth) && isRecord(policy.auth.profiles) && (policy.auth.profiles.requireMetadata !== void 0 || policy.auth.profiles.allowModes !== void 0);
}
function policyHasGatewayRules(policy) {
	if (!isRecord(policy) || !isRecord(policy.gateway)) return false;
	const gateway = policy.gateway;
	return isRecord(gateway.exposure) && (gateway.exposure.allowNonLoopbackBind !== void 0 || gateway.exposure.allowTailscaleFunnel !== void 0) || isRecord(gateway.auth) && (gateway.auth.requireAuth !== void 0 || gateway.auth.requireExplicitRateLimit !== void 0) || isRecord(gateway.controlUi) && gateway.controlUi.allowInsecure !== void 0 || isRecord(gateway.remote) && gateway.remote.allow !== void 0 || isRecord(gateway.http) && (gateway.http.denyEndpoints !== void 0 || gateway.http.requireUrlAllowlists !== void 0);
}
function policyHasAgentWorkspaceRules(policy) {
	return isRecord(policy) && isRecord(policy.agents) && isRecord(policy.agents.workspace) && (policy.agents.workspace.allowedAccess !== void 0 || policy.agents.workspace.denyTools !== void 0);
}
function secretPolicyShapeFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.secrets)) return [];
	const findings = [];
	for (const key of ["requireManagedProviders", "allowInsecureProviders"]) if (policy.secrets[key] !== void 0 && typeof policy.secrets[key] !== "boolean") findings.push(policyShapeFinding(policyPath, `oc://${policyDocName}/secrets/${key}`, `${policyPath} secrets.${key} must be a boolean.`, `Set secrets.${key} to true or false.`));
	if (policy.secrets.denySources !== void 0 && !Array.isArray(policy.secrets.denySources)) findings.push(policyShapeFinding(policyPath, `oc://${policyDocName}/secrets/denySources`, `${policyPath} secrets.denySources must be an array of source names.`, "Use an array such as [\"exec\"] or remove secrets.denySources."));
	else if (Array.isArray(policy.secrets.denySources)) {
		const invalidIndex = policy.secrets.denySources.findIndex((entry) => typeof entry !== "string" || entry.trim() === "");
		if (invalidIndex >= 0) findings.push(policyShapeFinding(policyPath, `oc://${policyDocName}/secrets/denySources/#${invalidIndex}`, `${policyPath} secrets.denySources[${invalidIndex}] must be a non-empty source name.`, "Use non-empty source names such as env, file, exec, or openclaw."));
	}
	return findings;
}
function authProfileAllowModesShapeFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.auth) || !isRecord(policy.auth.profiles) || policy.auth.profiles.allowModes === void 0) return [];
	if (!Array.isArray(policy.auth.profiles.allowModes)) return [policyShapeFinding(policyPath, `oc://${policyDocName}/auth/profiles/allowModes`, `${policyPath} auth.profiles.allowModes must be an array of auth modes.`, `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`)];
	const invalidIndex = policy.auth.profiles.allowModes.findIndex((entry) => typeof entry !== "string" || !SUPPORTED_AUTH_PROFILE_MODES.includes(entry.trim().toLowerCase()));
	if (invalidIndex < 0) return [];
	return [policyShapeFinding(policyPath, `oc://${policyDocName}/auth/profiles/allowModes/#${invalidIndex}`, `${policyPath} auth.profiles.allowModes[${invalidIndex}] must be a supported auth mode.`, `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`)];
}
function secretManagedProviderFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, ["secrets", "requireManagedProviders"]) !== true) return [];
	const secrets = evidence.secrets ?? [];
	const providerKeys = new Set(secrets.filter((secret) => secret.kind === "provider" && secret.providerSource !== void 0).map((secret) => `${secret.providerSource}:${secret.id}`));
	return secrets.filter((secret) => secret.kind === "input" && secret.provenance === "secretRef" && (secret.refProvider === void 0 || secret.refSource === void 0 || !providerKeys.has(`${secret.refSource}:${secret.refProvider}`))).map((secret) => {
		return {
			checkId: CHECK_IDS.policySecretsUnmanagedProvider,
			severity: "error",
			message: `SecretRef uses unmanaged provider '${secret.refProvider ?? "default"}'.`,
			source: "policy",
			path: "openclaw config",
			ocPath: secret.source,
			target: secret.source,
			requirement: `oc://${policyDocName}/secrets/requireManagedProviders`,
			fixHint: "Declare the referenced provider under secrets.providers or update policy after review."
		};
	});
}
function secretDeniedSourceFindings(policy, policyDocName, evidence) {
	const deniedSources = new Set(readStringList(policy, ["secrets", "denySources"]));
	if (deniedSources.size === 0) return [];
	return (evidence.secrets ?? []).filter((secret) => {
		const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
		return source !== void 0 && deniedSources.has(source);
	}).map((secret) => {
		const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
		return {
			checkId: CHECK_IDS.policySecretsDeniedProviderSource,
			severity: "error",
			message: `Secret ${secret.kind} '${secret.id}' uses denied source '${source}'.`,
			source: "policy",
			path: "openclaw config",
			ocPath: secret.source,
			target: secret.source,
			requirement: `oc://${policyDocName}/secrets/denySources`,
			fixHint: "Move this secret to an approved source or update policy after review."
		};
	});
}
function secretInsecureProviderFindings(policy, policyDocName, evidence) {
	if (readPolicyBoolean(policy, ["secrets", "allowInsecureProviders"]) !== false) return [];
	return (evidence.secrets ?? []).filter((secret) => secret.kind === "provider" && (secret.insecure?.length ?? 0) > 0).map((secret) => {
		return {
			checkId: CHECK_IDS.policySecretsInsecureProvider,
			severity: "error",
			message: `Secret provider '${secret.id}' enables insecure posture: ${(secret.insecure ?? []).join(", ")}.`,
			source: "policy",
			path: "openclaw config",
			ocPath: secret.source,
			target: secret.source,
			requirement: `oc://${policyDocName}/secrets/allowInsecureProviders`,
			fixHint: "Remove insecure provider overrides or update policy after review."
		};
	});
}
function authProfileMetadataFindings(policy, policyDocName, evidence) {
	const requiredMetadata = requiredAuthProfileMetadata(policy);
	if (requiredMetadata.size === 0) return [];
	return (evidence.authProfiles ?? []).flatMap((profile) => {
		const missing = [...requiredMetadata].filter((metadata) => !authProfileHasMetadata(profile, metadata));
		if (missing.length === 0) return [];
		return [{
			checkId: CHECK_IDS.policyAuthProfileInvalidMetadata,
			severity: "error",
			message: `Auth profile '${profile.id}' is missing required metadata: ${missing.join(", ")}.`,
			source: "policy",
			path: "openclaw config",
			ocPath: profile.source,
			target: profile.source,
			requirement: `oc://${policyDocName}/auth/profiles/requireMetadata`,
			fixHint: "Set auth.profiles.<id>.provider and a supported auth profile mode."
		}];
	});
}
function authProfileModeFindings(policy, policyDocName, evidence) {
	const allowedModes = new Set(readStringList(policy, [
		"auth",
		"profiles",
		"allowModes"
	]));
	if (allowedModes.size === 0) return [];
	return (evidence.authProfiles ?? []).filter((profile) => profile.mode !== void 0 && !allowedModes.has(profile.mode)).map((profile) => {
		return {
			checkId: CHECK_IDS.policyAuthProfileUnapprovedMode,
			severity: "error",
			message: `Auth profile '${profile.id}' uses mode '${profile.mode}' outside the policy allowlist.`,
			source: "policy",
			path: "openclaw config",
			ocPath: profile.source,
			target: profile.source,
			requirement: `oc://${policyDocName}/auth/profiles/allowModes`,
			fixHint: "Change the auth profile mode or update policy after review."
		};
	});
}
function toolRiskFindings(policyDocName, evidence) {
	return (evidence.tools ?? []).filter((tool) => tool.risk === void 0).map((tool) => {
		return {
			checkId: CHECK_IDS.policyMissingToolRisk,
			severity: "error",
			message: `TOOLS.md tool '${tool.id}' has no explicit risk classification.`,
			source: "policy",
			path: "TOOLS.md",
			line: tool.line,
			ocPath: tool.source,
			target: tool.source,
			requirement: `oc://${policyDocName}/tools/requireMetadata`,
			fixHint: "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias."
		};
	});
}
function toolUnknownRiskFindings(policyDocName, evidence) {
	return (evidence.tools ?? []).filter((tool) => tool.risk !== void 0 && !KNOWN_RISK_LEVELS.includes(tool.risk)).map((tool) => {
		return {
			checkId: CHECK_IDS.policyUnknownToolRisk,
			severity: "error",
			message: `TOOLS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
			source: "policy",
			path: "TOOLS.md",
			line: tool.line,
			ocPath: tool.source,
			target: tool.source,
			requirement: `oc://${policyDocName}/tools/requireMetadata`,
			fixHint: `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`
		};
	});
}
function toolSensitivityFindings(policyDocName, evidence) {
	return (evidence.tools ?? []).flatMap((tool) => {
		if (tool.sensitivity === void 0) return [{
			checkId: CHECK_IDS.policyMissingToolSensitivity,
			severity: "error",
			message: `TOOLS.md tool '${tool.id}' has no declared artifact sensitivity.`,
			source: "policy",
			path: "TOOLS.md",
			line: tool.line,
			ocPath: tool.source,
			target: tool.source,
			requirement: `oc://${policyDocName}/tools/requireMetadata`,
			fixHint: `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`
		}];
		if (KNOWN_SENSITIVITY_LEVELS.includes(tool.sensitivity)) return [];
		return [{
			checkId: CHECK_IDS.policyUnknownToolSensitivity,
			severity: "error",
			message: `TOOLS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
			source: "policy",
			path: "TOOLS.md",
			line: tool.line,
			ocPath: tool.source,
			target: tool.source,
			requirement: `oc://${policyDocName}/tools/requireMetadata`,
			fixHint: `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`
		}];
	});
}
function toolOwnerFindings(policyDocName, evidence) {
	return (evidence.tools ?? []).filter((tool) => tool.owner === void 0).map((tool) => {
		return {
			checkId: CHECK_IDS.policyMissingToolOwner,
			severity: "error",
			message: `TOOLS.md tool '${tool.id}' has no declared owner.`,
			source: "policy",
			path: "TOOLS.md",
			line: tool.line,
			ocPath: tool.source,
			target: tool.source,
			requirement: `oc://${policyDocName}/tools/requireMetadata`,
			fixHint: "Declare owner:<team-or-person> for this tool."
		};
	});
}
async function readPolicyFile(ctx) {
	const displayName = policyDisplayName(ctx);
	const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
	try {
		return {
			raw: await (await import("node:fs/promises")).readFile(path, "utf-8"),
			path,
			displayName,
			ocDocName: basename(displayName)
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}
async function readWorkspaceFile(ctx, fileName) {
	const path = resolveWorkspacePath(ctx, fileName);
	try {
		return {
			raw: await (await import("node:fs/promises")).readFile(path, "utf-8"),
			path
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}
function resolveWorkspacePath(ctx, fileName) {
	if (isAbsolute(fileName)) return fileName;
	return resolve(ctx.cwd ?? process.cwd(), fileName);
}
function isNotFound(err) {
	return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
function parsePolicyFile(raw) {
	try {
		return {
			ok: true,
			value: JSON5.parse(raw)
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}
function workspaceRepairsEnabled(ctx) {
	return policySettings(ctx).workspaceRepairs === true;
}
function workspaceRepairsDisabledResult(fileName) {
	return {
		status: "skipped",
		reason: "workspace repairs are disabled",
		changes: [],
		warnings: [`Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`]
	};
}
function readChannelDenyRules(policy, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.channels) || !Array.isArray(policy.channels.denyRules)) return [];
	return policy.channels.denyRules.map((rule, index) => ({
		rule,
		index
	})).filter((entry) => isChannelDenyRule(entry.rule)).map(({ rule, index }) => {
		const next = {
			when: rule.when,
			requirement: `oc://${policyDocName}/channels/denyRules/#${index}`
		};
		if (rule.id !== void 0) next.id = rule.id;
		if (rule.reason !== void 0) next.reason = rule.reason;
		return next;
	});
}
function isChannelDenyRule(value) {
	return isRecord(value) && (value.id === void 0 || typeof value.id === "string") && (value.reason === void 0 || typeof value.reason === "string") && isRecord(value.when) && typeof value.when.provider === "string";
}
function channelIdsFromFindings(findings) {
	return [...new Set(findings.filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider).map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1]).filter((id) => id !== void 0 && id !== ""))];
}
function disableChannels(cfg, channelIds) {
	if (!isRecord(cfg.channels)) return {
		config: cfg,
		changed: []
	};
	const channels = { ...cfg.channels };
	const changed = [];
	for (const id of channelIds) {
		const current = channels[id];
		if (!isRecord(current) || current.enabled === false) continue;
		channels[id] = {
			...current,
			enabled: false
		};
		changed.push(id);
	}
	if (changed.length === 0) return {
		config: cfg,
		changed
	};
	return {
		config: {
			...cfg,
			channels
		},
		changed
	};
}
function policySettings(ctx) {
	const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
	if (!isRecord(pluginConfig)) return {};
	return pluginConfig;
}
function policyChecksEnabled(ctx, settings) {
	const entry = ctx.cfg.plugins?.entries?.["policy"];
	if (!isRecord(entry) || entry.enabled === false) return false;
	return settings.enabled !== false;
}
function requiredToolMetadata(policy) {
	return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}
function requiredAuthProfileMetadata(policy) {
	const entries = readPolicyStringArray(policy, [
		"auth",
		"profiles",
		"requireMetadata"
	]) ?? [];
	return new Set(entries.filter((entry) => SUPPORTED_AUTH_PROFILE_METADATA.includes(entry)));
}
function authProfileHasMetadata(profile, metadata) {
	if (metadata === "provider") return profile.provider !== void 0 && profile.provider.trim() !== "";
	return SUPPORTED_AUTH_PROFILE_MODES.includes(profile.mode);
}
function readPolicyStringArray(policy, path, options = {}) {
	let current = policy;
	for (const part of path) {
		if (!isRecord(current)) return;
		current = current[part];
	}
	if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) return;
	const lowercase = options.lowercase ?? true;
	return current.map((entry) => {
		const trimmed = entry.trim();
		return lowercase ? trimmed.toLowerCase() : trimmed;
	}).filter(Boolean);
}
function readStringList(policy, path, options) {
	return readPolicyStringArray(policy, path, options) ?? [];
}
function readPolicyBoolean(policy, path) {
	let current = policy;
	for (const part of path) {
		if (!isRecord(current)) return;
		current = current[part];
	}
	return typeof current === "boolean" ? current : void 0;
}
function policyPathSetting(ctx) {
	const configured = policySettings(ctx).path;
	return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : "policy.jsonc";
}
function policyDisplayName(ctx) {
	const configured = policyPathSetting(ctx);
	return isAbsolute(configured) ? basename(configured) : configured;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
export { createPolicyAttestation as i, evaluatePolicy as n, registerPolicyDoctorChecks as r, POLICY_CHECK_IDS as t };
