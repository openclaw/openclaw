import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import "./agent-scope-CtLXGcWm.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { a as getResolvedLoggerSettings } from "./logger-Dg9dVaLI.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { c as formatUnknownChannelMessage, l as formatUnsupportedChannelActionMessage } from "./error-format-BfFDdqsq.js";
import { o as normalizeChannelId } from "./registry-CtWyD2pE.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import "./message-channel-CYCKkVrh.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { a as getBundledChannelSetupPlugin } from "./bundled-0oTAwz0N.js";
import { a as normalizeChannelId$1, n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import "./logging-B2Kt4cNB.js";
import { t as listManifestChannelContributionIds } from "./manifest-contribution-ids-tozuTTjv.js";
import { l as resolveMessageActionDiscoveryForPlugin, r as createMessageActionDiscoveryContext } from "./message-action-discovery-C_vRmQ0H.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-DQG3SYlu.js";
import { i as resolveChannelDefaultAccountId, r as parseOptionalDelimitedEntries } from "./helpers-CswdXPdi.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { o as getChannelsCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { c as moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers-BC9z9VvG.js";
import { t as WizardCancelledError } from "./prompts-E0FayNjJ.js";
import { t as createClackPrompter } from "./clack-prompter-BZIQivnq.js";
import { t as commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit-Cwrnavi6.js";
import { t as refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh-OLbBO5Xj.js";
import { t as resolveCommandConfigWithSecrets } from "./command-config-resolution-QySEqFLr.js";
import { t as resolveInstallableChannelPlugin } from "./channel-plugin-resolution-BwwYGsiK.js";
import { n as resolveLogFile } from "./log-tail-A9kBoCdj.js";
import { t as parseLogLine } from "./parse-log-line-Bi6tTmwR.js";
import { t as describeBinding } from "./agents.binding-format-B_OLxIww.js";
import { t as applyAgentBindings } from "./agents.bindings-CJmjfAEt.js";
import { t as requireValidConfigFileSnapshot } from "./config-validation-CSay_Jnk.js";
import { c as shouldUseWizard, o as formatChannelAccountLabel, s as requireValidConfig } from "./shared-DxOkFLYA.js";
import { t as channelsListCommand } from "./list-DF-APXbq.js";
import { n as formatGatewayChannelsStatusLines, t as channelsStatusCommand } from "./status-CRTahMIR.js";
import fs from "node:fs/promises";
//#region src/commands/channels/add-mutators.ts
function applyAccountName(params) {
	const accountId = normalizeAccountId(params.accountId);
	const apply = (params.plugin ?? getChannelPlugin(params.channel))?.setup?.applyAccountName;
	return apply ? apply({
		cfg: params.cfg,
		accountId,
		name: params.name
	}) : params.cfg;
}
function applyChannelAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const apply = (params.plugin ?? getChannelPlugin(params.channel))?.setup?.applyAccountConfig;
	if (!apply) return params.cfg;
	return apply({
		cfg: params.cfg,
		accountId,
		input: params.input
	});
}
//#endregion
//#region src/commands/channels/runtime-label.ts
const channelLabel = (channel) => {
	return (getLoadedChannelPlugin(channel) ?? getBundledChannelSetupPlugin(channel) ?? getChannelPlugin(channel))?.meta.label ?? channel;
};
//#endregion
//#region src/commands/channels/add.ts
const channelSetupPluginInstallLoader = createLazyImportLoader(() => import("./plugin-install-g9RkFGi-.js"));
const onboardChannelsLoader = createLazyImportLoader(() => import("./onboard-channels-CPUzO4u4.js"));
function loadChannelSetupPluginInstall() {
	return channelSetupPluginInstallLoader.load();
}
function loadOnboardChannels() {
	return onboardChannelsLoader.load();
}
const CHANNEL_ADD_CONTROL_OPTION_KEYS = new Set(["channel", "account"]);
const NEXTCLOUD_TALK_CLI_ALIASES = new Set([
	"nextcloud-talk",
	"nc-talk",
	"nc"
]);
async function resolveCatalogChannelEntry(raw, cfg) {
	const trimmed = normalizeOptionalLowercaseString(raw);
	if (!trimmed) return;
	return (cfg ? await import("./trusted-catalog-BMgXr_MD.js").then(({ listTrustedChannelPluginCatalogEntries }) => listTrustedChannelPluginCatalogEntries({
		cfg,
		workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))
	})) : await import("./catalog-SI1GGbxW.js").then(({ listChannelPluginCatalogEntries }) => listChannelPluginCatalogEntries({ excludeWorkspace: true }))).find((entry) => {
		if (normalizeOptionalLowercaseString(entry.id) === trimmed) return true;
		return (entry.meta.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === trimmed);
	});
}
function parseOptionalInt(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) return Number.parseInt(value, 10);
}
function parseOptionalDelimitedInput(value) {
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
	return parseOptionalDelimitedEntries(typeof value === "string" ? value : void 0);
}
function readOptionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function buildChannelSetupInput(opts) {
	const input = {};
	for (const [key, value] of Object.entries(opts)) {
		if (CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) || value === void 0) continue;
		input[key] = value;
	}
	const rawChannel = readOptionalString(opts.channel)?.trim().toLowerCase();
	if (rawChannel && NEXTCLOUD_TALK_CLI_ALIASES.has(rawChannel)) {
		input.baseUrl ??= readOptionalString(input.url);
		input.secret ??= readOptionalString(input.token) ?? readOptionalString(input.password);
		input.secretFile ??= readOptionalString(input.tokenFile);
	}
	input.initialSyncLimit = parseOptionalInt(opts.initialSyncLimit);
	input.groupChannels = parseOptionalDelimitedInput(opts.groupChannels);
	input.dmAllowlist = parseOptionalDelimitedInput(opts.dmAllowlist);
	return input;
}
async function channelsAddCommand(opts, runtime = defaultRuntime, params) {
	try {
		return await channelsAddCommandImpl(opts, runtime, params);
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			runtime.exit(1);
			return;
		}
		throw err;
	}
}
async function channelsAddCommandImpl(opts, runtime, params) {
	const configSnapshot = await requireValidConfigFileSnapshot(runtime);
	if (!configSnapshot) return;
	const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
	const baseHash = configSnapshot.hash;
	let nextConfig = cfg;
	let pluginRegistrySourceChanged = false;
	if (shouldUseWizard(params)) {
		const [{ buildAgentSummaries }, onboardChannels] = await Promise.all([import("./agents.config-C6F7q62r.js"), loadOnboardChannels()]);
		const prompter = createClackPrompter();
		const postWriteHooks = onboardChannels.createChannelOnboardingPostWriteHookCollector();
		let selection = [];
		const accountIds = {};
		const resolvedPlugins = /* @__PURE__ */ new Map();
		await prompter.intro("Channel setup");
		let nextConfig = await onboardChannels.setupChannels(cfg, runtime, prompter, {
			allowDisable: false,
			allowSignalInstall: true,
			onPostWriteHook: (hook) => {
				postWriteHooks.collect(hook);
			},
			promptAccountIds: true,
			deferStatusUntilSelection: true,
			skipStatusNote: true,
			onSelection: (value) => {
				selection = value;
			},
			onAccountId: (channel, accountId) => {
				accountIds[channel] = accountId;
			},
			onResolvedPlugin: (channel, plugin) => {
				resolvedPlugins.set(channel, plugin);
			}
		});
		if (selection.length === 0) {
			await prompter.outro("No channel changes made.");
			return;
		}
		if (await prompter.confirm({
			message: "Name these channel accounts now? (optional)",
			initialValue: false
		})) for (const channel of selection) {
			const accountId = accountIds[channel] ?? "default";
			const plugin = resolvedPlugins.get(channel) ?? getLoadedChannelPlugin(channel);
			const account = plugin?.config.resolveAccount(nextConfig, accountId);
			const existingName = (plugin?.config.describeAccount?.(account, nextConfig))?.name ?? account?.name;
			const name = await prompter.text({
				message: `${channel} display name for account "${accountId}"`,
				initialValue: existingName
			});
			if (name?.trim()) nextConfig = applyAccountName({
				cfg: nextConfig,
				channel,
				accountId,
				name,
				plugin
			});
		}
		const bindTargets = selection.map((channel) => ({
			channel,
			accountId: accountIds[channel]?.trim()
		})).filter((value) => Boolean(value.accountId));
		if (bindTargets.length > 0) {
			if (await prompter.confirm({
				message: "Route these channel accounts to agents now?",
				initialValue: true
			})) {
				const agentSummaries = buildAgentSummaries(nextConfig);
				const defaultAgentId = resolveDefaultAgentId(nextConfig);
				for (const target of bindTargets) {
					const targetAgentId = await prompter.select({
						message: `Send ${target.channel}/${target.accountId} messages to agent`,
						options: agentSummaries.map((agent) => ({
							value: agent.id,
							label: agent.isDefault ? `${agent.id} (default)` : agent.id
						})),
						initialValue: defaultAgentId
					});
					const bindingResult = applyAgentBindings(nextConfig, [{
						agentId: targetAgentId,
						match: {
							channel: target.channel,
							accountId: target.accountId
						}
					}]);
					nextConfig = bindingResult.config;
					if (bindingResult.added.length > 0 || bindingResult.updated.length > 0) await prompter.note([...bindingResult.added.map((binding) => `Added: ${describeBinding(binding)}`), ...bindingResult.updated.map((binding) => `Updated: ${describeBinding(binding)}`)].join("\n"), "Routing bindings");
					if (bindingResult.conflicts.length > 0) await prompter.note(["Skipped bindings already claimed by another agent:", ...bindingResult.conflicts.map((conflict) => `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`)].join("\n"), "Routing bindings");
				}
			}
		}
		const committed = await commitConfigWithPendingPluginInstalls({
			nextConfig,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		const writtenConfig = committed.config;
		if (committed.movedInstallRecords) await refreshPluginRegistryAfterConfigMutation({
			config: writtenConfig,
			reason: "source-changed",
			installRecords: committed.installRecords,
			logger: { warn: (message) => runtime.log(message) }
		});
		await onboardChannels.runCollectedChannelOnboardingPostWriteHooks({
			hooks: postWriteHooks.drain(),
			cfg: writtenConfig,
			runtime
		});
		await prompter.outro("Channels updated.");
		return;
	}
	const rawChannel = opts.channel ?? "";
	let channel = normalizeChannelId$1(rawChannel);
	let catalogEntry = await resolveCatalogChannelEntry(rawChannel, nextConfig);
	const resolveWorkspaceDir = () => resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
	const loadScopedPlugin = async (channelId, pluginId) => {
		const existing = getLoadedChannelPlugin(channelId);
		if (existing?.setup?.applyAccountConfig) return existing;
		const { loadChannelSetupPluginRegistrySnapshotForChannel } = await loadChannelSetupPluginInstall();
		const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
			cfg: nextConfig,
			runtime,
			channel: channelId,
			...pluginId ? { pluginId } : {},
			workspaceDir: resolveWorkspaceDir(),
			forceSetupOnlyChannelPlugins: true
		});
		return snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin ?? getBundledChannelSetupPlugin(channelId) ?? snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ?? existing;
	};
	if (catalogEntry) {
		const workspaceDir = resolveWorkspaceDir();
		const { isCatalogChannelInstalled } = await import("./discovery-BCfRk_rN.js");
		const registeredPlugin = channel ? getLoadedChannelPlugin(channel) : void 0;
		const bundledSetupPlugin = channel ? getBundledChannelSetupPlugin(channel) : void 0;
		if (!registeredPlugin && !bundledSetupPlugin && !isCatalogChannelInstalled({
			cfg: nextConfig,
			entry: catalogEntry,
			workspaceDir
		})) {
			const { ensureChannelSetupPluginInstalled } = await loadChannelSetupPluginInstall();
			const prompter = createClackPrompter();
			const result = await ensureChannelSetupPluginInstalled({
				cfg: nextConfig,
				entry: catalogEntry,
				prompter,
				runtime,
				workspaceDir,
				promptInstall: false
			});
			nextConfig = result.cfg;
			if (!result.installed) return;
			pluginRegistrySourceChanged = true;
			catalogEntry = {
				...catalogEntry,
				...result.pluginId ? { pluginId: result.pluginId } : {}
			};
		}
		channel ??= normalizeChannelId$1(catalogEntry.id) ?? catalogEntry.id;
	}
	if (!channel) {
		const hint = catalogEntry ? `Plugin ${catalogEntry.meta.label} could not be loaded after install. Run openclaw doctor --fix, then retry openclaw channels add.` : formatUnknownChannelMessage({ channel: rawChannel });
		runtime.error(hint);
		runtime.exit(1);
		return;
	}
	const plugin = await loadScopedPlugin(channel, catalogEntry?.pluginId);
	if (!plugin?.setup?.applyAccountConfig) {
		runtime.error(`${formatUnsupportedChannelActionMessage({
			channel,
			action: "non-interactive add"
		})} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`);
		runtime.exit(1);
		return;
	}
	const input = buildChannelSetupInput(opts);
	const accountId = plugin.setup.resolveAccountId?.({
		cfg: nextConfig,
		accountId: opts.account,
		input
	}) ?? normalizeAccountId(opts.account);
	const validationError = plugin.setup.validateInput?.({
		cfg: nextConfig,
		accountId,
		input
	});
	if (validationError) {
		runtime.error(validationError);
		runtime.exit(1);
		return;
	}
	const prevConfig = nextConfig;
	if (accountId !== "default") nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
		cfg: nextConfig,
		channelKey: channel
	});
	nextConfig = applyChannelAccountConfig({
		cfg: nextConfig,
		channel,
		accountId,
		input,
		plugin
	});
	await plugin.lifecycle?.onAccountConfigChanged?.({
		prevCfg: prevConfig,
		nextCfg: nextConfig,
		accountId,
		runtime
	});
	const committed = await commitConfigWithPendingPluginInstalls({
		nextConfig,
		...baseHash !== void 0 ? { baseHash } : {}
	});
	const writtenConfig = committed.config;
	if (committed.movedInstallRecords || pluginRegistrySourceChanged) await refreshPluginRegistryAfterConfigMutation({
		config: writtenConfig,
		reason: "source-changed",
		...committed.movedInstallRecords ? { installRecords: committed.installRecords } : {},
		logger: { warn: (message) => runtime.log(message) }
	});
	runtime.log(`Added ${plugin.meta.label ?? channelLabel(channel)} account "${accountId}".`);
	const afterAccountConfigWritten = plugin.setup?.afterAccountConfigWritten;
	if (afterAccountConfigWritten) {
		const { runCollectedChannelOnboardingPostWriteHooks } = await loadOnboardChannels();
		await runCollectedChannelOnboardingPostWriteHooks({
			hooks: [{
				channel,
				accountId,
				run: async ({ cfg: writtenCfg, runtime: hookRuntime }) => await afterAccountConfigWritten({
					previousCfg: cfg,
					cfg: writtenCfg,
					accountId,
					input,
					runtime: hookRuntime
				})
			}],
			cfg: writtenConfig,
			runtime
		});
	}
}
//#endregion
//#region src/commands/channels/capabilities.ts
function normalizeTimeout(raw, fallback = 1e4) {
	const value = typeof raw === "string" ? Number(raw) : Number(raw);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}
function formatSupport(capabilities) {
	if (!capabilities) return "unknown";
	const bits = [];
	if (capabilities.chatTypes?.length) bits.push(`chatTypes=${capabilities.chatTypes.join(",")}`);
	if (capabilities.polls) bits.push("polls");
	if (capabilities.reactions) bits.push("reactions");
	if (capabilities.edit) bits.push("edit");
	if (capabilities.unsend) bits.push("unsend");
	if (capabilities.reply) bits.push("reply");
	if (capabilities.effects) bits.push("effects");
	if (capabilities.groupManagement) bits.push("groupManagement");
	if (capabilities.threads) bits.push("threads");
	if (capabilities.media) bits.push("media");
	if (capabilities.nativeCommands) bits.push("nativeCommands");
	if (capabilities.blockStreaming) bits.push("blockStreaming");
	return bits.length ? bits.join(" ") : "none";
}
function formatGenericProbeLines(probe) {
	if (!probe || typeof probe !== "object") return [];
	const probeObj = probe;
	const ok = typeof probeObj.ok === "boolean" ? probeObj.ok : void 0;
	if (ok === true) return [{ text: "Probe: ok" }];
	if (ok === false) return [{
		text: `Probe: failed${typeof probeObj.error === "string" && probeObj.error ? ` (${probeObj.error})` : ""}`,
		tone: "error"
	}];
	return [];
}
function renderDisplayLine(line) {
	switch (line.tone) {
		case "muted": return theme.muted(line.text);
		case "success": return theme.success(line.text);
		case "warn": return theme.warn(line.text);
		case "error": return theme.error(line.text);
		default: return line.text;
	}
}
async function resolveChannelReports(params) {
	const { plugin, cfg, timeoutMs } = params;
	const accountIds = params.accountOverride ? [params.accountOverride] : (() => {
		const ids = plugin.config.listAccountIds(cfg);
		return ids.length > 0 ? ids : [resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds: ids
		})];
	})();
	const reports = [];
	for (const accountId of accountIds) {
		const resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
		const configured = plugin.config.isConfigured ? await plugin.config.isConfigured(resolvedAccount, cfg) : Boolean(resolvedAccount);
		const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(resolvedAccount, cfg) : resolvedAccount.enabled !== false;
		let probe;
		if (configured && enabled && plugin.status?.probeAccount) try {
			probe = await plugin.status.probeAccount({
				account: resolvedAccount,
				timeoutMs,
				cfg
			});
		} catch (err) {
			probe = {
				ok: false,
				error: formatErrorMessage(err)
			};
		}
		const diagnostics = configured && enabled ? await plugin.status?.buildCapabilitiesDiagnostics?.({
			account: resolvedAccount,
			timeoutMs,
			cfg,
			probe,
			target: params.target
		}) : void 0;
		const discoveredActions = resolveMessageActionDiscoveryForPlugin({
			pluginId: plugin.id,
			actions: plugin.actions,
			context: createMessageActionDiscoveryContext({
				cfg,
				accountId
			}),
			includeActions: true
		}).actions;
		const actions = Array.from(new Set([
			"send",
			"broadcast",
			...discoveredActions.map((action) => action)
		]));
		reports.push({
			plugin,
			channel: plugin.id,
			accountId,
			accountName: typeof resolvedAccount.name === "string" ? normalizeOptionalString(resolvedAccount.name) : void 0,
			configured,
			enabled,
			support: plugin.capabilities,
			probe,
			actions,
			diagnostics
		});
	}
	return reports;
}
async function channelsCapabilitiesCommand(opts, runtime = defaultRuntime) {
	const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
	const loadedCfg = await requireValidConfig(runtime);
	if (!loadedCfg) return;
	let cfg = loadedCfg;
	const timeoutMs = normalizeTimeout(opts.timeout, 1e4);
	const rawChannel = normalizeLowercaseStringOrEmpty(opts.channel);
	const rawTarget = normalizeOptionalString(opts.target) ?? "";
	if (opts.account && (!rawChannel || rawChannel === "all")) {
		runtime.error(danger(`--account requires a specific --channel. Run ${formatCliCommand("openclaw channels list")} to choose one.`));
		runtime.exit(1);
		return;
	}
	if (rawTarget && (!rawChannel || rawChannel === "all")) {
		runtime.error(danger(`--target requires a specific --channel. Run ${formatCliCommand("openclaw channels list")} to choose one.`));
		runtime.exit(1);
		return;
	}
	const plugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: true });
	const selected = !rawChannel || rawChannel === "all" ? plugins : await (async () => {
		const resolved = await resolveInstallableChannelPlugin({
			cfg,
			runtime,
			rawChannel,
			allowInstall: true
		});
		if (resolved.configChanged) {
			cfg = resolved.cfg;
			if (Boolean(cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length > 0)) {
				const committed = await commitConfigWithPendingPluginInstalls({
					nextConfig: cfg,
					baseHash: (await sourceSnapshotPromise)?.hash
				});
				cfg = committed.config;
				await refreshPluginRegistryAfterConfigMutation({
					config: cfg,
					reason: "source-changed",
					installRecords: committed.installRecords,
					logger: { warn: (message) => runtime.log(message) }
				});
			} else {
				await replaceConfigFile({
					nextConfig: cfg,
					baseHash: (await sourceSnapshotPromise)?.hash
				});
				if (resolved.pluginInstalled) await refreshPluginRegistryAfterConfigMutation({
					config: cfg,
					reason: "source-changed",
					logger: { warn: (message) => runtime.log(message) }
				});
			}
		}
		return resolved.plugin ? [resolved.plugin] : null;
	})();
	if (!selected || selected.length === 0) {
		runtime.error(danger(formatUnknownChannelMessage({ channel: rawChannel })));
		runtime.exit(1);
		return;
	}
	const reports = [];
	for (const plugin of selected) {
		const accountOverride = normalizeOptionalString(opts.account);
		reports.push(...await resolveChannelReports({
			plugin,
			cfg,
			timeoutMs,
			accountOverride,
			target: rawTarget || void 0
		}));
	}
	if (opts.json) {
		writeRuntimeJson(runtime, { channels: reports });
		return;
	}
	const lines = [];
	for (const report of reports) {
		const label = formatChannelAccountLabel({
			channel: report.channel,
			accountId: report.accountId,
			name: report.accountName,
			channelLabel: report.plugin.meta.label ?? report.channel,
			channelStyle: theme.accent,
			accountStyle: theme.heading
		});
		lines.push(theme.heading(label));
		lines.push(`Support: ${formatSupport(report.support)}`);
		if (report.actions && report.actions.length > 0) lines.push(`Actions: ${report.actions.join(", ")}`);
		if (report.configured === false || report.enabled === false) {
			const configuredLabel = report.configured === false ? "not configured" : "configured";
			const enabledLabel = report.enabled === false ? "disabled" : "enabled";
			lines.push(`Status: ${configuredLabel}, ${enabledLabel}`);
		}
		const probeLines = report.plugin.status?.formatCapabilitiesProbe?.({ probe: report.probe }) ?? formatGenericProbeLines(report.probe);
		if (probeLines.length > 0) lines.push(...probeLines.map(renderDisplayLine));
		else if (report.configured && report.enabled) lines.push(theme.muted("Probe: unavailable"));
		if (report.diagnostics?.lines?.length) lines.push(...report.diagnostics.lines.map(renderDisplayLine));
		lines.push("");
	}
	runtime.log(lines.join("\n").trimEnd());
}
//#endregion
//#region src/commands/channels/logs.ts
const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1e6;
function listManifestChannelIds() {
	return new Set(listManifestChannelContributionIds({
		includeDisabled: true,
		env: process.env
	}));
}
function parseChannelFilter(raw) {
	const trimmed = normalizeLowercaseStringOrEmpty(raw);
	if (!trimmed || trimmed === "all") return "all";
	const bundled = normalizeChannelId(trimmed);
	if (bundled) return bundled;
	return listManifestChannelIds().has(trimmed) ? trimmed : "all";
}
function matchesChannel(line, channel) {
	if (channel === "all") return true;
	const needle = `gateway/channels/${channel}`;
	if (line.subsystem?.includes(needle)) return true;
	if (line.module?.includes(channel)) return true;
	return false;
}
async function readTailLines(file, limit) {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) return [];
	const size = stat.size;
	const start = Math.max(0, size - MAX_BYTES);
	const handle = await fs.open(file, "r");
	try {
		let prefix = "";
		if (start > 0) {
			const prefixBuf = Buffer.alloc(1);
			const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
			prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
		}
		const length = Math.max(0, size - start);
		if (length === 0) return [];
		const buffer = Buffer.alloc(length);
		const readResult = await handle.read(buffer, 0, length, start);
		let lines = buffer.toString("utf8", 0, readResult.bytesRead).split("\n");
		if (start > 0 && prefix !== "\n") lines = lines.slice(1);
		if (lines.length && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
		if (lines.length > limit) lines = lines.slice(lines.length - limit);
		return lines;
	} finally {
		await handle.close();
	}
}
async function channelsLogsCommand(opts, runtime = defaultRuntime) {
	const channel = parseChannelFilter(opts.channel);
	const limitRaw = typeof opts.lines === "string" ? Number(opts.lines) : opts.lines;
	const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
	const file = await resolveLogFile(getResolvedLoggerSettings().file);
	const filtered = (await readTailLines(file, limit * 4)).map(parseLogLine).filter((line) => Boolean(line)).filter((line) => matchesChannel(line, channel));
	const lines = filtered.slice(Math.max(0, filtered.length - limit));
	if (opts.json) {
		writeRuntimeJson(runtime, {
			file,
			channel,
			lines
		});
		return;
	}
	runtime.log(theme.info(`Log file: ${file}`));
	if (channel !== "all") runtime.log(theme.info(`Channel: ${channel}`));
	if (lines.length === 0) {
		runtime.log(theme.muted("No matching log lines."));
		return;
	}
	for (const line of lines) {
		const ts = line.time ? `${line.time} ` : "";
		const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
		runtime.log(`${ts}${level}${line.message}`.trim());
	}
}
//#endregion
//#region src/commands/channels/remove.ts
function listAccountIds(cfg, channel, plugin) {
	plugin ??= getChannelPlugin(channel);
	if (!plugin) return [];
	return plugin.config.listAccountIds(cfg);
}
async function stopGatewayRuntimeBeforeRemove(params) {
	if (!params.plugin.gateway?.startAccount && !params.plugin.gateway?.logoutAccount) return;
	try {
		await callGateway({
			config: params.cfg,
			method: "channels.stop",
			params: {
				channel: params.channel,
				accountId: params.accountId
			},
			mode: GATEWAY_CLIENT_MODES.BACKEND,
			clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
			deviceIdentity: null
		});
	} catch (error) {
		params.runtime.log(`Could not stop running ${channelLabel(params.channel)} account "${params.accountId}" before removing it: ${formatErrorMessage(error)}`);
	}
}
async function channelsRemoveCommand(opts, runtime = defaultRuntime, params) {
	const configSnapshot = await requireValidConfigFileSnapshot(runtime);
	if (!configSnapshot) return;
	const baseHash = configSnapshot.hash;
	let cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
	const useWizard = shouldUseWizard(params);
	const prompter = useWizard ? createClackPrompter() : null;
	const rawChannel = normalizeOptionalString(opts.channel) ?? "";
	let lookupChannel = rawChannel;
	let channel = normalizeChannelId$1(rawChannel);
	let accountId = normalizeAccountId(opts.account);
	const deleteConfig = Boolean(opts.delete);
	if (useWizard && prompter) {
		await prompter.intro("Remove channel account");
		const readOnlyPlugins = listReadOnlyChannelPluginsForConfig(cfg, { includeSetupFallbackPlugins: true });
		const selectedChannel = await prompter.select({
			message: "Channel",
			options: readOnlyPlugins.map((plugin) => ({
				value: plugin.id,
				label: plugin.meta.label
			}))
		});
		channel = selectedChannel;
		lookupChannel = selectedChannel;
		accountId = await (async () => {
			const readOnlyPlugin = readOnlyPlugins.find((plugin) => plugin.id === selectedChannel);
			const ids = listAccountIds(cfg, selectedChannel, readOnlyPlugin);
			return normalizeAccountId(await prompter.select({
				message: "Account",
				options: ids.map((id) => ({
					value: id,
					label: id === "default" ? "default (primary)" : id
				})),
				initialValue: ids[0] ?? "default"
			}));
		})();
		if (!await prompter.confirm({
			message: `Disable ${channelLabel(selectedChannel)} account "${accountId}"? (keeps config)`,
			initialValue: true
		})) {
			await prompter.outro("Cancelled.");
			return;
		}
	} else {
		if (!rawChannel) {
			runtime.error(`Missing channel. Use ${formatCliCommand("openclaw channels remove --channel <name>")} or run ${formatCliCommand("openclaw channels status")} to inspect configured channels.`);
			runtime.exit(1);
			return;
		}
		if (!deleteConfig) {
			const confirm = createClackPrompter();
			const channelPromptLabel = channel ? channelLabel(channel) : rawChannel;
			if (!await confirm.confirm({
				message: `Disable ${channelPromptLabel} account "${accountId}"? (keeps config)`,
				initialValue: true
			})) return;
		}
	}
	const resolvedPluginState = Boolean(lookupChannel || channel) ? await (async () => {
		const { resolveInstallableChannelPlugin } = await import("./channel-plugin-resolution-BnMAdJwU.js");
		return await resolveInstallableChannelPlugin({
			cfg,
			runtime,
			rawChannel: lookupChannel,
			allowInstall: false
		});
	})() : null;
	if (resolvedPluginState?.configChanged) cfg = resolvedPluginState.cfg;
	const resolvedChannel = resolvedPluginState?.channelId ?? channel;
	if (!resolvedChannel) {
		runtime.error(formatUnknownChannelMessage({ channel: rawChannel }));
		runtime.exit(1);
		return;
	}
	channel = resolvedChannel;
	const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
	if (!plugin) {
		if (resolvedPluginState?.catalogEntry) {
			runtime.error(`Channel plugin "${resolvedPluginState.catalogEntry.id}" is not installed. Run ${formatCliCommand(`openclaw channels add --channel ${resolvedPluginState.catalogEntry.id}`)} first.`);
			runtime.exit(1);
			return;
		}
		runtime.error(formatUnknownChannelMessage({ channel: resolvedChannel }));
		runtime.exit(1);
		return;
	}
	const resolvedChannelId = resolvedChannel;
	const resolvedAccountId = normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({
		plugin,
		cfg
	});
	const accountKey = resolvedAccountId || "default";
	await stopGatewayRuntimeBeforeRemove({
		cfg,
		channel: resolvedChannelId,
		accountId: accountKey,
		plugin,
		runtime
	});
	let next = { ...cfg };
	const prevCfg = cfg;
	if (deleteConfig) {
		if (!plugin.config.deleteAccount) {
			runtime.error(`${formatUnsupportedChannelActionMessage({
				channel,
				action: "delete"
			})} Use ${formatCliCommand("openclaw channels remove --channel " + channel)} to disable it without deleting config.`);
			runtime.exit(1);
			return;
		}
		next = plugin.config.deleteAccount({
			cfg: next,
			accountId: resolvedAccountId
		});
		await plugin.lifecycle?.onAccountRemoved?.({
			prevCfg,
			accountId: resolvedAccountId,
			runtime
		});
	} else {
		if (!plugin.config.setAccountEnabled) {
			runtime.error(`${formatUnsupportedChannelActionMessage({
				channel,
				action: "disable"
			})} Use ${formatCliCommand("openclaw channels remove --channel " + channel + " --delete")} only if you want to remove config.`);
			runtime.exit(1);
			return;
		}
		next = plugin.config.setAccountEnabled({
			cfg: next,
			accountId: resolvedAccountId,
			enabled: false
		});
		await plugin.lifecycle?.onAccountConfigChanged?.({
			prevCfg,
			nextCfg: next,
			accountId: resolvedAccountId,
			runtime
		});
	}
	if (Boolean(next.plugins?.installs && Object.keys(next.plugins.installs).length > 0)) {
		const committed = await commitConfigWithPendingPluginInstalls({
			nextConfig: next,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		next = committed.config;
		await refreshPluginRegistryAfterConfigMutation({
			config: next,
			reason: "source-changed",
			installRecords: committed.installRecords,
			logger: { warn: (message) => runtime.log(message) }
		});
	} else {
		await replaceConfigFile({
			nextConfig: next,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		if (resolvedPluginState?.pluginInstalled) await refreshPluginRegistryAfterConfigMutation({
			config: next,
			reason: "source-changed",
			logger: { warn: (message) => runtime.log(message) }
		});
	}
	if (useWizard && prompter) await prompter.outro(deleteConfig ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".` : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`);
	else runtime.log(deleteConfig ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".` : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`);
}
//#endregion
//#region src/commands/channels/resolve.ts
function resolvePreferredKind(kind) {
	if (!kind || kind === "auto") return;
	if (kind === "user") return "user";
	return "group";
}
function detectAutoKind(input) {
	const trimmed = input.trim();
	if (!trimmed) return "group";
	if (trimmed.startsWith("@")) return "user";
	if (/^<@!?/.test(trimmed)) return "user";
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "user";
	if (/^user:/i.test(trimmed)) return "user";
	return "group";
}
function detectAutoKindForPlugin(input, plugin) {
	const generic = detectAutoKind(input);
	if (generic === "user" || !plugin) return generic;
	const lowered = normalizeLowercaseStringOrEmpty(input.trim());
	const prefixes = [plugin.id, ...plugin.meta?.aliases ?? []].map((entry) => normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry));
	for (const prefix of prefixes) {
		if (!lowered.startsWith(`${prefix}:`)) continue;
		const remainder = lowered.slice(prefix.length + 1);
		if (remainder.startsWith("group:") || remainder.startsWith("channel:") || remainder.startsWith("room:") || remainder.startsWith("conversation:") || remainder.startsWith("spaces/") || remainder.startsWith("channels/")) return "group";
		return "user";
	}
	return generic;
}
function formatResolveResult(result) {
	if (!result.resolved || !result.id) return `${result.input} -> unresolved`;
	const name = result.name ? ` (${result.name})` : "";
	const note = result.note ? ` [${result.note}]` : "";
	return `${result.input} -> ${result.id}${name}${note}`;
}
async function channelsResolveCommand(opts, runtime) {
	const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
	let { effectiveConfig: cfg } = await resolveCommandConfigWithSecrets({
		config: getRuntimeConfig(),
		commandName: "channels resolve",
		targetIds: getChannelsCommandSecretTargetIds(),
		mode: "read_only_operational",
		runtime,
		autoEnable: true
	});
	const entries = (opts.entries ?? []).map((entry) => entry.trim()).filter(Boolean);
	if (entries.length === 0) throw new Error(`At least one entry is required. Example: ${formatCliCommand("openclaw channels resolve --channel discord <name-or-id>")}.`);
	const explicitChannel = opts.channel?.trim();
	const resolvedExplicit = explicitChannel ? await resolveInstallableChannelPlugin({
		cfg,
		runtime,
		rawChannel: explicitChannel,
		allowInstall: false,
		supports: (plugin) => Boolean(plugin.resolver?.resolveTargets)
	}) : null;
	if (explicitChannel && resolvedExplicit?.catalogEntry && !resolvedExplicit.plugin) throw new Error(`Channel plugin "${resolvedExplicit.catalogEntry.id}" is not installed. Run ${formatCliCommand(`openclaw channels add --channel ${resolvedExplicit.catalogEntry.id}`)} first.`);
	if (resolvedExplicit?.configChanged) {
		cfg = resolvedExplicit.cfg;
		if (Boolean(cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length > 0)) {
			const committed = await commitConfigWithPendingPluginInstalls({
				nextConfig: cfg,
				baseHash: (await sourceSnapshotPromise)?.hash
			});
			cfg = committed.config;
			await refreshPluginRegistryAfterConfigMutation({
				config: cfg,
				reason: "source-changed",
				installRecords: committed.installRecords,
				logger: { warn: (message) => runtime.log(message) }
			});
		} else {
			await replaceConfigFile({
				nextConfig: cfg,
				baseHash: (await sourceSnapshotPromise)?.hash
			});
			if (resolvedExplicit.pluginInstalled) await refreshPluginRegistryAfterConfigMutation({
				config: cfg,
				reason: "source-changed",
				logger: { warn: (message) => runtime.log(message) }
			});
		}
	}
	const selection = explicitChannel ? { channel: resolvedExplicit?.channelId } : await resolveMessageChannelSelection({
		cfg,
		channel: opts.channel ?? null
	});
	const plugin = (explicitChannel ? resolvedExplicit?.plugin : void 0) ?? (selection.channel ? getChannelPlugin(selection.channel) : void 0);
	if (!plugin?.resolver?.resolveTargets) {
		const channelText = selection.channel ?? explicitChannel ?? "";
		throw new Error(formatUnsupportedChannelActionMessage({
			channel: channelText,
			action: "resolve"
		}));
	}
	const preferredKind = resolvePreferredKind(opts.kind);
	let results = [];
	if (preferredKind) results = (await plugin.resolver.resolveTargets({
		cfg,
		accountId: opts.account ?? null,
		inputs: entries,
		kind: preferredKind,
		runtime
	})).map((entry) => ({
		input: entry.input,
		resolved: entry.resolved,
		id: entry.id,
		name: entry.name,
		note: entry.note
	}));
	else {
		const byKind = /* @__PURE__ */ new Map();
		for (const entry of entries) {
			const kind = detectAutoKindForPlugin(entry, plugin);
			byKind.set(kind, [...byKind.get(kind) ?? [], entry]);
		}
		const resolved = [];
		for (const [kind, inputs] of byKind.entries()) {
			const batch = await plugin.resolver.resolveTargets({
				cfg,
				accountId: opts.account ?? null,
				inputs,
				kind,
				runtime
			});
			resolved.push(...batch);
		}
		const byInput = new Map(resolved.map((entry) => [entry.input, entry]));
		results = entries.map((input) => {
			const entry = byInput.get(input);
			return {
				input,
				resolved: entry?.resolved ?? false,
				id: entry?.id,
				name: entry?.name,
				note: entry?.note
			};
		});
	}
	if (opts.json) {
		writeRuntimeJson(runtime, results);
		return;
	}
	for (const result of results) if (result.resolved && result.id) runtime.log(formatResolveResult(result));
	else runtime.error(danger(`${result.input} -> unresolved${result.error ? ` (${result.error})` : result.note ? ` (${result.note})` : ""}`));
}
//#endregion
export { channelsAddCommand, channelsCapabilitiesCommand, channelsListCommand, channelsLogsCommand, channelsRemoveCommand, channelsResolveCommand, channelsStatusCommand, formatGatewayChannelsStatusLines };
