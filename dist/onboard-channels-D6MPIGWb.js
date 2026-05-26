import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import "./agent-scope-CtLXGcWm.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as CHAT_CHANNEL_ORDER } from "./ids-BE_yccbC.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
import { n as listChatChannels } from "./chat-meta-2H4wOcrq.js";
import { n as formatChannelSelectionLine, t as formatChannelPrimerLine } from "./registry-CtWyD2pE.js";
import { a as getBundledChannelSetupPlugin, f as listBundledChannelSetupPlugins } from "./bundled-0oTAwz0N.js";
import { t as isChannelConfigured } from "./channel-configured-B6BYuKoD.js";
import { t as getActivePluginChannelRegistry, v as requireActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-CswdXPdi.js";
import { n as t, r as wizardT } from "./i18n-CWNhN747.js";
import { t as buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard-D1FjeAqn.js";
import { i as resolveBundledPluginSources, n as findBundledPluginSourceInMap } from "./bundled-sources-Bb5DSmIr.js";
import { n as loadChannelSetupPluginRegistrySnapshotForChannel, t as ensureChannelSetupPluginInstalled } from "./plugin-install-BvWiJ10m.js";
import { r as listTrustedChannelPluginCatalogEntries, t as getTrustedChannelPluginCatalogEntry } from "./trusted-catalog-ax5bRVns.js";
import { i as shouldShowChannelInSetup, r as resolveChannelSetupEntries } from "./discovery-nftDBpqu.js";
//#region src/channels/plugins/setup-registry.ts
function dedupeSetupPlugins(plugins) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const plugin of plugins) {
		const id = normalizeOptionalString(plugin.id) ?? "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		resolved.push(plugin);
	}
	return resolved;
}
function sortChannelSetupPlugins(plugins) {
	return dedupeSetupPlugins(plugins).toSorted((a, b) => {
		const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
		const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
		const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
		const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
		if (orderA !== orderB) return orderA - orderB;
		return a.id.localeCompare(b.id);
	});
}
function resolveChannelSetupPlugins() {
	const registryPlugins = (requireActivePluginRegistry().channelSetups ?? []).map((entry) => entry.plugin);
	const sorted = sortChannelSetupPlugins(registryPlugins.length > 0 ? registryPlugins : listBundledChannelSetupPlugins());
	const byId = /* @__PURE__ */ new Map();
	for (const plugin of sorted) byId.set(plugin.id, plugin);
	return {
		sorted,
		byId
	};
}
function listChannelSetupPlugins() {
	return resolveChannelSetupPlugins().sorted.slice();
}
function listActiveChannelSetupPlugins() {
	return sortChannelSetupPlugins((getActivePluginChannelRegistry()?.channelSetups ?? []).map((entry) => entry.plugin));
}
function getChannelSetupPlugin(id) {
	const resolvedId = normalizeOptionalString(id) ?? "";
	if (!resolvedId) return;
	return resolveChannelSetupPlugins().byId.get(resolvedId);
}
//#endregion
//#region src/commands/channel-setup/registry.ts
const setupWizardAdapters = /* @__PURE__ */ new WeakMap();
function isChannelSetupWizardAdapter(setupWizard) {
	return Boolean(setupWizard && typeof setupWizard === "object" && "getStatus" in setupWizard && typeof setupWizard.getStatus === "function" && "configure" in setupWizard && typeof setupWizard.configure === "function");
}
function isDeclarativeChannelSetupWizard(setupWizard) {
	return Boolean(setupWizard && typeof setupWizard === "object" && "status" in setupWizard && "credentials" in setupWizard);
}
function resolveChannelSetupWizardAdapterForPlugin(plugin) {
	if (!plugin) return;
	const { setupWizard } = plugin;
	if (isChannelSetupWizardAdapter(setupWizard)) return setupWizard;
	if (isDeclarativeChannelSetupWizard(setupWizard)) {
		const cached = setupWizardAdapters.get(plugin);
		if (cached) return cached;
		const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
			plugin,
			wizard: setupWizard
		});
		setupWizardAdapters.set(plugin, adapter);
		return adapter;
	}
}
//#endregion
//#region src/flows/channel-setup.prompts.ts
function formatAccountLabel(accountId) {
	return accountId === "default" ? "default (primary)" : accountId;
}
async function promptConfiguredAction(params) {
	const { prompter, label, supportsDisable, supportsDelete } = params;
	const options = [
		{
			value: "update",
			label: t("wizard.channels.modifySettings")
		},
		...supportsDisable ? [{
			value: "disable",
			label: t("wizard.channels.disableKeepConfig")
		}] : [],
		...supportsDelete ? [{
			value: "delete",
			label: t("wizard.channels.deleteConfig")
		}] : [],
		{
			value: "skip",
			label: t("wizard.channels.skipLeaveAsIs")
		}
	];
	return await prompter.select({
		message: t("wizard.channels.configuredAction", { label }),
		options,
		initialValue: "update"
	});
}
async function promptRemovalAccountId(params) {
	const { cfg, prompter, label, channel } = params;
	const plugin = params.plugin ?? getChannelSetupPlugin(channel);
	if (!plugin) return DEFAULT_ACCOUNT_ID;
	const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
	const defaultAccountId = resolveChannelDefaultAccountId({
		plugin,
		cfg,
		accountIds
	});
	if (accountIds.length <= 1) return defaultAccountId;
	return normalizeAccountId(await prompter.select({
		message: t("wizard.channels.account", { label }),
		options: accountIds.map((accountId) => ({
			value: accountId,
			label: formatAccountLabel(accountId)
		})),
		initialValue: defaultAccountId
	})) ?? defaultAccountId;
}
async function maybeConfigureDmPolicies(params) {
	const { selection, prompter, accountIdsByChannel } = params;
	const resolve = params.resolveAdapter ?? (() => void 0);
	const dmPolicies = selection.map((channel) => resolve(channel)?.dmPolicy).filter(Boolean);
	if (dmPolicies.length === 0) return params.cfg;
	if (!await prompter.confirm({
		message: t("wizard.channels.configureDmPolicies"),
		initialValue: false
	})) return params.cfg;
	let cfg = params.cfg;
	for (const policy of dmPolicies) {
		const accountId = accountIdsByChannel?.get(policy.channel);
		const { policyKey, allowFromKey } = policy.resolveConfigKeys?.(cfg, accountId) ?? {
			policyKey: policy.policyKey,
			allowFromKey: policy.allowFromKey
		};
		await prompter.note([
			t("wizard.channels.dmPolicyDefault"),
			t("wizard.channels.dmPolicyApprove", { command: formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`) }),
			t("wizard.channels.dmPolicyAllowlist", {
				allowFromKey,
				policyKey
			}),
			t("wizard.channels.dmPolicyOpen", {
				allowFromKey,
				policyKey
			}),
			t("wizard.channels.dmPolicyMultiUser", { command: formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") }),
			t("wizard.channels.docs", { link: formatDocsLink("/channels/pairing", "channels/pairing") })
		].join("\n"), t("wizard.channels.dmAccessTitle", { label: policy.label }));
		const nextPolicy = await prompter.select({
			message: t("wizard.channels.dmPolicy", { label: policy.label }),
			options: [
				{
					value: "pairing",
					label: t("wizard.channels.dmPolicyPairing")
				},
				{
					value: "allowlist",
					label: t("wizard.channels.dmPolicyAllowlistOption")
				},
				{
					value: "open",
					label: t("wizard.channels.dmPolicyOpenOption")
				},
				{
					value: "disabled",
					label: t("wizard.channels.dmPolicyDisabledOption")
				}
			]
		});
		if (nextPolicy !== policy.getCurrent(cfg, accountId)) cfg = policy.setPolicy(cfg, nextPolicy, accountId);
		if (nextPolicy === "allowlist" && policy.promptAllowFrom) cfg = await policy.promptAllowFrom({
			cfg,
			prompter,
			accountId
		});
	}
	return cfg;
}
//#endregion
//#region src/flows/channel-setup.status.ts
const CHANNEL_PRIMER_BLURB_KEYS = {
	clickclack: "wizard.channelsPrimer.blurbs.clickclack",
	discord: "wizard.channelsPrimer.blurbs.discord",
	feishu: "wizard.channelsPrimer.blurbs.feishu",
	googlechat: "wizard.channelsPrimer.blurbs.googlechat",
	imessage: "wizard.channelsPrimer.blurbs.imessage",
	irc: "wizard.channelsPrimer.blurbs.irc",
	line: "wizard.channelsPrimer.blurbs.line",
	mattermost: "wizard.channelsPrimer.blurbs.mattermost",
	matrix: "wizard.channelsPrimer.blurbs.matrix",
	msteams: "wizard.channelsPrimer.blurbs.msteams",
	"nextcloud-talk": "wizard.channelsPrimer.blurbs.nextcloudTalk",
	nostr: "wizard.channelsPrimer.blurbs.nostr",
	qqbot: "wizard.channelsPrimer.blurbs.qqbot",
	signal: "wizard.channelsPrimer.blurbs.signal",
	slack: "wizard.channelsPrimer.blurbs.slack",
	"synology-chat": "wizard.channelsPrimer.blurbs.synologyChat",
	telegram: "wizard.channelsPrimer.blurbs.telegram",
	tlon: "wizard.channelsPrimer.blurbs.tlon",
	twitch: "wizard.channelsPrimer.blurbs.twitch",
	wecom: "wizard.channelsPrimer.blurbs.wecom",
	whatsapp: "wizard.channelsPrimer.blurbs.whatsapp",
	yuanbao: "wizard.channelsPrimer.blurbs.yuanbao",
	zalo: "wizard.channelsPrimer.blurbs.zalo",
	zalouser: "wizard.channelsPrimer.blurbs.zalouser"
};
function buildChannelSetupSelectionContribution(params) {
	return {
		id: `channel:setup:${params.channel}`,
		kind: "channel",
		surface: "setup",
		channel: params.channel,
		option: {
			value: params.channel,
			label: params.label,
			...params.hint ? { hint: params.hint } : {}
		},
		source: params.source
	};
}
function formatSetupSelectionLabel(label, fallback) {
	return sanitizeTerminalText(label).trim() || sanitizeTerminalText(fallback).trim() || "<invalid channel>";
}
function formatSetupSelectionHint(hint) {
	if (!hint) return;
	return sanitizeTerminalText(hint) || void 0;
}
function formatSetupDisplayText(value, fallback = "") {
	return sanitizeTerminalText(value ?? "").trim() || sanitizeTerminalText(fallback).trim() || "<invalid channel>";
}
function formatSetupFreeText(value) {
	return sanitizeTerminalText(value ?? "").trim();
}
function formatSetupOptionalDisplayText(value) {
	return sanitizeTerminalText(value ?? "").trim() || void 0;
}
function formatSetupDisplayList(values) {
	const safe = (values ?? []).flatMap((value) => {
		const sanitized = formatSetupOptionalDisplayText(value);
		return sanitized ? [sanitized] : [];
	});
	return safe.length > 0 ? safe : void 0;
}
function formatSetupDisplayMeta(meta) {
	const safeId = formatSetupDisplayText(meta.id, "<invalid channel>");
	const safeLabel = formatSetupDisplayText(meta.label, safeId);
	const safeSelectionDocsPrefix = formatSetupOptionalDisplayText(meta.selectionDocsPrefix);
	const safeSelectionExtras = formatSetupDisplayList(meta.selectionExtras);
	return {
		...meta,
		id: safeId,
		label: safeLabel,
		selectionLabel: formatSetupDisplayText(meta.selectionLabel, safeLabel),
		docsPath: formatSetupDisplayText(meta.docsPath, "/"),
		...meta.docsLabel ? { docsLabel: formatSetupDisplayText(meta.docsLabel, safeId) } : {},
		blurb: formatSetupFreeText(meta.blurb),
		...safeSelectionDocsPrefix ? { selectionDocsPrefix: safeSelectionDocsPrefix } : {},
		...safeSelectionExtras ? { selectionExtras: safeSelectionExtras } : {}
	};
}
function formatChannelPrimerBlurb(channel) {
	const key = CHANNEL_PRIMER_BLURB_KEYS[channel.id];
	if (!key) return channel.blurb;
	const englishBlurb = wizardT(key, void 0, { locale: "en" });
	return channel.blurb === englishBlurb ? t(key) : channel.blurb;
}
function formatChannelSelectionMeta(meta) {
	return formatSetupDisplayMeta({
		...meta,
		blurb: formatChannelPrimerBlurb(meta),
		selectionDocsPrefix: meta.selectionDocsPrefix ?? t("common.docs")
	});
}
function localizeChannelStatusLabel(label) {
	switch (label) {
		case "configured": return t("wizard.channels.statusConfigured");
		case "not configured": return t("wizard.channels.statusNotConfigured");
		case "configured (plugin disabled)": return t("wizard.channels.statusConfiguredPluginDisabled");
		case "installed": return t("wizard.channels.statusInstalled");
		case "installed (plugin disabled)": return t("wizard.channels.statusInstalledPluginDisabled");
		case "bundled · enable to use": return t("wizard.channels.statusBundledEnable");
		case "install plugin to enable": return t("wizard.channels.statusInstallPluginEnable");
		case "needs app credentials": return t("wizard.channels.statusNeedsAppCredentials");
		case "needs app creds": return t("wizard.channels.statusNeedsAppCreds");
		case "needs auth": return t("wizard.channels.statusNeedsAuth");
		case "needs host + nick": return t("wizard.channels.statusNeedsHostNick");
		case "needs private key": return t("wizard.channels.statusNeedsPrivateKey");
		case "needs QR login": return t("wizard.channels.statusNeedsQrLogin");
		case "needs service account": return t("wizard.channels.statusNeedsServiceAccount");
		case "needs setup": return t("wizard.channels.statusNeedsSetup");
		case "needs token": return t("wizard.channels.statusNeedsToken");
		case "needs tokens": return t("wizard.channels.statusNeedsTokens");
		case "needs token + incoming webhook": return t("wizard.channels.statusNeedsTokenIncomingWebhook");
		case "needs token + secret": return t("wizard.channels.statusNeedsTokenSecret");
		case "needs token + url": return t("wizard.channels.statusNeedsTokenUrl");
		case "needs username, token, and clientId": return t("wizard.channels.statusNeedsUsernameTokenClientId");
		case "linked": return t("wizard.channels.statusLinked");
		case "logged in": return t("wizard.channels.statusLoggedIn");
		case "not linked": return t("wizard.channels.statusNotLinked");
		case "recommended · configured": return t("wizard.channels.statusRecommendedConfigured");
		case "recommended · logged in": return t("wizard.channels.statusRecommendedLoggedIn");
		case "recommended · newcomer-friendly": return t("wizard.channels.statusRecommendedNewcomerFriendly");
		case "recommended · QR login": return t("wizard.channels.statusRecommendedQrLogin");
		case "self-hosted chat": return t("wizard.channels.statusSelfHostedChat");
		case "signal-cli found": return t("wizard.channels.statusSignalCliFound");
		case "signal-cli missing": return t("wizard.channels.statusSignalCliMissing");
		case "urbit messenger": return t("wizard.channels.statusUrbitMessenger");
		case "configured (connection not verified)": return t("wizard.channels.statusConfiguredConnectionNotVerified");
		default: break;
	}
	if (label.startsWith("connected as ")) return t("wizard.channels.statusConnectedAs", { name: label.slice(13) });
	return label;
}
function localizeChannelStatusLine(line) {
	const index = line.lastIndexOf(": ");
	if (index < 0) return localizeChannelStatusLabel(line);
	return `${line.slice(0, index + 2)}${localizeChannelStatusLabel(line.slice(index + 2))}`;
}
function localizeChannelSetupStatus(status) {
	return {
		...status,
		statusLines: status.statusLines.map(localizeChannelStatusLine),
		...status.selectionHint ? { selectionHint: localizeChannelStatusLabel(status.selectionHint) } : {}
	};
}
/**
* Hint shown next to an installable channel option in the selection menu when
* we don't yet have a runtime-collected status. Mirrors the "configured" /
* "installed" affordance other channels get so users can see "download from
* <npm-spec>" before committing to install.
*
* Bundled channels (the plugin lives under `extensions/<id>` in the host
* repo, e.g. Signal / Tlon / Twitch / Slack) are NOT downloaded from npm —
* they ship with the host. Even when their `package.json` declares an
* `npmSpec` (or the catalog falls back to the package name), surfacing
* "download from <npm-spec>" misleads users into believing the plugin is
* missing. For bundled channels we suppress the npm hint entirely so the
* menu shows the same neutral "plugin · install" affordance used when no
* npm source is known.
*/
function resolveCatalogChannelSelectionHint(entry, options) {
	const npmSpec = entry.install?.npmSpec?.trim();
	if (npmSpec && !options?.bundledLocalPath) return `download from ${formatSetupSelectionLabel(npmSpec, npmSpec)}`;
	return "";
}
/**
* Look up the bundled-source entry for a catalog channel, regardless of
* whether the catalog refers to it by `pluginId` or `npmSpec`. We use this
* to detect bundled channels in the selection menu so we can suppress the
* misleading "download from <npm-spec>" hint for plugins that already ship
* with the host (Signal / Tlon / Twitch / Slack ...).
*/
function findBundledSourceForCatalogChannel(params) {
	const pluginId = params.entry.pluginId?.trim() || params.entry.id.trim();
	if (pluginId) {
		const byId = findBundledPluginSourceInMap({
			bundled: params.bundled,
			lookup: {
				kind: "pluginId",
				value: pluginId
			}
		});
		if (byId) return byId;
	}
	const npmSpec = params.entry.install?.npmSpec?.trim();
	if (npmSpec) return findBundledPluginSourceInMap({
		bundled: params.bundled,
		lookup: {
			kind: "npmSpec",
			value: npmSpec
		}
	});
}
async function collectChannelStatus(params) {
	const installedPlugins = params.installedPlugins ?? listChannelSetupPlugins();
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
	const { installedCatalogEntries, installableCatalogEntries } = resolveChannelSetupEntries({
		cfg: params.cfg,
		installedPlugins,
		workspaceDir
	});
	const bundledSources = resolveBundledPluginSources({ workspaceDir });
	const resolveAdapter = params.resolveAdapter ?? ((channel) => resolveChannelSetupWizardAdapterForPlugin(installedPlugins.find((plugin) => plugin.id === channel)));
	const statusEntries = await Promise.all(installedPlugins.flatMap((plugin) => {
		if (!shouldShowChannelInSetup(plugin.meta)) return [];
		const adapter = resolveAdapter(plugin.id);
		if (!adapter) return [];
		return adapter.getStatus({
			cfg: params.cfg,
			options: params.options,
			accountOverrides: params.accountOverrides
		});
	}));
	const statusByChannel = new Map(statusEntries.map((entry) => [entry.channel, entry]));
	const fallbackStatuses = listChatChannels().filter((meta) => shouldShowChannelInSetup(meta)).filter((meta) => !statusByChannel.has(meta.id)).map((meta) => {
		const configured = isChannelConfigured(params.cfg, meta.id);
		const statusLabel = configured ? "configured (plugin disabled)" : "not configured";
		return {
			channel: meta.id,
			configured,
			statusLines: [`${formatSetupSelectionLabel(meta.label, meta.id)}: ${statusLabel}`],
			selectionHint: configured ? "configured · plugin disabled" : "not configured",
			quickstartScore: 0
		};
	});
	const discoveredPluginStatuses = installedCatalogEntries.filter((entry) => !statusByChannel.has(entry.id)).map((entry) => {
		const configured = isChannelConfigured(params.cfg, entry.id);
		const pluginEnabled = params.cfg.plugins?.entries?.[entry.pluginId ?? entry.id]?.enabled !== false;
		const statusLabel = configured ? pluginEnabled ? "configured" : "configured (plugin disabled)" : pluginEnabled ? "installed" : "installed (plugin disabled)";
		return {
			channel: entry.id,
			configured,
			statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
			selectionHint: statusLabel,
			quickstartScore: 0
		};
	});
	const catalogStatuses = installableCatalogEntries.map((entry) => {
		const bundledLocalPath = findBundledSourceForCatalogChannel({
			bundled: bundledSources,
			entry
		})?.localPath ?? null;
		const statusLabel = Boolean(bundledLocalPath) ? "bundled · enable to use" : "install plugin to enable";
		return {
			channel: entry.id,
			configured: false,
			statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
			selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath }),
			quickstartScore: 0
		};
	});
	const combinedStatuses = [
		...statusEntries,
		...fallbackStatuses,
		...discoveredPluginStatuses,
		...catalogStatuses
	].map(localizeChannelSetupStatus);
	return {
		installedPlugins,
		catalogEntries: installableCatalogEntries,
		installedCatalogEntries,
		statusByChannel: new Map(combinedStatuses.map((entry) => [entry.channel, entry])),
		statusLines: combinedStatuses.flatMap((entry) => entry.statusLines)
	};
}
async function noteChannelStatus(params) {
	const { statusLines } = await collectChannelStatus({
		cfg: params.cfg,
		options: params.options,
		accountOverrides: params.accountOverrides ?? {},
		installedPlugins: params.installedPlugins,
		resolveAdapter: params.resolveAdapter
	});
	if (statusLines.length > 0) await params.prompter.note(statusLines.join("\n"), t("wizard.channels.statusTitle"));
}
async function noteChannelPrimer(prompter, channels) {
	const channelLines = channels.map((channel) => formatChannelPrimerLine(formatSetupDisplayMeta({
		id: channel.id,
		label: channel.label,
		selectionLabel: channel.label,
		docsPath: "/",
		blurb: formatChannelPrimerBlurb(channel)
	})));
	await prompter.note([
		t("wizard.channelsPrimer.inboundSafety"),
		t("wizard.channelsPrimer.approveWith", { command: formatCliCommand("openclaw pairing approve <channel> <code>") }),
		t("wizard.channelsPrimer.openDm"),
		t("wizard.channelsPrimer.multiUserDm", { command: formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") }),
		t("wizard.channelsPrimer.docs", { link: formatDocsLink("/channels/pairing", "channels/pairing") }),
		"",
		...channelLines
	].join("\n"), t("wizard.channelsPrimer.title"));
}
function resolveQuickstartDefault(statusByChannel) {
	let best = null;
	for (const [channel, status] of statusByChannel) {
		if (status.quickstartScore == null) continue;
		if (!best || status.quickstartScore > best.score) best = {
			channel,
			score: status.quickstartScore
		};
	}
	return best?.channel;
}
function resolveChannelSelectionNoteLines(params) {
	const { entries } = resolveChannelSetupEntries({
		cfg: params.cfg,
		installedPlugins: params.installedPlugins,
		workspaceDir: resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg))
	});
	const selectionNotes = /* @__PURE__ */ new Map();
	for (const entry of entries) selectionNotes.set(entry.id, formatChannelSelectionLine(formatChannelSelectionMeta(entry.meta), formatDocsLink));
	return params.selection.map((channel) => selectionNotes.get(channel)).filter((line) => Boolean(line));
}
function resolveChannelSetupSelectionContributions(params) {
	const bundledChannelIds = new Set(listChatChannels().map((channel) => channel.id));
	return params.entries.filter((entry) => shouldShowChannelInSetup(entry.meta)).toSorted((left, right) => compareChannelSetupSelectionEntries(left, right)).map((entry) => {
		const disabledHint = params.resolveDisabledHint(entry.id);
		const hint = [params.statusByChannel.get(entry.id)?.selectionHint, disabledHint].filter(Boolean).join(" · ") || void 0;
		return buildChannelSetupSelectionContribution({
			channel: entry.id,
			label: formatSetupSelectionLabel(entry.meta.selectionLabel ?? entry.meta.label, entry.id),
			hint: formatSetupSelectionHint(hint),
			source: bundledChannelIds.has(entry.id) ? "core" : "plugin"
		});
	});
}
function compareChannelSetupSelectionEntries(left, right) {
	const leftLabel = left.meta.selectionLabel ?? left.meta.label;
	const rightLabel = right.meta.selectionLabel ?? right.meta.label;
	return leftLabel.localeCompare(rightLabel, void 0, {
		numeric: true,
		sensitivity: "base"
	}) || left.id.localeCompare(right.id, void 0, {
		numeric: true,
		sensitivity: "base"
	});
}
//#endregion
//#region src/flows/channel-setup.ts
function createChannelOnboardingPostWriteHookCollector() {
	const hooks = /* @__PURE__ */ new Map();
	return {
		collect(hook) {
			hooks.set(`${hook.channel}:${hook.accountId}`, hook);
		},
		drain() {
			const next = [...hooks.values()];
			hooks.clear();
			return next;
		}
	};
}
async function runCollectedChannelOnboardingPostWriteHooks(params) {
	for (const hook of params.hooks) try {
		await hook.run({
			cfg: params.cfg,
			runtime: params.runtime
		});
	} catch (err) {
		const message = formatErrorMessage(err);
		params.runtime.error(`Channel ${hook.channel} post-setup warning for "${hook.accountId}": ${message}`);
	}
}
function createChannelOnboardingPostWriteHook(params) {
	if (!params.accountId || !params.adapter?.afterConfigWritten) return;
	return {
		channel: params.channel,
		accountId: params.accountId,
		run: async ({ cfg, runtime }) => await params.adapter?.afterConfigWritten?.({
			previousCfg: params.previousCfg,
			cfg,
			accountId: params.accountId,
			runtime
		})
	};
}
async function setupChannels(cfg, runtime, prompter, options) {
	let next = cfg;
	const deferStatusUntilSelection = options?.deferStatusUntilSelection === true;
	const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
	const accountOverrides = { ...options?.accountIds };
	const scopedPluginsById = /* @__PURE__ */ new Map();
	const resolveWorkspaceDir = () => resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
	const rememberScopedPlugin = (plugin) => {
		const channel = plugin.id;
		scopedPluginsById.set(channel, plugin);
		options?.onResolvedPlugin?.(channel, plugin);
	};
	const activePluginsById = /* @__PURE__ */ new Map();
	const rememberActivePlugin = (plugin) => {
		activePluginsById.set(plugin.id, plugin);
		return plugin;
	};
	const getVisibleChannelPlugin = (channel) => scopedPluginsById.get(channel) ?? activePluginsById.get(channel);
	const listVisibleInstalledPlugins = () => {
		const merged = /* @__PURE__ */ new Map();
		const registryPlugins = listActiveChannelSetupPlugins().map(rememberActivePlugin);
		for (const plugin of registryPlugins) if (shouldShowChannelInSetup(plugin.meta)) merged.set(plugin.id, plugin);
		for (const plugin of scopedPluginsById.values()) if (shouldShowChannelInSetup(plugin.meta)) merged.set(plugin.id, plugin);
		return Array.from(merged.values());
	};
	const resolveVisibleChannelEntries = () => resolveChannelSetupEntries({
		cfg: next,
		installedPlugins: listVisibleInstalledPlugins(),
		workspaceDir: resolveWorkspaceDir()
	});
	const loadScopedChannelPlugin = async (channel, pluginId, setup) => {
		const existing = getVisibleChannelPlugin(channel);
		if (existing && setup?.forceReload !== true) return existing;
		const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
			cfg: next,
			runtime,
			channel,
			...pluginId ? { pluginId } : {},
			workspaceDir: resolveWorkspaceDir(),
			forceSetupOnlyChannelPlugins: setup?.forceSetupOnlyChannelPlugins ?? true
		});
		const plugin = snapshot.channelSetups.find((entry) => entry.plugin.id === channel)?.plugin ?? snapshot.channels.find((entry) => entry.plugin.id === channel)?.plugin;
		if (plugin) {
			rememberScopedPlugin(plugin);
			return plugin;
		}
		const bundledPlugin = getBundledChannelSetupPlugin(channel);
		if (bundledPlugin) {
			rememberScopedPlugin(bundledPlugin);
			return bundledPlugin;
		}
	};
	const getVisibleSetupFlowAdapter = (channel) => {
		const scopedPlugin = scopedPluginsById.get(channel);
		if (scopedPlugin) return resolveChannelSetupWizardAdapterForPlugin(scopedPlugin);
		return resolveChannelSetupWizardAdapterForPlugin(getVisibleChannelPlugin(channel));
	};
	const preloadConfiguredExternalPlugins = async () => {
		listVisibleInstalledPlugins();
		const workspaceDir = resolveWorkspaceDir();
		const preloadTasks = [];
		for (const entry of listTrustedChannelPluginCatalogEntries({
			cfg: next,
			workspaceDir
		})) {
			const channel = entry.id;
			if (getVisibleChannelPlugin(channel)) continue;
			if (!(next.plugins?.entries?.[entry.pluginId ?? channel]?.enabled === true) && !isChannelConfigured(next, channel)) continue;
			preloadTasks.push(loadScopedChannelPlugin(channel, entry.pluginId));
		}
		await Promise.all(preloadTasks);
	};
	if (!deferStatusUntilSelection) await preloadConfiguredExternalPlugins();
	const { statusByChannel, statusLines } = deferStatusUntilSelection ? {
		statusByChannel: /* @__PURE__ */ new Map(),
		statusLines: []
	} : await collectChannelStatus({
		cfg: next,
		options,
		accountOverrides,
		installedPlugins: listVisibleInstalledPlugins(),
		resolveAdapter: getVisibleSetupFlowAdapter
	});
	if (!options?.skipStatusNote && statusLines.length > 0) await prompter.note(statusLines.join("\n"), t("wizard.channels.statusTitle"));
	if (!(options?.skipConfirm ? true : await prompter.confirm({
		message: t("wizard.channels.setupConfirm"),
		initialValue: true
	}))) return cfg;
	await noteChannelPrimer(prompter, resolveVisibleChannelEntries().entries.map((entry) => ({
		id: entry.id,
		label: entry.meta.label,
		blurb: entry.meta.blurb
	})));
	const quickstartDefault = options?.initialSelection?.[0] ?? (deferStatusUntilSelection ? void 0 : resolveQuickstartDefault(statusByChannel));
	const shouldPromptAccountIds = options?.promptAccountIds === true;
	const accountIdsByChannel = /* @__PURE__ */ new Map();
	const recordAccount = (channel, accountId) => {
		options?.onAccountId?.(channel, accountId);
		getVisibleSetupFlowAdapter(channel)?.onAccountRecorded?.(accountId, options);
		accountIdsByChannel.set(channel, accountId);
	};
	const selection = [];
	const addSelection = (channel) => {
		if (!selection.includes(channel)) selection.push(channel);
	};
	const resolveConfigDisabledHint = (channel) => {
		if (next.plugins?.enabled === false) return "plugins disabled";
		if (next.plugins?.entries?.[channel]?.enabled === false) return "plugin disabled";
		if (typeof next.channels?.[channel]?.enabled === "boolean") return next.channels[channel]?.enabled === false ? "disabled" : void 0;
	};
	const resolveDisabledHint = (channel) => {
		const configDisabledHint = resolveConfigDisabledHint(channel);
		if (configDisabledHint || deferStatusUntilSelection) return configDisabledHint;
		const plugin = getVisibleChannelPlugin(channel);
		if (!plugin) return;
		const accountId = resolveChannelDefaultAccountId({
			plugin,
			cfg: next
		});
		const account = plugin.config.resolveAccount(next, accountId);
		let enabled;
		if (plugin.config.isEnabled) enabled = plugin.config.isEnabled(account, next);
		else if (typeof account?.enabled === "boolean") enabled = account.enabled;
		return enabled === false ? "disabled" : void 0;
	};
	const getChannelEntries = () => {
		const resolved = resolveVisibleChannelEntries();
		return {
			entries: resolved.entries,
			catalogById: resolved.installableCatalogById,
			installedCatalogById: resolved.installedCatalogById
		};
	};
	const buildStatusByChannelForSelection = (catalogById) => {
		const decorated = new Map(statusByChannel);
		if (catalogById.size === 0) return decorated;
		const bundledSources = resolveBundledPluginSources({ workspaceDir: resolveWorkspaceDir() });
		for (const [channel, entry] of catalogById) {
			if (decorated.has(channel)) continue;
			const bundledLocalPath = findBundledSourceForCatalogChannel({
				bundled: bundledSources,
				entry
			})?.localPath ?? null;
			decorated.set(channel, {
				channel,
				configured: false,
				statusLines: [],
				selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath })
			});
		}
		return decorated;
	};
	const refreshStatus = async (channel) => {
		const adapter = getVisibleSetupFlowAdapter(channel);
		if (!adapter) return;
		const status = await adapter.getStatus({
			cfg: next,
			options,
			accountOverrides
		});
		statusByChannel.set(channel, status);
	};
	const enableBundledPluginForSetup = async (channel) => {
		if (getVisibleChannelPlugin(channel)) {
			await refreshStatus(channel);
			return true;
		}
		const disabledHint = resolveConfigDisabledHint(channel);
		if (disabledHint) {
			await prompter.note(t("wizard.channels.disabledDuringSetup", {
				channel,
				hint: disabledHint,
				command: formatCliCommand("openclaw channels add")
			}), t("wizard.channels.setupTitle"));
			return false;
		}
		const result = enablePluginInConfig(next, channel);
		next = result.config;
		if (!result.enabled) {
			await prompter.note(t("wizard.channels.pluginEnableFailed", {
				channel,
				reason: result.reason ?? "plugin disabled",
				command: formatCliCommand("openclaw plugins list")
			}), t("wizard.channels.setupTitle"));
			return false;
		}
		const plugin = await loadScopedChannelPlugin(channel);
		const adapter = getVisibleSetupFlowAdapter(channel);
		if (!plugin) {
			if (adapter) {
				await prompter.note(t("wizard.channels.pluginMissingRecoverable", {
					channel,
					listCommand: formatCliCommand("openclaw plugins list"),
					enableCommand: formatCliCommand("openclaw plugins enable " + channel)
				}), t("wizard.channels.setupTitle"));
				await refreshStatus(channel);
				return true;
			}
			await prompter.note(t("wizard.channels.pluginNotAvailable", { channel }), t("wizard.channels.setupTitle"));
			return false;
		}
		await refreshStatus(channel);
		return true;
	};
	const applySetupResult = async (channel, result) => {
		const previousCfg = next;
		next = result.cfg;
		const adapter = getVisibleSetupFlowAdapter(channel);
		if (result.accountId) {
			recordAccount(channel, result.accountId);
			const postWriteHook = createChannelOnboardingPostWriteHook({
				accountId: result.accountId,
				adapter,
				channel,
				previousCfg
			});
			if (postWriteHook) options?.onPostWriteHook?.(postWriteHook);
		}
		addSelection(channel);
		await refreshStatus(channel);
	};
	const applyCustomSetupResult = async (channel, result) => {
		if (result === "skip") return false;
		await applySetupResult(channel, result);
		return true;
	};
	const configureChannel = async (channel) => {
		if (scopedPluginsById.has(channel)) await loadScopedChannelPlugin(channel, void 0, {
			forceReload: true,
			forceSetupOnlyChannelPlugins: true
		});
		const adapter = getVisibleSetupFlowAdapter(channel);
		if (!adapter) {
			await prompter.note(t("wizard.channels.noInteractiveSetup", {
				channel,
				command: formatCliCommand(`openclaw channels add --channel ${channel} --help`)
			}), t("wizard.channels.setupTitle"));
			return;
		}
		await applySetupResult(channel, await adapter.configure({
			cfg: next,
			runtime,
			prompter,
			options,
			accountOverrides,
			shouldPromptAccountIds,
			forceAllowFrom: forceAllowFromChannels.has(channel)
		}));
	};
	const handleConfiguredChannel = async (channel, label) => {
		const plugin = getVisibleChannelPlugin(channel);
		const adapter = getVisibleSetupFlowAdapter(channel);
		if (adapter?.configureWhenConfigured) {
			if (!await applyCustomSetupResult(channel, await adapter.configureWhenConfigured({
				cfg: next,
				runtime,
				prompter,
				options,
				accountOverrides,
				shouldPromptAccountIds,
				forceAllowFrom: forceAllowFromChannels.has(channel),
				configured: true,
				label
			}))) return;
			return;
		}
		const supportsDisable = Boolean(options?.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable));
		const supportsDelete = Boolean(options?.allowDisable && plugin?.config.deleteAccount);
		const action = await promptConfiguredAction({
			prompter,
			label,
			supportsDisable,
			supportsDelete
		});
		if (action === "skip") return;
		if (action === "update") {
			await configureChannel(channel);
			return;
		}
		if (!options?.allowDisable) return;
		if (action === "delete" && !supportsDelete) {
			await prompter.note(t("wizard.channels.configuredDeleteUnsupported", { label }), t("wizard.channels.removeTitle"));
			return;
		}
		const resolvedAccountId = normalizeAccountId((action === "delete" ? Boolean(plugin?.config.deleteAccount) : Boolean(plugin?.config.setAccountEnabled)) ? await promptRemovalAccountId({
			cfg: next,
			prompter,
			label,
			channel,
			plugin
		}) : "default") ?? (plugin ? resolveChannelDefaultAccountId({
			plugin,
			cfg: next
		}) : "default");
		const accountLabel = formatAccountLabel(resolvedAccountId);
		if (action === "delete") {
			if (!await prompter.confirm({
				message: t("wizard.channels.deleteAccount", {
					label,
					account: accountLabel
				}),
				initialValue: false
			})) return;
			if (plugin?.config.deleteAccount) next = plugin.config.deleteAccount({
				cfg: next,
				accountId: resolvedAccountId
			});
			await refreshStatus(channel);
			return;
		}
		if (plugin?.config.setAccountEnabled) next = plugin.config.setAccountEnabled({
			cfg: next,
			accountId: resolvedAccountId,
			enabled: false
		});
		else if (adapter?.disable) next = adapter.disable(next);
		await refreshStatus(channel);
	};
	const handleChannelChoice = async (channel) => {
		const { catalogById, installedCatalogById } = getChannelEntries();
		const catalogEntry = catalogById.get(channel);
		const installedCatalogEntry = installedCatalogById.get(channel);
		const deferredDisabledHint = deferStatusUntilSelection ? resolveConfigDisabledHint(channel) : void 0;
		if (deferredDisabledHint) {
			await prompter.note(t("wizard.channels.disabledBeforeSetup", {
				channel,
				hint: deferredDisabledHint
			}), t("wizard.channels.setupTitle"));
			return "done";
		}
		if (catalogEntry) {
			const workspaceDir = resolveWorkspaceDir();
			const result = await ensureChannelSetupPluginInstalled({
				cfg: next,
				entry: catalogEntry,
				prompter,
				runtime,
				workspaceDir,
				autoConfirmSingleSource: true
			});
			next = result.cfg;
			if (!result.installed) return "retry_selection";
			await loadScopedChannelPlugin(channel, result.pluginId ?? catalogEntry.pluginId);
			await refreshStatus(channel);
		} else if (installedCatalogEntry) {
			let plugin = await loadScopedChannelPlugin(channel, installedCatalogEntry.pluginId);
			if (!plugin && installedCatalogEntry.install?.npmSpec) {
				const disabledHint = resolveConfigDisabledHint(channel);
				if (disabledHint) {
					await prompter.note(t("wizard.channels.disabledBeforeSetup", {
						channel,
						hint: disabledHint
					}), t("wizard.channels.setupTitle"));
					return "done";
				}
				const workspaceDir = resolveWorkspaceDir();
				const result = await ensureChannelSetupPluginInstalled({
					cfg: next,
					entry: installedCatalogEntry,
					prompter,
					runtime,
					workspaceDir,
					autoConfirmSingleSource: true
				});
				next = result.cfg;
				if (!result.installed) return "retry_selection";
				plugin = await loadScopedChannelPlugin(channel, result.pluginId ?? installedCatalogEntry.pluginId);
			}
			if (!plugin) {
				await prompter.note(t("wizard.channels.pluginNotAvailable", { channel }), t("wizard.channels.setupTitle"));
				return "done";
			}
			await refreshStatus(channel);
		} else {
			const fallbackCatalogEntry = getTrustedChannelPluginCatalogEntry(channel, {
				cfg: next,
				workspaceDir: resolveWorkspaceDir()
			});
			if (fallbackCatalogEntry?.install?.npmSpec) {
				const disabledHint = resolveConfigDisabledHint(channel);
				if (disabledHint) {
					await prompter.note(t("wizard.channels.disabledBeforeSetup", {
						channel,
						hint: disabledHint
					}), t("wizard.channels.setupTitle"));
					return "done";
				}
				const workspaceDir = resolveWorkspaceDir();
				const result = await ensureChannelSetupPluginInstalled({
					cfg: next,
					entry: fallbackCatalogEntry,
					prompter,
					runtime,
					workspaceDir,
					autoConfirmSingleSource: true
				});
				next = result.cfg;
				if (!result.installed) return "retry_selection";
				await loadScopedChannelPlugin(channel, result.pluginId ?? fallbackCatalogEntry.pluginId);
				await refreshStatus(channel);
			} else if (!await enableBundledPluginForSetup(channel)) return "done";
		}
		const plugin = getVisibleChannelPlugin(channel);
		const adapter = getVisibleSetupFlowAdapter(channel);
		const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
		const configured = statusByChannel.get(channel)?.configured ?? false;
		if (adapter?.configureInteractive) {
			if (!await applyCustomSetupResult(channel, await adapter.configureInteractive({
				cfg: next,
				runtime,
				prompter,
				options,
				accountOverrides,
				shouldPromptAccountIds,
				forceAllowFrom: forceAllowFromChannels.has(channel),
				configured,
				label
			}))) return "done";
			return "done";
		}
		if (configured) {
			await handleConfiguredChannel(channel, label);
			return "done";
		}
		await configureChannel(channel);
		return "done";
	};
	if (options?.quickstartDefaults) while (true) {
		const { entries, catalogById } = getChannelEntries();
		const choice = await prompter.select({
			message: t("wizard.channels.selectQuickstart"),
			options: [...resolveChannelSetupSelectionContributions({
				entries,
				statusByChannel: buildStatusByChannelForSelection(catalogById),
				resolveDisabledHint
			}).map((contribution) => contribution.option), {
				value: "__skip__",
				label: t("common.skipForNow"),
				hint: t("wizard.channels.skipLaterHint", { command: formatCliCommand("openclaw channels add") })
			}],
			initialValue: quickstartDefault,
			searchable: true
		});
		if (choice === "__skip__") break;
		if (await handleChannelChoice(choice) === "done") break;
	}
	else {
		const doneValue = "__done__";
		const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
		while (true) {
			const { entries, catalogById } = getChannelEntries();
			const choice = await prompter.select({
				message: t("wizard.channels.select"),
				options: [...resolveChannelSetupSelectionContributions({
					entries,
					statusByChannel: buildStatusByChannelForSelection(catalogById),
					resolveDisabledHint
				}).map((contribution) => contribution.option), {
					value: doneValue,
					label: t("common.finished"),
					hint: selection.length > 0 ? t("wizard.channels.doneHint") : t("common.skipForNow")
				}],
				initialValue
			});
			if (choice === doneValue) break;
			await handleChannelChoice(choice);
		}
	}
	options?.onSelection?.(selection);
	const selectedLines = resolveChannelSelectionNoteLines({
		cfg: next,
		installedPlugins: listVisibleInstalledPlugins(),
		selection
	});
	if (selectedLines.length > 0) await prompter.note(selectedLines.join("\n"), t("wizard.channels.selectedTitle"));
	if (!options?.skipDmPolicyPrompt) next = await maybeConfigureDmPolicies({
		cfg: next,
		selection,
		prompter,
		accountIdsByChannel,
		resolveAdapter: getVisibleSetupFlowAdapter
	});
	return next;
}
//#endregion
export { noteChannelStatus as a, setupChannels as i, createChannelOnboardingPostWriteHookCollector as n, runCollectedChannelOnboardingPostWriteHooks as r, createChannelOnboardingPostWriteHook as t };
