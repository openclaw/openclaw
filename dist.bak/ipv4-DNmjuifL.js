import { i as isCanonicalDottedDecimalIPv4 } from "./ip-DK-vcRii.js";

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

//#endregion
//#region src/shared/net/ipv4.ts
function validateDottedDecimalIPv4Input(value) {
	if (!value) return "IP address is required for custom bind mode";
	if (isCanonicalDottedDecimalIPv4(value)) return;
	return "Invalid IPv4 address (e.g., 192.168.1.100)";
}
function validateIPv4AddressInput(value) {
	return validateDottedDecimalIPv4Input(value);
}

//#endregion
export { TAILSCALE_MISSING_BIN_NOTE_LINES as i, TAILSCALE_DOCS_LINES as n, TAILSCALE_EXPOSURE_OPTIONS as r, validateIPv4AddressInput as t };