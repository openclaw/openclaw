import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./account-id-B32J-iNN.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as isChannelVisibleInConfiguredLists } from "./channel-meta-COEgfCjE.js";
import { a as normalizeChannelId } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { i as listRouteBindings } from "./bindings-D1F1bOgs.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-CswdXPdi.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { t as describeBinding } from "./agents.binding-format-B_OLxIww.js";
import "./agents.bindings-CJmjfAEt.js";
import { n as requireValidConfig } from "./agents.command-shared-at9V0DWB.js";
import { n as buildAgentSummaries } from "./agents.config-BhjhdYsc.js";
//#region src/commands/agents.providers.ts
function providerAccountKey(provider, accountId) {
	return `${provider}:${accountId ?? "default"}`;
}
function buildProviderSummaryMetadataIndex(cfg) {
	return new Map(listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: false }).map((plugin) => [plugin.id, {
		label: plugin.meta.label,
		defaultAccountId: resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds: plugin.config.listAccountIds(cfg)
		}),
		visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta)
	}]));
}
function isUnresolvedSecretRefResolutionError(error) {
	return error instanceof Error && typeof error.message === "string" && /unresolved SecretRef/i.test(error.message);
}
function formatChannelAccountLabel(params) {
	return `${params.providerLabel ?? params.provider} ${params.name?.trim() ? `${params.accountId} (${params.name.trim()})` : params.accountId}`;
}
function formatProviderState(entry) {
	const parts = [entry.state];
	if (entry.enabled === false && entry.state !== "disabled") parts.push("disabled");
	return parts.join(", ");
}
async function resolveReadOnlyAccount(params) {
	if (params.plugin.config.inspectAccount) return await Promise.resolve(params.plugin.config.inspectAccount(params.cfg, params.accountId));
	return params.plugin.config.resolveAccount(params.cfg, params.accountId);
}
async function buildProviderStatusIndex(cfg) {
	const map = /* @__PURE__ */ new Map();
	for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: false })) {
		const accountIds = plugin.config.listAccountIds(cfg);
		for (const accountId of accountIds) {
			let account;
			try {
				account = await resolveReadOnlyAccount({
					plugin,
					cfg,
					accountId
				});
			} catch (error) {
				if (!isUnresolvedSecretRefResolutionError(error)) throw error;
				map.set(providerAccountKey(plugin.id, accountId), {
					provider: plugin.id,
					accountId,
					state: "not configured",
					configured: false
				});
				continue;
			}
			if (!account) continue;
			const snapshot = plugin.config.describeAccount?.(account, cfg);
			const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : typeof snapshot?.enabled === "boolean" ? snapshot.enabled : account.enabled;
			const configured = plugin.config.isConfigured ? await plugin.config.isConfigured(account, cfg) : snapshot?.configured;
			const resolvedEnabled = typeof enabled === "boolean" ? enabled : true;
			const resolvedConfigured = typeof configured === "boolean" ? configured : true;
			const state = plugin.status?.resolveAccountState?.({
				account,
				cfg,
				configured: resolvedConfigured,
				enabled: resolvedEnabled
			}) ?? (typeof snapshot?.linked === "boolean" ? snapshot.linked ? "linked" : "not linked" : resolvedConfigured ? "configured" : "not configured");
			const name = snapshot?.name ?? account.name;
			map.set(providerAccountKey(plugin.id, accountId), {
				provider: plugin.id,
				providerLabel: plugin.meta.label,
				accountId,
				name,
				state,
				enabled,
				configured,
				visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta)
			});
		}
	}
	return map;
}
function resolveDefaultAccountId(provider, metadataByProvider) {
	return metadataByProvider.get(provider)?.defaultAccountId ?? "default";
}
function shouldShowProviderEntry(params) {
	if ((params.entry.visibleInConfiguredLists ?? params.metadataByProvider.get(params.entry.provider)?.visibleInConfiguredLists) === false) {
		const providerConfig = params.cfg[params.entry.provider];
		return Boolean(params.entry.configured) || Boolean(providerConfig);
	}
	return Boolean(params.entry.configured);
}
function formatProviderEntry(entry) {
	return `${formatChannelAccountLabel({
		provider: entry.provider,
		providerLabel: entry.providerLabel,
		accountId: entry.accountId,
		name: entry.name
	})}: ${formatProviderState(entry)}`;
}
function summarizeBindings(cfg, bindings, metadataByProvider = buildProviderSummaryMetadataIndex(cfg)) {
	if (bindings.length === 0) return [];
	const seen = /* @__PURE__ */ new Map();
	for (const binding of bindings) {
		const channel = normalizeChannelId(binding.match.channel);
		if (!channel) continue;
		const accountId = binding.match.accountId ?? resolveDefaultAccountId(channel, metadataByProvider);
		const key = providerAccountKey(channel, accountId);
		if (!seen.has(key)) {
			const label = formatChannelAccountLabel({
				provider: channel,
				providerLabel: metadataByProvider.get(channel)?.label,
				accountId
			});
			seen.set(key, label);
		}
	}
	return [...seen.values()];
}
function listProvidersForAgent(params) {
	const allProviderEntries = [...params.providerStatus.values()];
	const providerLines = [];
	const metadataByProvider = params.providerMetadata ?? buildProviderSummaryMetadataIndex(params.cfg);
	if (params.bindings.length > 0) {
		const seen = /* @__PURE__ */ new Set();
		for (const binding of params.bindings) {
			const channel = normalizeChannelId(binding.match.channel);
			if (!channel) continue;
			const accountId = binding.match.accountId ?? resolveDefaultAccountId(channel, metadataByProvider);
			const key = providerAccountKey(channel, accountId);
			if (seen.has(key)) continue;
			seen.add(key);
			const status = params.providerStatus.get(key);
			if (status) providerLines.push(formatProviderEntry(status));
			else providerLines.push(`${formatChannelAccountLabel({
				provider: channel,
				providerLabel: metadataByProvider.get(channel)?.label,
				accountId
			})}: unknown`);
		}
		return providerLines;
	}
	if (params.summaryIsDefault) {
		for (const entry of allProviderEntries) if (shouldShowProviderEntry({
			entry,
			cfg: params.cfg,
			metadataByProvider
		})) providerLines.push(formatProviderEntry(entry));
	}
	return providerLines;
}
//#endregion
//#region src/commands/agents.commands.list.ts
function formatSummary(summary) {
	const defaultTag = summary.isDefault ? " (default)" : "";
	const header = summary.name && summary.name !== summary.id ? `${summary.id}${defaultTag} (${summary.name})` : `${summary.id}${defaultTag}`;
	const identityParts = [];
	if (summary.identityEmoji) identityParts.push(summary.identityEmoji);
	if (summary.identityName) identityParts.push(summary.identityName);
	const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
	const identitySource = summary.identitySource === "identity" ? "IDENTITY.md" : summary.identitySource === "config" ? "config" : null;
	const lines = [`- ${header}`];
	if (identityLine) lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
	lines.push(`  Workspace: ${shortenHomePath(summary.workspace)}`);
	lines.push(`  Agent dir: ${shortenHomePath(summary.agentDir)}`);
	if (summary.model) lines.push(`  Model: ${summary.model}`);
	lines.push(`  Routing rules: ${summary.bindings}`);
	if (summary.routes?.length) lines.push(`  Routing: ${summary.routes.join(", ")}`);
	if (summary.providers?.length) {
		lines.push("  Providers:");
		for (const provider of summary.providers) lines.push(`    - ${provider}`);
	}
	if (summary.bindingDetails?.length) {
		lines.push("  Routing rules:");
		for (const binding of summary.bindingDetails) lines.push(`    - ${binding}`);
	}
	return lines.join("\n");
}
async function agentsListCommand(opts, runtime = defaultRuntime) {
	const cfg = await requireValidConfig(runtime);
	if (!cfg) return;
	const summaries = buildAgentSummaries(cfg);
	const bindingMap = /* @__PURE__ */ new Map();
	for (const binding of listRouteBindings(cfg)) {
		const agentId = normalizeAgentId(binding.agentId);
		const list = bindingMap.get(agentId) ?? [];
		list.push(binding);
		bindingMap.set(agentId, list);
	}
	if (opts.bindings) for (const summary of summaries) {
		const bindings = bindingMap.get(summary.id) ?? [];
		if (bindings.length > 0) summary.bindingDetails = bindings.map((binding) => describeBinding(binding));
	}
	const includeProviderDetails = !opts.json || opts.bindings === true;
	const providerStatus = includeProviderDetails ? await buildProviderStatusIndex(cfg) : null;
	const providerMetadata = includeProviderDetails ? buildProviderSummaryMetadataIndex(cfg) : null;
	for (const summary of summaries) {
		const bindings = bindingMap.get(summary.id) ?? [];
		if (includeProviderDetails && providerStatus && providerMetadata) {
			const routes = summarizeBindings(cfg, bindings, providerMetadata);
			if (routes.length > 0) summary.routes = routes;
			else if (summary.isDefault) summary.routes = ["default (no explicit rules)"];
			const providerLines = listProvidersForAgent({
				summaryIsDefault: summary.isDefault,
				cfg,
				bindings,
				providerStatus,
				providerMetadata
			});
			if (providerLines.length > 0) summary.providers = providerLines;
		}
	}
	if (opts.json) {
		writeRuntimeJson(runtime, summaries);
		return;
	}
	const lines = ["Agents:", ...summaries.map(formatSummary)];
	lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
	lines.push(`Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`);
	runtime.log(lines.join("\n"));
}
//#endregion
export { agentsListCommand };
