import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Xn as resolvePairingIdLabel, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import { ft as normalizeChannelId } from "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
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
import { C as listPairingChannels, g as listChannelPairingRequests, h as approveChannelPairingCode, w as notifyPairingApproved } from "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BGZZcqHp.js";
//#region src/cli/pairing-cli.ts
init_runtime();
init_theme();
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
