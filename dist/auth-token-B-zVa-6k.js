import { A as normalizeProviderId } from "./reply-kqyKJg4x.js";
//#region src/commands/auth-token.ts
const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const DEFAULT_TOKEN_PROFILE_NAME = "default";
function normalizeTokenProfileName(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return DEFAULT_TOKEN_PROFILE_NAME;
	return trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
function buildTokenProfileId(params) {
	return `${normalizeProviderId(params.provider)}:${normalizeTokenProfileName(params.name)}`;
}
function validateAnthropicSetupToken(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "Required";
	if (!trimmed.startsWith("sk-ant-oat01-")) return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX}`;
	if (trimmed.length < 80) return "Token looks too short; paste the full setup-token";
}
//#endregion
export { validateAnthropicSetupToken as n, buildTokenProfileId as t };
