import { a as normalizeLowercaseStringOrEmpty, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { d as readConfigFileSnapshotForWrite, i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { a as normalizeChannelId } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { i as listChannelPairingRequests, m as notifyPairingApproved, n as approveChannelPairingCode, p as listPairingChannels } from "./pairing-store-jPMfFWFn.js";
import { n as hasConfiguredCommandOwners, t as formatCommandOwnerFromChannelSender } from "./doctor-command-owner-D2clMNPw.js";
import { t as resolvePairingIdLabel } from "./pairing-labels-D7SOe44q.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
//#region src/cli/pairing-cli.ts
/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw, channels) {
	const value = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(raw) ?? "");
	if (!value) throw new Error(`Missing channel. Use ${formatCliCommand("openclaw pairing list --channel <channel>")}.`);
	const normalized = normalizeChannelId(value);
	if (normalized) {
		if (!channels.includes(normalized)) throw new Error(`Channel "${normalized}" does not support pairing. Supported pairing channels: ${channels.join(", ") || "none"}.`);
		return normalized;
	}
	if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) return value;
	throw new Error(`Invalid channel "${value}". Use lowercase letters, numbers, "_" or "-", for example "telegram".`);
}
async function notifyApproved(channel, id) {
	await notifyPairingApproved({
		channelId: channel,
		id,
		cfg: getRuntimeConfig()
	});
}
async function maybeBootstrapCommandOwnerFromPairing(params) {
	const ownerEntry = formatCommandOwnerFromChannelSender(params);
	if (!ownerEntry) return {
		ownerEntry: null,
		bootstrapped: false
	};
	const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
	if (hasConfiguredCommandOwners(snapshot.sourceConfig)) return {
		ownerEntry,
		bootstrapped: false
	};
	const nextConfig = structuredClone(snapshot.sourceConfig);
	nextConfig.commands = {
		...nextConfig.commands,
		ownerAllowFrom: [ownerEntry]
	};
	await replaceConfigFile({
		nextConfig,
		snapshot,
		writeOptions,
		afterWrite: { mode: "auto" }
	});
	return {
		ownerEntry,
		bootstrapped: true
	};
}
function registerPairingCli(program) {
	const channels = listPairingChannels();
	const pairing = program.command("pairing").description("Secure DM pairing (approve inbound requests)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pairing", "docs.openclaw.ai/cli/pairing")}\n`);
	pairing.command("list").description("List pending pairing requests").option("--channel <channel>", `Channel (${channels.join(", ")})`).option("--account <accountId>", "Account id (for multi-account channels)").argument("[channel]", `Channel (${channels.join(", ")})`).option("--json", "Print JSON", false).action(async (channelArg, opts) => {
		const channelRaw = opts.channel ?? channelArg ?? (channels.length === 1 ? channels[0] : "");
		if (!channelRaw) throw new Error(`Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${channels.join(", ")})`);
		const channel = parseChannel(channelRaw, channels);
		const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
		const requests = accountId ? await listChannelPairingRequests(channel, process.env, accountId) : await listChannelPairingRequests(channel);
		if (opts.json) {
			defaultRuntime.writeJson({
				channel,
				requests
			});
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
		const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
		const approved = accountId ? await approveChannelPairingCode({
			channel,
			code: String(resolvedCode),
			accountId
		}) : await approveChannelPairingCode({
			channel,
			code: String(resolvedCode)
		});
		if (!approved) throw new Error(`No pending pairing request found for code "${String(resolvedCode)}". Run ${formatCliCommand(`openclaw pairing list --channel ${channel}`)} to list pending requests.`);
		defaultRuntime.log(`${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.`);
		const ownerBootstrap = await maybeBootstrapCommandOwnerFromPairing({
			channel,
			id: approved.id
		});
		if (ownerBootstrap.bootstrapped && ownerBootstrap.ownerEntry) defaultRuntime.log(`${theme.success("Command owner configured")} ${theme.command(ownerBootstrap.ownerEntry)} ${theme.muted("(commands.ownerAllowFrom was empty).")}`);
		if (!opts.notify) return;
		await notifyApproved(channel, approved.id).catch((err) => {
			defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
		});
	});
}
//#endregion
export { registerPairingCli };
