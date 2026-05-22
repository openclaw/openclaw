import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { confirm, intro, outro, select, text } from "@clack/prompts";
//#region src/commands/configure.shared.ts
const CONFIGURE_WIZARD_SECTIONS = [
	"workspace",
	"model",
	"web",
	"gateway",
	"daemon",
	"channels",
	"plugins",
	"skills",
	"health"
];
function parseConfigureWizardSections(raw) {
	const sectionsRaw = Array.isArray(raw) ? normalizeStringEntries(raw) : [];
	if (sectionsRaw.length === 0) return {
		sections: [],
		invalid: []
	};
	const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s));
	return {
		sections: sectionsRaw.filter((s) => CONFIGURE_WIZARD_SECTIONS.includes(s)),
		invalid
	};
}
const CONFIGURE_SECTION_OPTIONS = [
	{
		value: "workspace",
		label: "Workspace",
		hint: "Set workspace + sessions"
	},
	{
		value: "model",
		label: "Model",
		hint: "Pick provider + credentials"
	},
	{
		value: "web",
		label: "Web tools",
		hint: "Configure web search (Perplexity/Brave) + fetch"
	},
	{
		value: "gateway",
		label: "Gateway",
		hint: "Port, bind, auth, tailscale"
	},
	{
		value: "daemon",
		label: "Daemon",
		hint: "Install/manage the background service"
	},
	{
		value: "channels",
		label: "Channels",
		hint: "Link WhatsApp/Telegram/etc and defaults"
	},
	{
		value: "plugins",
		label: "Plugins",
		hint: "Configure plugin settings (sandbox, tools, etc.)"
	},
	{
		value: "skills",
		label: "Skills",
		hint: "Install/enable workspace skills"
	},
	{
		value: "health",
		label: "Health check",
		hint: "Run gateway + channel checks"
	}
];
const intro$1 = (message) => intro(stylePromptTitle(message) ?? message);
const outro$1 = (message) => outro(stylePromptTitle(message) ?? message);
const text$1 = (params) => text({
	...params,
	message: stylePromptMessage(params.message)
});
const confirm$1 = (params) => confirm({
	...params,
	message: stylePromptMessage(params.message)
});
const select$1 = (params) => select({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
});
//#endregion
export { outro$1 as a, text$1 as c, intro$1 as i, CONFIGURE_WIZARD_SECTIONS as n, parseConfigureWizardSections as o, confirm$1 as r, select$1 as s, CONFIGURE_SECTION_OPTIONS as t };
