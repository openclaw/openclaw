import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { t as hasExplicitOptions } from "./command-options-C2ZTJm5U.js";
import { t as isBlockedObjectKey } from "./prototype-keys-RBElZn9Q.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { S as setVerbose } from "./logger-CbfAwt-Z.js";
import { t as danger } from "./globals-Dn_zSD2h.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DJ0qH7nz.js";
import "./config-BxdAfCU3.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BcGK4jUE.js";
import "./message-channel-B0Hwc40C.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-WDuMzUkg.js";
import { a as normalizeChannelId, i as listChannelPlugins } from "./registry-BVxojULH.js";
import "./plugins-DgDChB_6.js";
import { i as callGateway } from "./call-Bo0kEGD9.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-DSAkXmYY.js";
import { n as runCommandWithRuntime } from "./cli-utils-Bfcw6rvE.js";
import { t as formatHelpExamples } from "./help-format-DFHaQDoJ.js";
import { t as commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit-B2ZFk6Vv.js";
import { n as listBundledPackageChannelMetadata } from "./bundled-package-channel-metadata-ClwQ4bAc.js";
import { t as resolveInstallableChannelPlugin } from "./channel-plugin-resolution-WYKowelz.js";
import { t as formatCliChannelOptions } from "./channel-options-Cq5wvsBY.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-C2QhuOIv.js";
//#region src/cli/channel-auth.ts
function supportsChannelAuthMode(plugin, mode) {
	return mode === "login" ? Boolean(plugin.auth?.login) : Boolean(plugin.gateway?.logoutAccount);
}
function isConfiguredAuthPlugin(plugin, cfg) {
	const key = plugin.id;
	if (isBlockedObjectKey(key)) return false;
	const channelCfg = cfg.channels?.[key];
	if (channelCfg && typeof channelCfg === "object" && "enabled" in channelCfg && channelCfg.enabled === false) return false;
	for (const accountId of plugin.config.listAccountIds(cfg)) try {
		const account = plugin.config.resolveAccount(cfg, accountId);
		if (plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : account && typeof account === "object" ? account.enabled ?? true : true) return true;
	} catch {
		continue;
	}
	return false;
}
function resolveConfiguredAuthChannelInput(cfg, mode) {
	const configured = listChannelPlugins().filter((plugin) => supportsChannelAuthMode(plugin, mode)).filter((plugin) => isConfiguredAuthPlugin(plugin, cfg)).map((plugin) => plugin.id);
	if (configured.length === 1) return configured[0];
	if (configured.length === 0) throw new Error(`Channel is required (no configured channels support ${mode}).`);
	const safeIds = configured.map(sanitizeForLog);
	throw new Error(`Channel is required when multiple configured channels support ${mode}: ${safeIds.join(", ")}`);
}
async function resolveChannelPluginForMode(opts, mode, cfg, runtime) {
	const channelInput = opts.channel?.trim() || resolveConfiguredAuthChannelInput(cfg, mode);
	const normalizedChannelId = normalizeChannelId(channelInput);
	const resolved = await resolveInstallableChannelPlugin({
		cfg,
		runtime,
		rawChannel: channelInput,
		...normalizedChannelId ? { channelId: normalizedChannelId } : {},
		allowInstall: true,
		supports: (candidate) => supportsChannelAuthMode(candidate, mode)
	});
	const channelId = resolved.channelId ?? normalizedChannelId;
	if (!channelId) throw new Error(`Unsupported channel: ${channelInput}`);
	const plugin = resolved.plugin;
	if (!plugin || !supportsChannelAuthMode(plugin, mode)) throw new Error(`Channel ${channelId} does not support ${mode}`);
	return {
		cfg: resolved.cfg,
		configChanged: resolved.configChanged,
		channelInput,
		channelId,
		plugin
	};
}
function resolveAccountContext(plugin, opts, cfg) {
	return { accountId: normalizeOptionalString(opts.account) || resolveChannelDefaultAccountId({
		plugin,
		cfg
	}) };
}
async function reconcileGatewayRuntimeAfterLocalLogin(params) {
	if (!params.plugin.gateway?.startAccount) return;
	if (params.cfg.gateway?.mode === "remote") {
		params.runtime.log(`Gateway is in remote mode; local login saved auth for ${params.channelId}/${params.accountId} but did not start the remote runtime.`);
		return;
	}
	try {
		await callGateway({
			config: params.cfg,
			method: "channels.start",
			params: {
				channel: params.channelId,
				accountId: params.accountId
			},
			mode: GATEWAY_CLIENT_MODES.BACKEND,
			clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
			deviceIdentity: null
		});
	} catch (error) {
		params.runtime.log(`Local login saved auth for ${params.channelId}/${params.accountId}, but the running gateway did not restart it: ${formatErrorMessage(error)}`);
	}
}
async function logoutViaGatewayRuntime(params) {
	try {
		await callGateway({
			config: params.cfg,
			method: "channels.logout",
			params: {
				channel: params.channelId,
				accountId: params.accountId
			},
			mode: GATEWAY_CLIENT_MODES.BACKEND,
			clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
			deviceIdentity: null
		});
		return true;
	} catch (error) {
		if (params.cfg.gateway?.mode === "remote") throw error;
		params.runtime.log(`Local logout will clear auth for ${params.channelId}/${params.accountId}, but the running gateway did not stop it: ${formatErrorMessage(error)}`);
		return false;
	}
}
async function runChannelLogin(opts, runtime = defaultRuntime) {
	const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
	const autoEnabled = applyPluginAutoEnable({
		config: getRuntimeConfig(),
		env: process.env
	});
	const loadedCfg = autoEnabled.config;
	const resolvedChannel = await resolveChannelPluginForMode(opts, "login", loadedCfg, runtime);
	let cfg = resolvedChannel.cfg;
	const { configChanged, channelInput, plugin } = resolvedChannel;
	if (autoEnabled.changes.length > 0 || configChanged) cfg = (await commitConfigWithPendingPluginInstalls({
		nextConfig: cfg,
		baseHash: (await sourceSnapshotPromise)?.hash
	})).config;
	const login = plugin.auth?.login;
	if (!login) throw new Error(`Channel ${channelInput} does not support login`);
	setVerbose(Boolean(opts.verbose));
	const { accountId } = resolveAccountContext(plugin, opts, cfg);
	await login({
		cfg,
		accountId,
		runtime,
		verbose: Boolean(opts.verbose),
		channelInput
	});
	await reconcileGatewayRuntimeAfterLocalLogin({
		cfg,
		plugin,
		channelId: plugin.id,
		accountId,
		runtime
	});
}
async function runChannelLogout(opts, runtime = defaultRuntime) {
	const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
	const autoEnabled = applyPluginAutoEnable({
		config: getRuntimeConfig(),
		env: process.env
	});
	const loadedCfg = autoEnabled.config;
	const resolvedChannel = await resolveChannelPluginForMode(opts, "logout", loadedCfg, runtime);
	let cfg = resolvedChannel.cfg;
	const { configChanged, channelInput, plugin } = resolvedChannel;
	if (autoEnabled.changes.length > 0 || configChanged) cfg = (await commitConfigWithPendingPluginInstalls({
		nextConfig: cfg,
		baseHash: (await sourceSnapshotPromise)?.hash
	})).config;
	const logoutAccount = plugin.gateway?.logoutAccount;
	if (!logoutAccount) throw new Error(`Channel ${channelInput} does not support logout`);
	const { accountId } = resolveAccountContext(plugin, opts, cfg);
	if (await logoutViaGatewayRuntime({
		cfg,
		channelId: plugin.id,
		accountId,
		runtime
	})) return;
	const account = plugin.config.resolveAccount(cfg, accountId);
	await logoutAccount({
		cfg,
		accountId,
		account,
		runtime
	});
}
//#endregion
//#region src/cli/channels-cli.ts
const optionNamesRemove = [
	"channel",
	"account",
	"delete"
];
const channelsCommandsLoader = createLazyImportLoader(() => import("./channels-BxD_VEmm.js"));
function loadChannelsCommands() {
	return channelsCommandsLoader.load();
}
function runChannelsCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action);
}
function runChannelsCommandWithDanger(action, label) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(`${label}: ${String(err)}`));
		defaultRuntime.exit(1);
	});
}
function getOptionNames(command) {
	return command.options.map((option) => option.attributeName());
}
function addChannelSetupOptions(command) {
	const seenFlags = new Set(command.options.map((option) => option.flags));
	const channels = listBundledPackageChannelMetadata().toSorted((left, right) => {
		const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
		return leftOrder === rightOrder ? (left.id ?? "").localeCompare(right.id ?? "") : leftOrder - rightOrder;
	});
	for (const channel of channels) for (const option of channel.cliAddOptions ?? []) {
		if (seenFlags.has(option.flags)) continue;
		seenFlags.add(option.flags);
		if (option.defaultValue !== void 0) command.option(option.flags, option.description, option.defaultValue);
		else command.option(option.flags, option.description);
	}
	return command;
}
function registerChannelsCli(program) {
	const channelNames = formatCliChannelOptions();
	const channels = program.command("channels").description("Manage connected chat channels and accounts").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw channels list", "List configured channels and auth profiles."],
		["openclaw channels status --probe", "Run channel status checks and probes."],
		["openclaw channels add --channel telegram --token <token>", "Add or update a channel account non-interactively."],
		["openclaw channels login --channel whatsapp", "Link a WhatsApp Web account."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/channels", "docs.openclaw.ai/cli/channels")}\n`);
	channels.command("list").description("List configured channels + auth profiles").option("--no-usage", "Skip model provider usage/quota snapshots").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsListCommand } = await import("./list-DHhICKH8.js");
			await channelsListCommand(opts, defaultRuntime);
		});
	});
	channels.command("status").description("Show gateway channel status (use status --deep for local)").option("--probe", "Probe channel credentials", false).option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsStatusCommand } = await import("./status-pD380m7G.js");
			await channelsStatusCommand(opts, defaultRuntime);
		});
	});
	channels.command("capabilities").description("Show provider capabilities (intents/scopes + supported features)").option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`).option("--account <id>", "Account id (only with --channel)").option("--target <dest>", "Channel target for permission audit (Discord channel:<id>)").option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsCapabilitiesCommand } = await loadChannelsCommands();
			await channelsCapabilitiesCommand(opts, defaultRuntime);
		});
	});
	channels.command("resolve").description("Resolve channel/user names to IDs").argument("<entries...>", "Entries to resolve (names or ids)").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (accountId)").option("--kind <kind>", "Target kind (auto|user|group)", "auto").option("--json", "Output JSON", false).action(async (entries, opts) => {
		await runChannelsCommand(async () => {
			const { channelsResolveCommand } = await loadChannelsCommands();
			await channelsResolveCommand({
				channel: opts.channel,
				account: opts.account,
				kind: opts.kind,
				json: Boolean(opts.json),
				entries: Array.isArray(entries) ? entries : [String(entries)]
			}, defaultRuntime);
		});
	});
	channels.command("logs").description("Show recent channel logs from the gateway log file").option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`, "all").option("--lines <n>", "Number of lines (default: 200)", "200").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsLogsCommand } = await loadChannelsCommands();
			await channelsLogsCommand(opts, defaultRuntime);
		});
	});
	addChannelSetupOptions(channels.command("add").description("Add or update a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--name <name>", "Display name for this account").option("--token <token>", "Channel token or credential payload").option("--token-file <path>", "Read channel token or credential payload from file").option("--secret <secret>", "Channel shared secret").option("--secret-file <path>", "Read channel shared secret from file").option("--bot-token <token>", "Bot token").option("--app-token <token>", "App token").option("--password <password>", "Channel password or login secret").option("--cli-path <path>", "Channel CLI path").option("--url <url>", "Channel setup URL").option("--base-url <url>", "Channel base URL").option("--http-url <url>", "Channel HTTP service URL").option("--auth-dir <path>", "Channel auth directory override").option("--use-env", "Use env-backed credentials when supported", false)).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsAddCommand } = await loadChannelsCommands();
			await channelsAddCommand(opts, defaultRuntime, { hasFlags: hasExplicitOptions(command, getOptionNames(command)) });
		});
	});
	channels.command("remove").description("Disable or delete a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--delete", "Delete config entries (no prompt)", false).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsRemoveCommand } = await loadChannelsCommands();
			await channelsRemoveCommand(opts, defaultRuntime, { hasFlags: hasExplicitOptions(command, optionNamesRemove) });
		});
	});
	channels.command("login").description("Link a channel account (if supported)").option("--channel <channel>", "Channel alias (auto when only one is configured)").option("--account <id>", "Account id (accountId)").option("--verbose", "Verbose connection logs", false).action(async (opts) => {
		await runChannelsCommandWithDanger(async () => {
			await runChannelLogin({
				channel: opts.channel,
				account: opts.account,
				verbose: Boolean(opts.verbose)
			}, defaultRuntime);
		}, "Channel login failed");
	});
	channels.command("logout").description("Log out of a channel session (if supported)").option("--channel <channel>", "Channel alias (auto when only one is configured)").option("--account <id>", "Account id (accountId)").action(async (opts) => {
		await runChannelsCommandWithDanger(async () => {
			await runChannelLogout({
				channel: opts.channel,
				account: opts.account
			}, defaultRuntime);
		}, "Channel logout failed");
	});
	applyParentDefaultHelpAction(channels);
}
//#endregion
export { registerChannelsCli };
