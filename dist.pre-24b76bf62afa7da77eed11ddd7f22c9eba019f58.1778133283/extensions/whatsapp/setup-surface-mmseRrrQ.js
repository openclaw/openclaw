import { t as formatDocsLink } from "../../links-dQIIPEtq.js";
import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { u as pathExists } from "../../utils-D5swhEXt.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { J as setSetupChannelEnabled, Q as splitSetupEntries } from "../../setup-wizard-helpers-CZv1sG0G.js";
import "../../setup-D4ew-RC_.js";
import "../../setup-tools-DVH8A_xE.js";
import { r as resolveDefaultWhatsAppAccountId, t as listAccountIds } from "./account-ids-DgWaB6F_.js";
import { a as resolveWhatsAppAccount, o as resolveWhatsAppAuthDir } from "./accounts-Dku2n2wb.js";
import { a as normalizeWhatsAppAllowFromEntries, o as normalizeWhatsAppAllowFromEntry } from "./normalize-target-YaJHNs5M.js";
import { i as formatWhatsAppWebAuthStatusState, m as readWebAuthState } from "./auth-store-C2C0dMot.js";
import { t as whatsappSetupAdapter } from "./setup-core-DtiDj-Ct.js";
import path from "node:path";
//#region extensions/whatsapp/src/setup-finalize.ts
function trimPromptText(value) {
	return value?.trim() ?? "";
}
function isDefaultWhatsAppAccountKey(accountId) {
	return accountId.trim().toLowerCase() === DEFAULT_ACCOUNT_ID;
}
function shouldWriteDefaultWhatsAppAccountConfigAtAccountScope(cfg) {
	const accounts = cfg.channels?.whatsapp?.accounts;
	if (!accounts) return false;
	if (accounts.default) return true;
	return Object.keys(accounts).some((accountId) => !isDefaultWhatsAppAccountKey(accountId));
}
function resolveDefaultWhatsAppAccountWriteKey(cfg) {
	const accounts = cfg.channels?.whatsapp?.accounts;
	if (!accounts) return DEFAULT_ACCOUNT_ID;
	return Object.keys(accounts).find((accountId) => isDefaultWhatsAppAccountKey(accountId)) ?? "default";
}
function resolveWhatsAppConfigPathPrefix(cfg, accountId) {
	if (accountId === "default" && shouldWriteDefaultWhatsAppAccountConfigAtAccountScope(cfg)) return `channels.whatsapp.accounts.${resolveDefaultWhatsAppAccountWriteKey(cfg)}`;
	return accountId === "default" ? "channels.whatsapp" : `channels.whatsapp.accounts.${accountId}`;
}
function mergeWhatsAppConfig(cfg, accountId, patch, options) {
	const channelConfig = { ...cfg.channels?.whatsapp };
	const mutableChannelConfig = channelConfig;
	if (resolveWhatsAppConfigPathPrefix(cfg, accountId) === "channels.whatsapp") {
		for (const [key, value] of Object.entries(patch)) {
			if (value === void 0) {
				if (options?.unsetOnUndefined?.includes(key)) delete mutableChannelConfig[key];
				continue;
			}
			mutableChannelConfig[key] = value;
		}
		return {
			...cfg,
			channels: {
				...cfg.channels,
				whatsapp: channelConfig
			}
		};
	}
	const accounts = { ...channelConfig.accounts };
	const targetAccountId = accountId === "default" ? resolveDefaultWhatsAppAccountWriteKey(cfg) : accountId;
	const lowerDefaultAccount = accountId === "default" && targetAccountId !== "default" ? accounts[DEFAULT_ACCOUNT_ID] : void 0;
	const nextAccount = {
		...accounts[targetAccountId],
		...lowerDefaultAccount
	};
	const mutableNextAccount = nextAccount;
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) {
			if (options?.unsetOnUndefined?.includes(key)) delete mutableNextAccount[key];
			continue;
		}
		mutableNextAccount[key] = value;
	}
	accounts[targetAccountId] = nextAccount;
	if (lowerDefaultAccount) delete accounts[DEFAULT_ACCOUNT_ID];
	return {
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: {
				...channelConfig,
				accounts
			}
		}
	};
}
function setWhatsAppDmPolicy(cfg, accountId, dmPolicy) {
	return mergeWhatsAppConfig(cfg, accountId, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, accountId, allowFrom) {
	return mergeWhatsAppConfig(cfg, accountId, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, accountId, selfChatMode) {
	return mergeWhatsAppConfig(cfg, accountId, { selfChatMode });
}
async function detectWhatsAppLinked(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await pathExists(path.join(authDir, "creds.json"));
}
async function promptWhatsAppOwnerAllowFrom(params) {
	const { prompter, existingAllowFrom } = params;
	await prompter.note("We need the sender/owner number so OpenClaw can allowlist you.", "WhatsApp number");
	const normalized = normalizeWhatsAppAllowFromEntry(trimPromptText(await prompter.text({
		message: "Your personal WhatsApp number (the phone you will message from)",
		placeholder: "+15555550123",
		initialValue: existingAllowFrom[0],
		validate: (value) => {
			const raw = trimPromptText(value);
			if (!raw) return "Required";
			if (!normalizeWhatsAppAllowFromEntry(raw)) return `Invalid number: ${raw}`;
		}
	})));
	if (!normalized) throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
	return {
		normalized,
		allowFrom: normalizeWhatsAppAllowFromEntries([...existingAllowFrom.filter((item) => item !== "*"), normalized])
	};
}
async function applyWhatsAppOwnerAllowlist(params) {
	const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
		prompter: params.prompter,
		existingAllowFrom: params.existingAllowFrom
	});
	let next = setWhatsAppSelfChatMode(params.cfg, params.accountId, true);
	next = setWhatsAppDmPolicy(next, params.accountId, "allowlist");
	next = setWhatsAppAllowFrom(next, params.accountId, allowFrom);
	await params.prompter.note([...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"), params.title);
	return next;
}
function parseWhatsAppAllowFromEntries(raw) {
	const parts = splitSetupEntries(raw);
	if (parts.length === 0) return { entries: [] };
	const entries = [];
	for (const part of parts) {
		if (part === "*") {
			entries.push("*");
			continue;
		}
		const normalized = normalizeWhatsAppAllowFromEntry(part);
		if (!normalized) return {
			entries: [],
			invalidEntry: part
		};
		entries.push(normalized);
	}
	return { entries: normalizeWhatsAppAllowFromEntries(entries) };
}
async function promptWhatsAppDmAccess(params) {
	const accountId = params.accountId.trim() || "default";
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId
	});
	const existingPolicy = account.dmPolicy ?? "pairing";
	const existingAllowFrom = account.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	const configPathPrefix = resolveWhatsAppConfigPathPrefix(params.cfg, accountId);
	const policyKey = `${configPathPrefix}.dmPolicy`;
	const allowFromKey = `${configPathPrefix}.allowFrom`;
	if (params.forceAllowFrom) return await applyWhatsAppOwnerAllowlist({
		cfg: params.cfg,
		accountId,
		prompter: params.prompter,
		existingAllowFrom,
		title: "WhatsApp allowlist",
		messageLines: ["Allowlist mode enabled."]
	});
	await params.prompter.note([
		`WhatsApp direct chats are gated by \`${policyKey}\` + \`${allowFromKey}\`.`,
		"- pairing (default): unknown senders get a pairing code; owner approves",
		"- allowlist: unknown senders are blocked",
		"- open: public inbound DMs (requires allowFrom to include \"*\")",
		"- disabled: ignore WhatsApp DMs",
		"",
		`Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
		`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
	].join("\n"), "WhatsApp DM access");
	if (await params.prompter.select({
		message: "WhatsApp phone setup",
		options: [{
			value: "personal",
			label: "This is my personal phone number"
		}, {
			value: "separate",
			label: "Separate phone just for OpenClaw"
		}]
	}) === "personal") return await applyWhatsAppOwnerAllowlist({
		cfg: params.cfg,
		accountId,
		prompter: params.prompter,
		existingAllowFrom,
		title: "WhatsApp personal phone",
		messageLines: ["Personal phone mode enabled.", "- dmPolicy set to allowlist (pairing skipped)"]
	});
	const policy = await params.prompter.select({
		message: "WhatsApp DM policy",
		options: [
			{
				value: "pairing",
				label: "Pairing (recommended)"
			},
			{
				value: "allowlist",
				label: "Allowlist only (block unknown senders)"
			},
			{
				value: "open",
				label: "Open (public inbound DMs)"
			},
			{
				value: "disabled",
				label: "Disabled (ignore WhatsApp DMs)"
			}
		]
	});
	let next = setWhatsAppSelfChatMode(params.cfg, accountId, false);
	next = setWhatsAppDmPolicy(next, accountId, policy);
	if (policy === "open") {
		const allowFrom = normalizeWhatsAppAllowFromEntries(["*", ...existingAllowFrom]);
		next = setWhatsAppAllowFrom(next, accountId, allowFrom.length > 0 ? allowFrom : ["*"]);
		return next;
	}
	if (policy === "disabled") return next;
	const allowOptions = existingAllowFrom.length > 0 ? [
		{
			value: "keep",
			label: "Keep current allowFrom"
		},
		{
			value: "unset",
			label: "Unset allowFrom (use pairing approvals only)"
		},
		{
			value: "list",
			label: "Set allowFrom to specific numbers"
		}
	] : [{
		value: "unset",
		label: "Unset allowFrom (default)"
	}, {
		value: "list",
		label: "Set allowFrom to specific numbers"
	}];
	const mode = await params.prompter.select({
		message: "WhatsApp allowFrom (optional pre-allowlist)",
		options: allowOptions.map((opt) => ({
			value: opt.value,
			label: opt.label
		}))
	});
	if (mode === "keep") return next;
	if (mode === "unset") return setWhatsAppAllowFrom(next, accountId, void 0);
	const parsed = parseWhatsAppAllowFromEntries(trimPromptText(await params.prompter.text({
		message: "Allowed sender numbers (comma-separated, E.164)",
		placeholder: "+15555550123, +447700900123",
		validate: (value) => {
			const raw = trimPromptText(value);
			if (!raw) return "Required";
			const parsed = parseWhatsAppAllowFromEntries(raw);
			if (parsed.entries.length === 0 && !parsed.invalidEntry) return "Required";
			if (parsed.invalidEntry) return `Invalid number: ${parsed.invalidEntry}`;
		}
	})));
	if (parsed.invalidEntry) throw new Error(`Invalid number: ${parsed.invalidEntry}`);
	if (parsed.entries.length === 0) throw new Error("Invalid WhatsApp allowFrom list (expected at least one E.164 number).");
	return setWhatsAppAllowFrom(next, accountId, parsed.entries);
}
async function finalizeWhatsAppSetup(params) {
	const accountId = params.accountId.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
	let next = accountId === "default" ? params.cfg : whatsappSetupAdapter.applyAccountConfig({
		cfg: params.cfg,
		accountId,
		input: {}
	});
	const linked = await detectWhatsAppLinked(next, accountId);
	const { authDir } = resolveWhatsAppAuthDir({
		cfg: next,
		accountId
	});
	if (!linked) await params.prompter.note([
		"Scan the QR with WhatsApp on your phone.",
		`Credentials are stored under ${authDir}/ for future runs.`,
		`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
	].join("\n"), "WhatsApp linking");
	if (await params.prompter.confirm({
		message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
		initialValue: !linked
	})) try {
		const { loginWeb } = await import("./login-B3drNStB.js");
		await loginWeb(false, void 0, params.runtime, accountId);
	} catch (error) {
		params.runtime.error(`WhatsApp login failed: ${String(error)}`);
		await params.prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
	}
	else if (!linked) await params.prompter.note(`Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`, "WhatsApp");
	next = await promptWhatsAppDmAccess({
		cfg: next,
		accountId,
		forceAllowFrom: params.forceAllowFrom,
		prompter: params.prompter
	});
	return { cfg: next };
}
//#endregion
//#region extensions/whatsapp/src/setup-surface.ts
const channel = "whatsapp";
async function readWhatsAppSetupLinkState(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await readWebAuthState(authDir);
}
const whatsappSetupWizard = {
	channel,
	status: {
		configuredLabel: "linked",
		unconfiguredLabel: "not linked",
		configuredHint: "linked",
		unconfiguredHint: "not linked",
		configuredScore: 5,
		unconfiguredScore: 4,
		resolveConfigured: async ({ cfg, accountId }) => {
			for (const resolvedAccountId of accountId ? [accountId] : listAccountIds(cfg)) if (await readWhatsAppSetupLinkState(cfg, resolvedAccountId) === "linked") return true;
			return false;
		},
		resolveStatusLines: async ({ cfg, accountId, configured }) => {
			const linkedAccountId = (await Promise.all((accountId ? [accountId] : listAccountIds(cfg)).map(async (resolvedAccountId) => ({
				accountId: resolvedAccountId,
				state: await readWhatsAppSetupLinkState(cfg, resolvedAccountId)
			})))).find((entry) => entry.state === "linked" || entry.state === "unstable");
			const labelAccountId = accountId ?? linkedAccountId?.accountId;
			return [`${labelAccountId ? `WhatsApp (${labelAccountId === "default" ? "default" : labelAccountId})` : "WhatsApp"}: ${configured ? formatWhatsAppWebAuthStatusState("linked") : formatWhatsAppWebAuthStatusState(linkedAccountId?.state ?? "not-linked")}`];
		}
	},
	resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
	credentials: [],
	finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) => await finalizeWhatsAppSetup({
		cfg,
		accountId,
		forceAllowFrom,
		prompter,
		runtime
	}),
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
	onAccountRecorded: (accountId, options) => {
		options?.onAccountId?.(channel, accountId);
	}
};
//#endregion
export { whatsappSetupWizard as t };
