import { L as getTailnetHostname } from "./config-VO8zzMSR.js";
import { c as isIpv6Address, i as isCanonicalDottedDecimalIPv4, m as parseCanonicalIpAddress } from "./ip-Cdtea-sx.js";
//#region src/gateway/gateway-config-prompts.shared.ts
const TAILSCALE_EXPOSURE_OPTIONS = [
	{
		value: "off",
		label: "Off",
		hint: "No Tailscale exposure"
	},
	{
		value: "serve",
		label: "Serve",
		hint: "Private HTTPS for your tailnet (devices on Tailscale)"
	},
	{
		value: "funnel",
		label: "Funnel",
		hint: "Public HTTPS via Tailscale Funnel (internet)"
	}
];
const TAILSCALE_MISSING_BIN_NOTE_LINES = [
	"Tailscale binary not found in PATH or /Applications.",
	"Ensure Tailscale is installed from:",
	"  https://tailscale.com/download/mac",
	"",
	"You can continue setup, but serve/funnel will fail at runtime."
];
const TAILSCALE_DOCS_LINES = [
	"Docs:",
	"https://docs.openclaw.ai/gateway/tailscale",
	"https://docs.openclaw.ai/web"
];
function normalizeTailnetHostForUrl(rawHost) {
	const trimmed = rawHost.trim().replace(/\.$/, "");
	if (!trimmed) {return null;}
	const parsed = parseCanonicalIpAddress(trimmed);
	if (parsed && isIpv6Address(parsed)) {return `[${parsed.toString().toLowerCase()}]`;}
	return trimmed;
}
function buildTailnetHttpsOrigin(rawHost) {
	const normalizedHost = normalizeTailnetHostForUrl(rawHost);
	if (!normalizedHost) {return null;}
	try {
		return new URL(`https://${normalizedHost}`).origin;
	} catch {
		return null;
	}
}
function appendAllowedOrigin(existing, origin) {
	const current = existing ?? [];
	const normalized = origin.toLowerCase();
	if (current.some((entry) => entry.toLowerCase() === normalized)) {return current;}
	return [...current, origin];
}
async function maybeAddTailnetOriginToControlUiAllowedOrigins(params) {
	if (params.tailscaleMode !== "serve" && params.tailscaleMode !== "funnel") {return params.config;}
	const tsOrigin = await getTailnetHostname(void 0, params.tailscaleBin ?? void 0).then((host) => buildTailnetHttpsOrigin(host)).catch(() => null);
	if (!tsOrigin) {return params.config;}
	const updatedOrigins = appendAllowedOrigin(params.config.gateway?.controlUi?.allowedOrigins ?? [], tsOrigin);
	return {
		...params.config,
		gateway: {
			...params.config.gateway,
			controlUi: {
				...params.config.gateway?.controlUi,
				allowedOrigins: updatedOrigins
			}
		}
	};
}
//#endregion
//#region src/shared/net/ipv4.ts
function validateDottedDecimalIPv4Input(value) {
	if (!value) {return "IP address is required for custom bind mode";}
	if (isCanonicalDottedDecimalIPv4(value)) {return;}
	return "Invalid IPv4 address (e.g., 192.168.1.100)";
}
function validateIPv4AddressInput(value) {
	return validateDottedDecimalIPv4Input(value);
}
//#endregion
export { maybeAddTailnetOriginToControlUiAllowedOrigins as a, TAILSCALE_MISSING_BIN_NOTE_LINES as i, TAILSCALE_DOCS_LINES as n, TAILSCALE_EXPOSURE_OPTIONS as r, validateIPv4AddressInput as t };
