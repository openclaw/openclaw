import { p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
//#region src/config/nix-mode-write-guard.ts
const NIX_OPENCLAW_AGENT_FIRST_URL = "https://github.com/openclaw/nix-openclaw#quick-start";
const OPENCLAW_NIX_OVERVIEW_URL = "https://docs.openclaw.ai/install/nix";
var NixModeConfigMutationError = class extends Error {
	constructor(params = {}) {
		super(formatNixModeConfigMutationMessage(params));
		this.code = "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE";
		this.name = "NixModeConfigMutationError";
	}
};
function formatNixModeConfigMutationMessage(params = {}) {
	return [
		"Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
		"This usually means nix-openclaw, the first-party Nix distribution, or another Nix-managed package set this mode.",
		...params.configPath ? [`Config path: ${params.configPath}`] : [],
		"Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
		"Edit the Nix source for this install instead. For nix-openclaw, edit `programs.openclaw.config` or `instances.<name>.config`, then rebuild with Home Manager or NixOS.",
		`Agent-first Nix setup: ${NIX_OPENCLAW_AGENT_FIRST_URL}`,
		`OpenClaw Nix overview: ${OPENCLAW_NIX_OVERVIEW_URL}`
	].join("\n");
}
function assertConfigWriteAllowedInCurrentMode(params = {}) {
	if (!resolveIsNixMode(params.env)) return;
	throw new NixModeConfigMutationError({ configPath: params.configPath });
}
//#endregion
export { assertConfigWriteAllowedInCurrentMode as n, NixModeConfigMutationError as t };
