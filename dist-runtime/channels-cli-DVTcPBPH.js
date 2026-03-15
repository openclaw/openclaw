import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import { s as setVerbose, t as danger } from "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import { r as theme } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { t as hasExplicitOptions } from "./command-options-CwQM9XPT.js";
import { Ba as resolveMessageChannelSelection, Bb as loadConfig, in as formatHelpExamples } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import { Q as normalizeChannelId, X as getChannelPlugin } from "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import { U as resolveChannelDefaultAccountId } from "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import { n as runCommandWithRuntime } from "./cli-utils-DRykF2zj.js";
import "./channel-plugin-ids-DDJhum8r.js";
import "./plugin-registry-DPMvuo5T.js";
import { t as formatCliChannelOptions } from "./channel-options-B8KkoCsP.js";
//#region src/cli/channel-auth.ts
async function resolveChannelPluginForMode(opts, mode, cfg) {
	const explicitChannel = opts.channel?.trim();
	const channelInput = explicitChannel ? explicitChannel : (await resolveMessageChannelSelection({ cfg })).channel;
	const channelId = normalizeChannelId(channelInput);
	if (!channelId) {throw new Error(`Unsupported channel: ${channelInput}`);}
	const plugin = getChannelPlugin(channelId);
	if (!(mode === "login" ? Boolean(plugin?.auth?.login) : Boolean(plugin?.gateway?.logoutAccount))) {throw new Error(`Channel ${channelId} does not support ${mode}`);}
	return {
		channelInput,
		channelId,
		plugin
	};
}
function resolveAccountContext(plugin, opts, cfg) {
	return { accountId: opts.account?.trim() || resolveChannelDefaultAccountId({
		plugin,
		cfg
	}) };
}
async function runChannelLogin(opts, runtime = defaultRuntime) {
	const cfg = loadConfig();
	const { channelInput, plugin } = await resolveChannelPluginForMode(opts, "login", cfg);
	const login = plugin.auth?.login;
	if (!login) {throw new Error(`Channel ${channelInput} does not support login`);}
	setVerbose(Boolean(opts.verbose));
	const { accountId } = resolveAccountContext(plugin, opts, cfg);
	await login({
		cfg,
		accountId,
		runtime,
		verbose: Boolean(opts.verbose),
		channelInput
	});
}
async function runChannelLogout(opts, runtime = defaultRuntime) {
	const cfg = loadConfig();
	const { channelInput, plugin } = await resolveChannelPluginForMode(opts, "logout", cfg);
	const logoutAccount = plugin.gateway?.logoutAccount;
	if (!logoutAccount) {throw new Error(`Channel ${channelInput} does not support logout`);}
	const { accountId } = resolveAccountContext(plugin, opts, cfg);
	await logoutAccount({
		cfg,
		accountId,
		account: plugin.config.resolveAccount(cfg, accountId),
		runtime
	});
}
//#endregion
//#region src/cli/channels-cli.ts
const optionNamesAdd = [
	"channel",
	"account",
	"name",
	"token",
	"privateKey",
	"tokenFile",
	"botToken",
	"appToken",
	"signalNumber",
	"cliPath",
	"dbPath",
	"service",
	"region",
	"authDir",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"audienceType",
	"audience",
	"useEnv",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"initialSyncLimit",
	"ship",
	"url",
	"relayUrls",
	"code",
	"groupChannels",
	"dmAllowlist",
	"autoDiscoverChannels"
];
const optionNamesRemove = [
	"channel",
	"account",
	"delete"
];
function runChannelsCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action);
}
function runChannelsCommandWithDanger(action, label) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(`${label}: ${String(err)}`));
		defaultRuntime.exit(1);
	});
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
			const { channelsListCommand } = await import("./channels-7abIwwh_.js");
			await channelsListCommand(opts, defaultRuntime);
		});
	});
	channels.command("status").description("Show gateway channel status (use status --deep for local)").option("--probe", "Probe channel credentials", false).option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsStatusCommand } = await import("./channels-7abIwwh_.js");
			await channelsStatusCommand(opts, defaultRuntime);
		});
	});
	channels.command("capabilities").description("Show provider capabilities (intents/scopes + supported features)").option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`).option("--account <id>", "Account id (only with --channel)").option("--target <dest>", "Channel target for permission audit (Discord channel:<id>)").option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsCapabilitiesCommand } = await import("./channels-7abIwwh_.js");
			await channelsCapabilitiesCommand(opts, defaultRuntime);
		});
	});
	channels.command("resolve").description("Resolve channel/user names to IDs").argument("<entries...>", "Entries to resolve (names or ids)").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (accountId)").option("--kind <kind>", "Target kind (auto|user|group)", "auto").option("--json", "Output JSON", false).action(async (entries, opts) => {
		await runChannelsCommand(async () => {
			const { channelsResolveCommand } = await import("./channels-7abIwwh_.js");
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
			const { channelsLogsCommand } = await import("./channels-7abIwwh_.js");
			await channelsLogsCommand(opts, defaultRuntime);
		});
	});
	channels.command("add").description("Add or update a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--name <name>", "Display name for this account").option("--token <token>", "Bot token (Telegram/Discord)").option("--private-key <key>", "Nostr private key (nsec... or hex)").option("--token-file <path>", "Bot token file (Telegram)").option("--bot-token <token>", "Slack bot token (xoxb-...)").option("--app-token <token>", "Slack app token (xapp-...)").option("--signal-number <e164>", "Signal account number (E.164)").option("--cli-path <path>", "CLI path (signal-cli or imsg)").option("--db-path <path>", "iMessage database path").option("--service <service>", "iMessage service (imessage|sms|auto)").option("--region <region>", "iMessage region (for SMS)").option("--auth-dir <path>", "WhatsApp auth directory override").option("--http-url <url>", "Signal HTTP daemon base URL").option("--http-host <host>", "Signal HTTP host").option("--http-port <port>", "Signal HTTP port").option("--webhook-path <path>", "Webhook path (Google Chat/BlueBubbles)").option("--webhook-url <url>", "Google Chat webhook URL").option("--audience-type <type>", "Google Chat audience type (app-url|project-number)").option("--audience <value>", "Google Chat audience value (app URL or project number)").option("--homeserver <url>", "Matrix homeserver URL").option("--user-id <id>", "Matrix user ID").option("--access-token <token>", "Matrix access token").option("--password <password>", "Matrix password").option("--device-name <name>", "Matrix device name").option("--initial-sync-limit <n>", "Matrix initial sync limit").option("--ship <ship>", "Tlon ship name (~sampel-palnet)").option("--url <url>", "Tlon ship URL").option("--relay-urls <list>", "Nostr relay URLs (comma-separated)").option("--code <code>", "Tlon login code").option("--group-channels <list>", "Tlon group channels (comma-separated)").option("--dm-allowlist <list>", "Tlon DM allowlist (comma-separated ships)").option("--auto-discover-channels", "Tlon auto-discover group channels").option("--no-auto-discover-channels", "Disable Tlon auto-discovery").option("--use-env", "Use env token (default account only)", false).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsAddCommand } = await import("./channels-7abIwwh_.js");
			await channelsAddCommand(opts, defaultRuntime, { hasFlags: hasExplicitOptions(command, optionNamesAdd) });
		});
	});
	channels.command("remove").description("Disable or delete a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--delete", "Delete config entries (no prompt)", false).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsRemoveCommand } = await import("./channels-7abIwwh_.js");
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
}
//#endregion
export { registerChannelsCli };
