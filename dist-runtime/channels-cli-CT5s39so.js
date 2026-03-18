import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import { c as setVerbose, r as init_globals, t as danger } from "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { t as hasExplicitOptions } from "./command-options-CwQM9XPT.js";
import { rn as formatHelpExamples, za as resolveMessageChannelSelection, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import { ft as normalizeChannelId, lt as getChannelPlugin } from "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { U as resolveChannelDefaultAccountId } from "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import { n as runCommandWithRuntime } from "./cli-utils-DRykF2zj.js";
import "./channel-plugin-ids-ys55Q6Ol.js";
import "./plugin-registry-VWAESv28.js";
import { t as formatCliChannelOptions } from "./channel-options-BbUDCwBp.js";
//#region src/cli/channel-auth.ts
init_theme();
init_globals();
init_runtime();
async function resolveChannelPluginForMode(opts, mode, cfg) {
	const explicitChannel = opts.channel?.trim();
	const channelInput = explicitChannel ? explicitChannel : (await resolveMessageChannelSelection({ cfg })).channel;
	const channelId = normalizeChannelId(channelInput);
	if (!channelId) throw new Error(`Unsupported channel: ${channelInput}`);
	const plugin = getChannelPlugin(channelId);
	if (!(mode === "login" ? Boolean(plugin?.auth?.login) : Boolean(plugin?.gateway?.logoutAccount))) throw new Error(`Channel ${channelId} does not support ${mode}`);
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
}
async function runChannelLogout(opts, runtime = defaultRuntime) {
	const cfg = loadConfig();
	const { channelInput, plugin } = await resolveChannelPluginForMode(opts, "logout", cfg);
	const logoutAccount = plugin.gateway?.logoutAccount;
	if (!logoutAccount) throw new Error(`Channel ${channelInput} does not support logout`);
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
init_globals();
init_runtime();
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
			const { channelsListCommand } = await import("./channels-CvWgFCG4.js");
			await channelsListCommand(opts, defaultRuntime);
		});
	});
	channels.command("status").description("Show gateway channel status (use status --deep for local)").option("--probe", "Probe channel credentials", false).option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsStatusCommand } = await import("./channels-CvWgFCG4.js");
			await channelsStatusCommand(opts, defaultRuntime);
		});
	});
	channels.command("capabilities").description("Show provider capabilities (intents/scopes + supported features)").option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`).option("--account <id>", "Account id (only with --channel)").option("--target <dest>", "Channel target for permission audit (Discord channel:<id>)").option("--timeout <ms>", "Timeout in ms", "10000").option("--json", "Output JSON", false).action(async (opts) => {
		await runChannelsCommand(async () => {
			const { channelsCapabilitiesCommand } = await import("./channels-CvWgFCG4.js");
			await channelsCapabilitiesCommand(opts, defaultRuntime);
		});
	});
	channels.command("resolve").description("Resolve channel/user names to IDs").argument("<entries...>", "Entries to resolve (names or ids)").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (accountId)").option("--kind <kind>", "Target kind (auto|user|group)", "auto").option("--json", "Output JSON", false).action(async (entries, opts) => {
		await runChannelsCommand(async () => {
			const { channelsResolveCommand } = await import("./channels-CvWgFCG4.js");
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
			const { channelsLogsCommand } = await import("./channels-CvWgFCG4.js");
			await channelsLogsCommand(opts, defaultRuntime);
		});
	});
	channels.command("add").description("Add or update a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--name <name>", "Display name for this account").option("--token <token>", "Bot token (Telegram/Discord)").option("--private-key <key>", "Nostr private key (nsec... or hex)").option("--token-file <path>", "Bot token file (Telegram)").option("--bot-token <token>", "Slack bot token (xoxb-...)").option("--app-token <token>", "Slack app token (xapp-...)").option("--signal-number <e164>", "Signal account number (E.164)").option("--cli-path <path>", "CLI path (signal-cli or imsg)").option("--db-path <path>", "iMessage database path").option("--service <service>", "iMessage service (imessage|sms|auto)").option("--region <region>", "iMessage region (for SMS)").option("--auth-dir <path>", "WhatsApp auth directory override").option("--http-url <url>", "Signal HTTP daemon base URL").option("--http-host <host>", "Signal HTTP host").option("--http-port <port>", "Signal HTTP port").option("--webhook-path <path>", "Webhook path (Google Chat/BlueBubbles)").option("--webhook-url <url>", "Google Chat webhook URL").option("--audience-type <type>", "Google Chat audience type (app-url|project-number)").option("--audience <value>", "Google Chat audience value (app URL or project number)").option("--homeserver <url>", "Matrix homeserver URL").option("--user-id <id>", "Matrix user ID").option("--access-token <token>", "Matrix access token").option("--password <password>", "Matrix password").option("--device-name <name>", "Matrix device name").option("--initial-sync-limit <n>", "Matrix initial sync limit").option("--ship <ship>", "Tlon ship name (~sampel-palnet)").option("--url <url>", "Tlon ship URL").option("--relay-urls <list>", "Nostr relay URLs (comma-separated)").option("--code <code>", "Tlon login code").option("--group-channels <list>", "Tlon group channels (comma-separated)").option("--dm-allowlist <list>", "Tlon DM allowlist (comma-separated ships)").option("--auto-discover-channels", "Tlon auto-discover group channels").option("--no-auto-discover-channels", "Disable Tlon auto-discovery").option("--use-env", "Use env token (default account only)", false).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsAddCommand } = await import("./channels-CvWgFCG4.js");
			await channelsAddCommand(opts, defaultRuntime, { hasFlags: hasExplicitOptions(command, optionNamesAdd) });
		});
	});
	channels.command("remove").description("Disable or delete a channel account").option("--channel <name>", `Channel (${channelNames})`).option("--account <id>", "Account id (default when omitted)").option("--delete", "Delete config entries (no prompt)", false).action(async (opts, command) => {
		await runChannelsCommand(async () => {
			const { channelsRemoveCommand } = await import("./channels-CvWgFCG4.js");
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
