import { Ot as theme, gt as danger, v as defaultRuntime } from "./entry.js";
import { j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./message-channel-CJUwnCYd.js";
import { t as getChannelPlugin } from "./plugins-BOmV0yTv.js";
import "./accounts-jTTYYc3C.js";
import "./bindings-DcFNU_QL.js";
import "./logging-Cr3Gsq0-.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-67xZBvtg.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { t as formatHelpExamples } from "./help-format-Du-bXlH0.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-BgzIw8DX.js";
import { t as renderTable } from "./table-D7QRfQ5S.js";

//#region src/cli/directory-cli.ts
function parseLimit(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return null;
		return Math.floor(value);
	}
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}
function buildRows(entries) {
	return entries.map((entry) => ({
		ID: entry.id,
		Name: entry.name?.trim() ?? ""
	}));
}
function printDirectoryList(params) {
	if (params.entries.length === 0) {
		defaultRuntime.log(theme.muted(params.emptyMessage));
		return;
	}
	const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
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
		const cfg = loadConfig();
		const channelId = (await resolveMessageChannelSelection({
			cfg,
			channel: opts.channel ?? null
		})).channel;
		const plugin = getChannelPlugin(channelId);
		if (!plugin) throw new Error(`Unsupported channel: ${String(channelId)}`);
		return {
			cfg,
			channelId,
			accountId: opts.account?.trim() || resolveChannelDefaultAccountId({
				plugin,
				cfg
			}),
			plugin
		};
	};
	const runDirectoryList = async (params) => {
		const { cfg, channelId, accountId, plugin } = await resolve({
			channel: params.opts.channel,
			account: params.opts.account
		});
		const fn = params.action === "listPeers" ? plugin.directory?.listPeers : plugin.directory?.listGroups;
		if (!fn) throw new Error(`Channel ${channelId} does not support directory ${params.unsupported}`);
		const result = await fn({
			cfg,
			accountId,
			query: params.opts.query ?? null,
			limit: parseLimit(params.opts.limit),
			runtime: defaultRuntime
		});
		if (params.opts.json) {
			defaultRuntime.log(JSON.stringify(result, null, 2));
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
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (!result) {
				defaultRuntime.log(theme.muted("Not available."));
				return;
			}
			const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
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
			const groupId = String(opts.groupId ?? "").trim();
			if (!groupId) throw new Error("Missing --group-id");
			const result = await fn({
				cfg,
				accountId,
				groupId,
				limit: parseLimit(opts.limit),
				runtime: defaultRuntime
			});
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
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