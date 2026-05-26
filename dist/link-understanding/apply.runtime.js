import { a as shouldLogVerbose, r as logVerbose } from "../globals-YU5FjfZK.js";
import { r as runCommandWithTimeout } from "../exec-D4bhAbbv.js";
import { c as isBlockedHostnameOrIp } from "../ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard, t as GUARDED_FETCH_MODE } from "../fetch-guard-BEAbHb5H.js";
import { n as readResponseWithLimit } from "../read-response-with-limit-S6PVjcFB.js";
import "../defaults-DCsp7qAB.js";
import { t as CLI_OUTPUT_MAX_BUFFER } from "../defaults.constants-DeIx7Gbv.js";
import { c as normalizeMediaUnderstandingChatType, l as resolveMediaUnderstandingScope, s as resolveTimeoutMs } from "../resolve-CJVCx0AN.js";
import { t as applyTemplate } from "../templating-CLmjS51i.js";
import { t as finalizeInboundContext } from "../inbound-context-Cg0uCtqQ.js";
//#region src/link-understanding/format.ts
function formatLinkUnderstandingBody(params) {
	const outputs = params.outputs.map((output) => output.trim()).filter(Boolean);
	if (outputs.length === 0) return params.body ?? "";
	const base = (params.body ?? "").trim();
	if (!base) return outputs.join("\n");
	return `${base}\n\n${outputs.join("\n")}`;
}
//#endregion
//#region src/link-understanding/detect.ts
const MARKDOWN_LINK_RE = /\[[^\]]*]\((https?:\/\/\S+?)\)/gi;
const BARE_LINK_RE = /https?:\/\/\S+/gi;
function stripMarkdownLinks(message) {
	return message.replace(MARKDOWN_LINK_RE, " ");
}
function resolveMaxLinks(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	return 3;
}
function isAllowedUrl(raw) {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (isBlockedHostnameOrIp(parsed.hostname)) return false;
		return true;
	} catch {
		return false;
	}
}
function extractLinksFromMessage(message, opts) {
	const source = message?.trim();
	if (!source) return [];
	const maxLinks = resolveMaxLinks(opts?.maxLinks);
	const sanitized = stripMarkdownLinks(source);
	const seen = /* @__PURE__ */ new Set();
	const results = [];
	for (const match of sanitized.matchAll(BARE_LINK_RE)) {
		const raw = match[0]?.trim();
		if (!raw) continue;
		if (!isAllowedUrl(raw)) continue;
		if (seen.has(raw)) continue;
		seen.add(raw);
		results.push(raw);
		if (results.length >= maxLinks) break;
	}
	return results;
}
//#endregion
//#region src/link-understanding/runner.ts
function resolveScopeDecision(params) {
	return resolveMediaUnderstandingScope({
		scope: params.config?.scope,
		sessionKey: params.ctx.SessionKey,
		channel: params.ctx.Surface ?? params.ctx.Provider,
		chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType)
	});
}
function resolveTimeoutMsFromConfig(params) {
	return resolveTimeoutMs(params.entry.timeoutSeconds ?? params.config?.timeoutSeconds, 30);
}
function isLinkUrlTemplate(value) {
	return value.includes("LinkUrl") || value.includes("LinkFinalUrl");
}
function commandName(command) {
	return (command.split(/[\\/]/).pop() ?? command).toLowerCase();
}
function isUrlFetcherCommand(command) {
	return commandName(command) === "curl" || commandName(command) === "wget";
}
function buildLinkCliArgs(params) {
	const templCtx = {
		...params.ctx,
		LinkFinalUrl: params.finalUrl,
		LinkUrl: params.url
	};
	return params.args.filter((arg) => !isLinkUrlTemplate(arg)).map((arg) => applyTemplate(arg, templCtx));
}
async function fetchLinkContent(params) {
	const { response, finalUrl, release } = await fetchWithSsrFGuard({
		url: params.url,
		timeoutMs: params.timeoutMs,
		mode: GUARDED_FETCH_MODE.STRICT,
		auditContext: "link-understanding",
		init: { headers: {
			Accept: "text/*,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"User-Agent": "OpenClaw-LinkUnderstanding/1.0"
		} }
	});
	try {
		if (!response.ok) throw new Error(`Link fetch failed with HTTP ${response.status}`);
		const buffer = await readResponseWithLimit(response, CLI_OUTPUT_MAX_BUFFER);
		const content = new TextDecoder().decode(buffer).trim();
		if (!content) return null;
		return {
			content,
			finalUrl
		};
	} finally {
		await release();
	}
}
async function runCliEntry(params) {
	if ((params.entry.type ?? "cli") !== "cli") return null;
	const command = params.entry.command.trim();
	if (!command) return null;
	const args = params.entry.args ?? [];
	const timeoutMs = resolveTimeoutMsFromConfig({
		config: params.config,
		entry: params.entry
	});
	if (isUrlFetcherCommand(command) && args.some(isLinkUrlTemplate)) return params.content;
	const argv = [command, ...buildLinkCliArgs({
		args,
		ctx: params.ctx,
		finalUrl: params.finalUrl,
		url: params.url
	})];
	if (shouldLogVerbose()) logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
	const result = await runCommandWithTimeout(argv, {
		timeoutMs,
		input: params.content,
		env: {
			OPENCLAW_LINK_FINAL_URL: params.finalUrl,
			OPENCLAW_LINK_URL: params.url
		}
	});
	if (result.code !== 0) throw new Error(`Link understanding command exited with code ${result.code ?? "unknown"}`);
	return result.stdout.trim() || null;
}
async function runLinkEntries(params) {
	let lastError;
	for (const entry of params.entries) try {
		const output = await runCliEntry({
			content: params.content,
			entry,
			finalUrl: params.finalUrl,
			ctx: params.ctx,
			url: params.url,
			config: params.config
		});
		if (output) return output;
	} catch (err) {
		lastError = err;
		if (shouldLogVerbose()) logVerbose(`Link understanding failed for ${params.url}: ${String(err)}`);
	}
	if (lastError && shouldLogVerbose()) logVerbose(`Link understanding exhausted for ${params.url}`);
	return null;
}
async function runLinkUnderstanding(params) {
	const config = params.cfg.tools?.links;
	if (!config || config.enabled === false) return {
		urls: [],
		outputs: []
	};
	if (resolveScopeDecision({
		config,
		ctx: params.ctx
	}) === "deny") {
		if (shouldLogVerbose()) logVerbose("Link understanding disabled by scope policy.");
		return {
			urls: [],
			outputs: []
		};
	}
	const links = extractLinksFromMessage(params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body ?? "", { maxLinks: config?.maxLinks });
	if (links.length === 0) return {
		urls: [],
		outputs: []
	};
	const entries = config?.models ?? [];
	if (entries.length === 0) return {
		urls: links,
		outputs: []
	};
	const outputs = [];
	for (const url of links) {
		const timeoutMs = resolveTimeoutMsFromConfig({
			config,
			entry: entries[0]
		});
		let fetched;
		try {
			fetched = await fetchLinkContent({
				url,
				timeoutMs
			});
		} catch (err) {
			if (shouldLogVerbose()) logVerbose(`Link understanding fetch blocked or failed for ${url}: ${String(err)}`);
			continue;
		}
		if (!fetched) continue;
		const output = await runLinkEntries({
			content: fetched.content,
			entries,
			finalUrl: fetched.finalUrl,
			ctx: params.ctx,
			url,
			config
		}) ?? fetched.content;
		if (output) outputs.push(output);
	}
	return {
		urls: links,
		outputs
	};
}
//#endregion
//#region src/link-understanding/apply.ts
async function applyLinkUnderstanding(params) {
	const result = await runLinkUnderstanding({
		cfg: params.cfg,
		ctx: params.ctx
	});
	if (result.outputs.length === 0) return result;
	params.ctx.LinkUnderstanding = [...params.ctx.LinkUnderstanding ?? [], ...result.outputs];
	params.ctx.Body = formatLinkUnderstandingBody({
		body: params.ctx.Body,
		outputs: result.outputs
	});
	finalizeInboundContext(params.ctx, {
		forceBodyForAgent: true,
		forceBodyForCommands: true
	});
	return result;
}
//#endregion
export { applyLinkUnderstanding };
