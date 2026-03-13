import { A as theme, p as defaultRuntime } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { ba as listPairingChannels, ha as listChannelPairingRequests, ma as approveChannelPairingCode, ut as resolvePairingIdLabel, xa as notifyPairingApproved, zg as loadConfig } from "./auth-profiles-CAw5gP6f.js";
import { t as formatCliCommand } from "./command-format-CO3N-oGG.js";
import "./agent-scope-DBEC2O3x.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import { r as normalizeChannelId } from "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import { t as formatDocsLink } from "./links-BpBLDDXV.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-D9UWblu1.js";
//#region src/cli/pairing-cli.ts
/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw, channels) {
	const value = (typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "").trim().toLowerCase();
	if (!value) throw new Error("Channel required");
	const normalized = normalizeChannelId(value);
	if (normalized) {
		if (!channels.includes(normalized)) throw new Error(`Channel ${normalized} does not support pairing`);
		return normalized;
	}
	if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) return value;
	throw new Error(`Invalid channel: ${value}`);
}
async function notifyApproved(channel, id) {
	await notifyPairingApproved({
		channelId: channel,
		id,
		cfg: loadConfig()
	});
}
function registerPairingCli(program) {
	const channels = listPairingChannels();
	const pairing = program.command("pairing").description("Secure DM pairing (approve inbound requests)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pairing", "docs.openclaw.ai/cli/pairing")}\n`);
	pairing.command("list").description("List pending pairing requests").option("--channel <channel>", `Channel (${channels.join(", ")})`).option("--account <accountId>", "Account id (for multi-account channels)").argument("[channel]", `Channel (${channels.join(", ")})`).option("--json", "Print JSON", false).action(async (channelArg, opts) => {
		const channelRaw = opts.channel ?? channelArg ?? (channels.length === 1 ? channels[0] : "");
		if (!channelRaw) throw new Error(`Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${channels.join(", ")})`);
		const channel = parseChannel(channelRaw, channels);
		const accountId = String(opts.account ?? "").trim();
		const requests = accountId ? await listChannelPairingRequests(channel, process.env, accountId) : await listChannelPairingRequests(channel);
		if (opts.json) {
			defaultRuntime.log(JSON.stringify({
				channel,
				requests
			}, null, 2));
			return;
		}
		if (requests.length === 0) {
			defaultRuntime.log(theme.muted(`No pending ${channel} pairing requests.`));
			return;
		}
		const idLabel = resolvePairingIdLabel(channel);
		const tableWidth = getTerminalTableWidth();
		defaultRuntime.log(`${theme.heading("Pairing requests")} ${theme.muted(`(${requests.length})`)}`);
		defaultRuntime.log(renderTable({
			width: tableWidth,
			columns: [
				{
					key: "Code",
					header: "Code",
					minWidth: 10
				},
				{
					key: "ID",
					header: idLabel,
					minWidth: 12,
					flex: true
				},
				{
					key: "Meta",
					header: "Meta",
					minWidth: 8,
					flex: true
				},
				{
					key: "Requested",
					header: "Requested",
					minWidth: 12
				}
			],
			rows: requests.map((r) => ({
				Code: r.code,
				ID: r.id,
				Meta: r.meta ? JSON.stringify(r.meta) : "",
				Requested: r.createdAt
			}))
		}).trimEnd());
	});
	pairing.command("approve").description("Approve a pairing code and allow that sender").option("--channel <channel>", `Channel (${channels.join(", ")})`).option("--account <accountId>", "Account id (for multi-account channels)").argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)").argument("[code]", "Pairing code (when channel is passed as the 1st arg)").option("--notify", "Notify the requester on the same channel", false).action(async (codeOrChannel, code, opts) => {
		const defaultChannel = channels.length === 1 ? channels[0] : "";
		const usingExplicitChannel = Boolean(opts.channel);
		const hasPositionalCode = code != null;
		const channelRaw = usingExplicitChannel ? opts.channel : hasPositionalCode ? codeOrChannel : defaultChannel;
		const resolvedCode = usingExplicitChannel ? codeOrChannel : hasPositionalCode ? code : codeOrChannel;
		if (!channelRaw || !resolvedCode) throw new Error(`Usage: ${formatCliCommand("openclaw pairing approve <channel> <code>")} (or: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")})`);
		if (opts.channel && code != null) throw new Error(`Too many arguments. Use: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")}`);
		const channel = parseChannel(channelRaw, channels);
		const accountId = String(opts.account ?? "").trim();
		const approved = accountId ? await approveChannelPairingCode({
			channel,
			code: String(resolvedCode),
			accountId
		}) : await approveChannelPairingCode({
			channel,
			code: String(resolvedCode)
		});
		if (!approved) throw new Error(`No pending pairing request found for code: ${String(resolvedCode)}`);
		defaultRuntime.log(`${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.`);
		if (!opts.notify) return;
		await notifyApproved(channel, approved.id).catch((err) => {
			defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
		});
	});
}
//#endregion
export { registerPairingCli };
