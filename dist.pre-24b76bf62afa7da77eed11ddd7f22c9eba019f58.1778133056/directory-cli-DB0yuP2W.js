import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { n as defaultRuntime } from "./runtime-CFpTi2zA.js";
import { t as danger } from "./globals-Byqe4NlR.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-BqN-ccJq.js";
import { r as replaceConfigFile } from "./mutate-BYCWuH5H.js";
import "./config-Cfbn58KU.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-QdD1oSti.js";
import { t as getChannelPlugin } from "./registry-BkfWr-Uk.js";
import "./plugins-ChY-kMXQ.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-DkWROuXx.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-BUOSsuwP.js";
import { t as formatHelpExamples } from "./help-format-B8GpWy21.js";
import { t as commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit-BixXkCON.js";
import { t as resolveInstallableChannelPlugin } from "./channel-plugin-resolution-D-dIi2fh.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-Bufzl6pk.js";
//#region src/cli/directory-cli.ts
function parseLimit(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return null;
		return Math.floor(value);
	}
	if (typeof value !== "string") return null;
	const raw = normalizeOptionalString(value) ?? "";
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}
function buildRows(entries) {
	return entries.map((entry) => ({
		ID: entry.id,
		Name: normalizeOptionalString(entry.name) ?? ""
	}));
}
function printDirectoryList(params) {
	if (params.entries.length === 0) {
		defaultRuntime.log(theme.muted(params.emptyMessage));
		return;
	}
	const tableWidth = getTerminalTableWidth();
	defaultRuntime.log(`${theme.heading(params.title)} ${theme.muted(`(${params.entries.length})`)}`);
	defaultRuntime.log(renderTable({
		width: tableWidth,
		columns: [{
			key: "ID",
			header: "ID",
			minWidth: 16,
			flex: true
		}, {
			key: "Name",
			header: "Name",
			minWidth: 18,
			flex: true
		}],
		rows: buildRows(params.entries)
	}).trimEnd());
}
function registerDirectoryCli(program) {
	const directory = program.command("directory").description("Lookup contact and group IDs (self, peers, groups) for supported chat channels").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw directory self --channel slack", "Show the connected account identity."],
		["openclaw directory peers list --channel slack --query \"alice\"", "Search contact/user IDs by name."],
		["openclaw directory groups list --channel discord", "List available groups/channels."],
		["openclaw directory groups members --channel discord --group-id <id>", "List members for a specific group."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/directory", "docs.openclaw.ai/cli/directory")}\n`).action(() => {
		directory.help({ error: true });
	});
	const withChannel = (cmd) => cmd.option("--channel <name>", "Channel (auto when only one is configured)").option("--account <id>", "Account id (accountId)").option("--json", "Output JSON", false);
	const resolve = async (opts) => {
		const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
		const autoEnabled = applyPluginAutoEnable({
			config: getRuntimeConfig(),
			env: process.env
		});
		let cfg = autoEnabled.config;
		const explicitChannel = opts.channel?.trim();
		const resolvedExplicit = explicitChannel ? await resolveInstallableChannelPlugin({
			cfg,
			runtime: defaultRuntime,
			rawChannel: explicitChannel,
			allowInstall: true,
			supports: (plugin) => Boolean(plugin.directory)
		}) : null;
		if (resolvedExplicit?.configChanged) {
			cfg = resolvedExplicit.cfg;
			cfg = (await commitConfigWithPendingPluginInstalls({
				nextConfig: cfg,
				baseHash: (await sourceSnapshotPromise)?.hash
			})).config;
		} else if (autoEnabled.changes.length > 0) await replaceConfigFile({
			nextConfig: cfg,
			baseHash: (await sourceSnapshotPromise)?.hash
		});
		const channelId = (explicitChannel ? { channel: resolvedExplicit?.channelId } : await resolveMessageChannelSelection({
			cfg,
			channel: opts.channel ?? null
		})).channel;
		const plugin = resolvedExplicit?.plugin ?? (channelId ? getChannelPlugin(channelId) : void 0);
		if (!plugin) throw new Error(`Unsupported channel: ${String(channelId)}`);
		const accountId = normalizeOptionalString(opts.account) || resolveChannelDefaultAccountId({
			plugin,
			cfg
		});
		return {
			cfg,
			channelId,
			accountId,
			plugin
		};
	};
	const runDirectoryList = async (params) => {
		const { cfg, channelId, accountId, plugin } = await resolve({
			channel: params.opts.channel,
			account: params.opts.account
		});
		const fn = params.action === "listPeers" ? plugin.directory?.listPeersLive ?? plugin.directory?.listPeers : plugin.directory?.listGroupsLive ?? plugin.directory?.listGroups;
		if (!fn) throw new Error(`Channel ${channelId} does not support directory ${params.unsupported}`);
		const result = await fn({
			cfg,
			accountId,
			query: params.opts.query ?? null,
			limit: parseLimit(params.opts.limit),
			runtime: defaultRuntime
		});
		if (params.opts.json) {
			defaultRuntime.writeJson(result);
			return;
		}
		printDirectoryList({
			title: params.title,
			emptyMessage: params.emptyMessage,
			entries: result
		});
	};
	withChannel(directory.command("self").description("Show the current account user")).action(async (opts) => {
		try {
			const { cfg, channelId, accountId, plugin } = await resolve({
				channel: opts.channel,
				account: opts.account
			});
			const fn = plugin.directory?.self;
			if (!fn) throw new Error(`Channel ${channelId} does not support directory self`);
			const result = await fn({
				cfg,
				accountId,
				runtime: defaultRuntime
			});
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			if (!result) {
				defaultRuntime.log(theme.muted("Not available."));
				return;
			}
			const tableWidth = getTerminalTableWidth();
			defaultRuntime.log(theme.heading("Self"));
			defaultRuntime.log(renderTable({
				width: tableWidth,
				columns: [{
					key: "ID",
					header: "ID",
					minWidth: 16,
					flex: true
				}, {
					key: "Name",
					header: "Name",
					minWidth: 18,
					flex: true
				}],
				rows: buildRows([result])
			}).trimEnd());
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	withChannel(directory.command("peers").description("Peer directory (contacts/users)").command("list").description("List peers")).option("--query <text>", "Optional search query").option("--limit <n>", "Limit results").action(async (opts) => {
		try {
			await runDirectoryList({
				opts,
				action: "listPeers",
				unsupported: "peers",
				title: "Peers",
				emptyMessage: "No peers found."
			});
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	const groups = directory.command("groups").description("Group directory");
	withChannel(groups.command("list").description("List groups")).option("--query <text>", "Optional search query").option("--limit <n>", "Limit results").action(async (opts) => {
		try {
			await runDirectoryList({
				opts,
				action: "listGroups",
				unsupported: "groups",
				title: "Groups",
				emptyMessage: "No groups found."
			});
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	withChannel(groups.command("members").description("List group members").requiredOption("--group-id <id>", "Group id")).option("--limit <n>", "Limit results").action(async (opts) => {
		try {
			const { cfg, channelId, accountId, plugin } = await resolve({
				channel: opts.channel,
				account: opts.account
			});
			const fn = plugin.directory?.listGroupMembers;
			if (!fn) throw new Error(`Channel ${channelId} does not support group members listing`);
			const groupId = normalizeStringifiedOptionalString(opts.groupId) ?? "";
			if (!groupId) throw new Error("Missing --group-id");
			const result = await fn({
				cfg,
				accountId,
				groupId,
				limit: parseLimit(opts.limit),
				runtime: defaultRuntime
			});
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			printDirectoryList({
				title: "Group Members",
				emptyMessage: "No group members found.",
				entries: result
			});
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerDirectoryCli };
