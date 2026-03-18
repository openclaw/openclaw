import "./provider-env-vars-BfZUtZAn.js";
import { s as init_session_key } from "./session-key-BSZsryCD.js";
import "./resolve-route-CQsiaDZO.js";
import { t as formatCliCommand } from "./command-format-ZZqKRRhR.js";
import "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import "./subsystem-CsPxmH8p.js";
import { l as init_utils, m as pathExists, p as normalizeE164 } from "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { Hu as splitSetupEntries, P as loginWeb, Ru as setSetupChannelEnabled, Tu as formatDocsLink, im as listWhatsAppAccountIds, ku as normalizeAllowFromEntries, sm as resolveWhatsAppAuthDir } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import { t as whatsappSetupAdapter } from "./setup-core-Db6UrHEy.js";
import "./channel-web-B2FdCyZA.js";
import path from "node:path";
//#region src/config/merge-config.ts
function mergeConfigSection(base, patch, options = {}) {
	const next = { ...base ?? void 0 };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) {
			if (options.unsetOnUndefined?.includes(key)) delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}
function mergeWhatsAppConfig(cfg, patch, options) {
	return {
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options)
		}
	};
}
//#endregion
//#region extensions/whatsapp/src/setup-surface.ts
init_session_key();
init_utils();
const channel = "whatsapp";
function setWhatsAppDmPolicy(cfg, dmPolicy) {
	return mergeWhatsAppConfig(cfg, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, allowFrom) {
	return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, selfChatMode) {
	return mergeWhatsAppConfig(cfg, { selfChatMode });
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
	const entry = await prompter.text({
		message: "Your personal WhatsApp number (the phone you will message from)",
		placeholder: "+15555550123",
		initialValue: existingAllowFrom[0],
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			if (!normalizeE164(raw)) return `Invalid number: ${raw}`;
		}
	});
	const normalized = normalizeE164(String(entry).trim());
	if (!normalized) throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
	return {
		normalized,
		allowFrom: normalizeAllowFromEntries([...existingAllowFrom.filter((item) => item !== "*"), normalized], normalizeE164)
	};
}
async function applyWhatsAppOwnerAllowlist(params) {
	const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
		prompter: params.prompter,
		existingAllowFrom: params.existingAllowFrom
	});
	let next = setWhatsAppSelfChatMode(params.cfg, true);
	next = setWhatsAppDmPolicy(next, "allowlist");
	next = setWhatsAppAllowFrom(next, allowFrom);
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
		const normalized = normalizeE164(part);
		if (!normalized) return {
			entries: [],
			invalidEntry: part
		};
		entries.push(normalized);
	}
	return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}
async function promptWhatsAppDmAccess(params) {
	const existingPolicy = params.cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
	const existingAllowFrom = params.cfg.channels?.whatsapp?.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	if (params.forceAllowFrom) return await applyWhatsAppOwnerAllowlist({
		cfg: params.cfg,
		prompter: params.prompter,
		existingAllowFrom,
		title: "WhatsApp allowlist",
		messageLines: ["Allowlist mode enabled."]
	});
	await params.prompter.note([
		"WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
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
	let next = setWhatsAppSelfChatMode(params.cfg, false);
	next = setWhatsAppDmPolicy(next, policy);
	if (policy === "open") {
		const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
		next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
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
	if (mode === "unset") return setWhatsAppAllowFrom(next, void 0);
	const allowRaw = await params.prompter.text({
		message: "Allowed sender numbers (comma-separated, E.164)",
		placeholder: "+15555550123, +447700900123",
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			const parsed = parseWhatsAppAllowFromEntries(raw);
			if (parsed.entries.length === 0 && !parsed.invalidEntry) return "Required";
			if (parsed.invalidEntry) return `Invalid number: ${parsed.invalidEntry}`;
		}
	});
	const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
	return setWhatsAppAllowFrom(next, parsed.entries);
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
		resolveConfigured: async ({ cfg }) => {
			for (const accountId of listWhatsAppAccountIds(cfg)) if (await detectWhatsAppLinked(cfg, accountId)) return true;
			return false;
		},
		resolveStatusLines: async ({ cfg, configured }) => {
			const linkedAccountId = (await Promise.all(listWhatsAppAccountIds(cfg).map(async (accountId) => ({
				accountId,
				linked: await detectWhatsAppLinked(cfg, accountId)
			})))).find((entry) => entry.linked)?.accountId;
			return [`${linkedAccountId ? `WhatsApp (${linkedAccountId === "default" ? "default" : linkedAccountId})` : "WhatsApp"}: ${configured ? "linked" : "not linked"}`];
		}
	},
	resolveShouldPromptAccountIds: ({ options, shouldPromptAccountIds }) => Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
	credentials: [],
	finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) => {
		let next = accountId === "default" ? cfg : whatsappSetupAdapter.applyAccountConfig({
			cfg,
			accountId,
			input: {}
		});
		const linked = await detectWhatsAppLinked(next, accountId);
		const { authDir } = resolveWhatsAppAuthDir({
			cfg: next,
			accountId
		});
		if (!linked) await prompter.note([
			"Scan the QR with WhatsApp on your phone.",
			`Credentials are stored under ${authDir}/ for future runs.`,
			`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
		].join("\n"), "WhatsApp linking");
		if (await prompter.confirm({
			message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
			initialValue: !linked
		})) try {
			await loginWeb(false, void 0, runtime, accountId);
		} catch (error) {
			runtime.error(`WhatsApp login failed: ${String(error)}`);
			await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
		}
		else if (!linked) await prompter.note(`Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`, "WhatsApp");
		next = await promptWhatsAppDmAccess({
			cfg: next,
			forceAllowFrom,
			prompter
		});
		return { cfg: next };
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};
//#endregion
export { whatsappSetupWizard };
