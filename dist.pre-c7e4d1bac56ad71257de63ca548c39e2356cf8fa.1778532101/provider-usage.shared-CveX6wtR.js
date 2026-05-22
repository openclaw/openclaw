import { o as resolveRequiredHomeDir } from "./home-dir-g5LU3LmA.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/infra/provider-usage.shared.ts
const DEFAULT_TIMEOUT_MS = 5e3;
const PROVIDER_LABELS = {
	anthropic: "Claude",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini",
	minimax: "MiniMax",
	"openai-codex": "Codex",
	xiaomi: "Xiaomi",
	zai: "z.ai"
};
const usageProviders = [
	"anthropic",
	"github-copilot",
	"google-gemini-cli",
	"minimax",
	"openai-codex",
	"xiaomi",
	"zai"
];
function resolveUsageProviderId(provider) {
	if (!provider) return;
	const normalized = normalizeProviderId(provider);
	if (normalized === "minimax-portal" || normalized === "minimax-cn" || normalized === "minimax-portal-cn") return "minimax";
	return usageProviders.includes(normalized) ? normalized : void 0;
}
const ignoredErrors = new Set([
	"No credentials",
	"No token",
	"No API key",
	"Not logged in",
	"No auth"
]);
const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const withTimeout = async (work, ms, fallback) => {
	let timeout;
	try {
		return await Promise.race([work, new Promise((resolve) => {
			timeout = setTimeout(() => resolve(fallback), ms);
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};
function resolveLegacyPiAgentAuthPath(env) {
	return path.join(resolveRequiredHomeDir(env, os.homedir), ".pi", "agent", "auth.json");
}
function resolveLegacyPiAgentAccessToken(env, providerIds) {
	try {
		const authPath = resolveLegacyPiAgentAuthPath(env);
		if (!fs.existsSync(authPath)) return;
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
		for (const providerId of providerIds) {
			const token = parsed[providerId]?.access;
			if (typeof token === "string" && token.trim()) return token;
		}
		return;
	} catch {
		return;
	}
}
//#endregion
export { resolveLegacyPiAgentAccessToken as a, withTimeout as c, ignoredErrors as i, PROVIDER_LABELS as n, resolveUsageProviderId as o, clampPercent as r, usageProviders as s, DEFAULT_TIMEOUT_MS as t };
