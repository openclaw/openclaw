import { Ag as inspectDiscordAccount } from "./auth-profiles-DAOR1fRn.js";
import { Container } from "@buape/carbon";
//#region extensions/discord/src/ui.ts
const DEFAULT_DISCORD_ACCENT_COLOR = "#5865F2";
function normalizeDiscordAccentColor(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return null;
	return normalized.toUpperCase();
}
function resolveDiscordAccentColor(params) {
	return normalizeDiscordAccentColor(inspectDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.ui?.components?.accentColor) ?? DEFAULT_DISCORD_ACCENT_COLOR;
}
var DiscordUiContainer = class extends Container {
	constructor(params) {
		const accentColor = normalizeDiscordAccentColor(params.accentColor) ?? resolveDiscordAccentColor({
			cfg: params.cfg,
			accountId: params.accountId
		});
		super(params.components, {
			accentColor,
			spoiler: params.spoiler
		});
	}
};
//#endregion
export { DiscordUiContainer as t };
