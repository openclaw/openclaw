import { d as isRecord } from "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { Pf as createReplyPrefixOptions, _r as dispatchReplyFromConfig, fv as chunkTextByBreakResolver, g_ as setTopLevelChannelDmPolicyWithAllowFrom, hh as collectIssuesForEnabledAccounts, m_ as setSetupChannelEnabled, mh as asString, nv as loadWebMedia, pr as withReplyDispatcher, v_ as splitSetupEntries } from "./auth-profiles-DqxBs6Au.js";
import { i as isBlockedObjectKey, n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-CYKfwqh7.js";
import { t as runCommandWithTimeout } from "./exec-Fh3CK0qE.js";
import { a as resolveDmGroupAccessWithLists } from "./dm-policy-shared-qfNerugD.js";
import { i as resolveLineAccount, n as normalizeAccountId$1, t as listLineAccountIds } from "./accounts-B1y-wv7m.js";
import { format } from "node:util";
import { z } from "zod";
//#region src/channels/plugins/status-issues/bluebubbles.ts
function readBlueBubblesAccountStatus(value) {
	if (!isRecord(value)) {return null;}
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		configured: value.configured,
		running: value.running,
		baseUrl: value.baseUrl,
		lastError: value.lastError,
		probe: value.probe
	};
}
function readBlueBubblesProbeResult(value) {
	if (!isRecord(value)) {return null;}
	return {
		ok: typeof value.ok === "boolean" ? value.ok : void 0,
		status: typeof value.status === "number" ? value.status : null,
		error: asString(value.error) ?? null
	};
}
function collectBlueBubblesStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readBlueBubblesAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const configured = account.configured === true;
			const running = account.running === true;
			const lastError = asString(account.lastError);
			const probe = readBlueBubblesProbeResult(account.probe);
			if (!configured) {
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "config",
					message: "Not configured (missing serverUrl or password).",
					fix: "Run: openclaw channels add bluebubbles --http-url <server-url> --password <password>"
				});
				return;
			}
			if (probe && probe.ok === false) {
				const errorDetail = probe.error ? `: ${probe.error}` : probe.status ? ` (HTTP ${probe.status})` : "";
				issues.push({
					channel: "bluebubbles",
					accountId,
					kind: "runtime",
					message: `BlueBubbles server unreachable${errorDetail}`,
					fix: "Check that the BlueBubbles server is running and accessible. Verify serverUrl and password in your config."
				});
			}
			if (running && lastError) {issues.push({
				channel: "bluebubbles",
				accountId,
				kind: "runtime",
				message: `Channel error: ${lastError}`,
				fix: "Check gateway logs for details. If the webhook is failing, verify the webhook URL is configured in BlueBubbles server settings."
			});}
		}
	});
}
//#endregion
//#region src/plugin-sdk/allowlist-resolution.ts
/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
async function mapAllowlistResolutionInputs(params) {
	const results = [];
	for (const input of params.inputs) {results.push(await params.mapInput(input));}
	return results;
}
//#endregion
//#region src/plugin-sdk/resolution-notes.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
function formatResolvedUnresolvedNote(params) {
	if (params.resolved.length === 0 && params.unresolved.length === 0) {return;}
	return [params.resolved.length > 0 ? `Resolved: ${params.resolved.join(", ")}` : void 0, params.unresolved.length > 0 ? `Unresolved (kept as typed): ${params.unresolved.join(", ")}` : void 0].filter(Boolean).join("\n");
}
//#endregion
//#region src/plugin-sdk/channel-send-result.ts
/** Normalize raw channel send results into the shape shared outbound callers expect. */
function buildChannelSendResult(channel, result) {
	return {
		channel,
		ok: result.ok,
		messageId: result.messageId ?? "",
		error: result.error ? new Error(result.error) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/allowlist-config-edit.ts
function resolveAccountScopedWriteTarget(parsed, channelId, accountId) {
	const channels = parsed.channels ??= {};
	const channel = channels[channelId] ??= {};
	const normalizedAccountId = normalizeAccountId(accountId);
	if (isBlockedObjectKey(normalizedAccountId)) {return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};}
	const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
	if (!(normalizedAccountId !== "default" || hasAccounts)) {return {
		target: channel,
		pathPrefix: `channels.${channelId}`,
		writeTarget: {
			kind: "channel",
			scope: { channelId }
		}
	};}
	const accounts = channel.accounts ??= {};
	const existingAccount = Object.hasOwn(accounts, normalizedAccountId) ? accounts[normalizedAccountId] : void 0;
	if (!existingAccount || typeof existingAccount !== "object") {accounts[normalizedAccountId] = {};}
	return {
		target: accounts[normalizedAccountId],
		pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
		writeTarget: {
			kind: "account",
			scope: {
				channelId,
				accountId: normalizedAccountId
			}
		}
	};
}
function getNestedValue(root, path) {
	let current = root;
	for (const key of path) {
		if (!current || typeof current !== "object") {return;}
		current = current[key];
	}
	return current;
}
function ensureNestedObject(root, path) {
	let current = root;
	for (const key of path) {
		const existing = current[key];
		if (!existing || typeof existing !== "object") {current[key] = {};}
		current = current[key];
	}
	return current;
}
function setNestedValue(root, path, value) {
	if (path.length === 0) {return;}
	if (path.length === 1) {
		root[path[0]] = value;
		return;
	}
	const parent = ensureNestedObject(root, path.slice(0, -1));
	parent[path[path.length - 1]] = value;
}
function deleteNestedValue(root, path) {
	if (path.length === 0) {return;}
	if (path.length === 1) {
		delete root[path[0]];
		return;
	}
	const parent = getNestedValue(root, path.slice(0, -1));
	if (!parent || typeof parent !== "object") {return;}
	delete parent[path[path.length - 1]];
}
function applyAccountScopedAllowlistConfigEdit(params) {
	const resolvedTarget = resolveAccountScopedWriteTarget(params.parsedConfig, params.channelId, params.accountId);
	const existing = [];
	for (const path of params.paths.readPaths) {
		const existingRaw = getNestedValue(resolvedTarget.target, path);
		if (!Array.isArray(existingRaw)) {continue;}
		for (const entry of existingRaw) {
			const value = String(entry).trim();
			if (!value || existing.includes(value)) {continue;}
			existing.push(value);
		}
	}
	const normalizedEntry = params.normalize([params.entry]);
	if (normalizedEntry.length === 0) {return { kind: "invalid-entry" };}
	const existingNormalized = params.normalize(existing);
	const shouldMatch = (value) => normalizedEntry.includes(value);
	let changed = false;
	let next = existing;
	const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
	if (params.action === "add") {
		if (!configHasEntry) {
			next = [...existing, params.entry.trim()];
			changed = true;
		}
	} else {
		const keep = [];
		for (const entry of existing) {
			if (params.normalize([entry]).some((value) => shouldMatch(value))) {
				changed = true;
				continue;
			}
			keep.push(entry);
		}
		next = keep;
	}
	if (changed) {
		if (next.length === 0) {deleteNestedValue(resolvedTarget.target, params.paths.writePath);}
		else {setNestedValue(resolvedTarget.target, params.paths.writePath, next);}
		for (const path of params.paths.cleanupPaths ?? []) {deleteNestedValue(resolvedTarget.target, path);}
	}
	return {
		kind: "ok",
		changed,
		pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
		writeTarget: resolvedTarget.writeTarget
	};
}
/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
function buildAccountScopedAllowlistConfigEditor(params) {
	return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
		const paths = params.resolvePaths(scope);
		if (!paths) {return null;}
		return applyAccountScopedAllowlistConfigEdit({
			parsedConfig,
			channelId: params.channelId,
			accountId,
			action,
			entry,
			normalize: (values) => params.normalize({
				cfg,
				accountId,
				values
			}),
			paths
		});
	};
}
//#endregion
//#region src/plugin-sdk/command-auth.ts
/** Fast-path DM command authorization when only policy and sender allowlist state matter. */
function resolveDirectDmAuthorizationOutcome(params) {
	if (params.isGroup) {return "allowed";}
	if (params.dmPolicy === "disabled") {return "disabled";}
	if (params.dmPolicy !== "open" && !params.senderAllowedForCommands) {return "unauthorized";}
	return "allowed";
}
/** Runtime-backed wrapper around sender command authorization for grouped helper surfaces. */
async function resolveSenderCommandAuthorizationWithRuntime(params) {
	return resolveSenderCommandAuthorization({
		...params,
		shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
		resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers
	});
}
/** Compute effective allowlists and command authorization for one inbound sender. */
async function resolveSenderCommandAuthorization(params) {
	const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const storeAllowFrom = !params.isGroup && params.dmPolicy !== "allowlist" && (params.dmPolicy !== "open" || shouldComputeAuth) ? await params.readAllowFromStore().catch(() => []) : [];
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: "allowlist",
		allowFrom: params.configuredAllowFrom,
		groupAllowFrom: params.configuredGroupAllowFrom ?? [],
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom)
	});
	const effectiveAllowFrom = access.effectiveAllowFrom;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom);
	const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
	return {
		shouldComputeAuth,
		effectiveAllowFrom,
		effectiveGroupAllowFrom,
		senderAllowedForCommands,
		commandAuthorized: shouldComputeAuth ? params.resolveCommandAuthorizedFromAuthorizers({
			useAccessGroups,
			authorizers: [{
				configured: effectiveAllowFrom.length > 0,
				allowed: ownerAllowedForCommands
			}, {
				configured: effectiveGroupAllowFrom.length > 0,
				allowed: groupAllowedForCommands
			}]
		}) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/reply-payload.ts
/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
function normalizeOutboundReplyPayload(payload) {
	return {
		text: typeof payload.text === "string" ? payload.text : void 0,
		mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls.filter((entry) => typeof entry === "string" && entry.length > 0) : void 0,
		mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : void 0,
		replyToId: typeof payload.replyToId === "string" ? payload.replyToId : void 0
	};
}
/** Wrap a deliverer so callers can hand it arbitrary payloads while channels receive normalized data. */
function createNormalizedOutboundDeliverer(handler) {
	return async (payload) => {
		await handler(payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {});
	};
}
/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
function resolveOutboundMediaUrls(payload) {
	if (payload.mediaUrls?.length) {return payload.mediaUrls;}
	if (payload.mediaUrl) {return [payload.mediaUrl];}
	return [];
}
/** Send media-first payloads intact, or chunk text-only payloads through the caller's transport hooks. */
async function sendPayloadWithChunkedTextAndMedia(params) {
	const payload = params.ctx.payload;
	const text = payload.text ?? "";
	const urls = resolveOutboundMediaUrls(payload);
	if (!text && urls.length === 0) {return params.emptyResult;}
	if (urls.length > 0) {
		let lastResult = await params.sendMedia({
			...params.ctx,
			text,
			mediaUrl: urls[0]
		});
		for (let i = 1; i < urls.length; i++) {lastResult = await params.sendMedia({
			...params.ctx,
			text: "",
			mediaUrl: urls[i]
		});}
		return lastResult;
	}
	const limit = params.textChunkLimit;
	const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
	let lastResult;
	for (const chunk of chunks) {lastResult = await params.sendText({
		...params.ctx,
		text: chunk
	});}
	return lastResult;
}
/** Detect numeric-looking target ids for channels that distinguish ids from handles. */
function isNumericTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return false;}
	return /^\d{3,}$/.test(trimmed);
}
/** Append attachment links to plain text when the channel cannot send media inline. */
function formatTextWithAttachmentLinks(text, mediaUrls) {
	const trimmedText = text?.trim() ?? "";
	if (!trimmedText && mediaUrls.length === 0) {return "";}
	const mediaBlock = mediaUrls.length ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n") : "";
	if (!trimmedText) {return mediaBlock;}
	if (!mediaBlock) {return trimmedText;}
	return `${trimmedText}\n\n${mediaBlock}`;
}
/** Send a caption with only the first media item, mirroring caption-limited channel transports. */
async function sendMediaWithLeadingCaption(params) {
	if (params.mediaUrls.length === 0) {return false;}
	let first = true;
	for (const mediaUrl of params.mediaUrls) {
		const caption = first ? params.caption : void 0;
		first = false;
		try {
			await params.send({
				mediaUrl,
				caption
			});
		} catch (error) {
			if (params.onError) {
				params.onError(error, mediaUrl);
				continue;
			}
			throw error;
		}
	}
	return true;
}
//#endregion
//#region src/plugin-sdk/inbound-reply-dispatch.ts
/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
async function dispatchReplyFromConfigWithSettledDispatcher(params) {
	return await withReplyDispatcher({
		dispatcher: params.dispatcher,
		onSettled: params.onSettled,
		run: () => dispatchReplyFromConfig({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions
		})
	});
}
/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
function buildInboundReplyDispatchBase(params) {
	return {
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		agentId: params.route.agentId,
		routeSessionKey: params.route.sessionKey,
		storePath: params.storePath,
		ctxPayload: params.ctxPayload,
		recordInboundSession: params.core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
	};
}
/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
async function dispatchInboundReplyWithBase(params) {
	await recordInboundSessionAndDispatchReply({
		...buildInboundReplyDispatchBase(params),
		deliver: params.deliver,
		onRecordError: params.onRecordError,
		onDispatchError: params.onDispatchError,
		replyOptions: params.replyOptions
	});
}
/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
async function recordInboundSessionAndDispatchReply(params) {
	await params.recordInboundSession({
		storePath: params.storePath,
		sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
		ctx: params.ctxPayload,
		onRecordError: params.onRecordError
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId
	});
	const deliver = createNormalizedOutboundDeliverer(params.deliver);
	await params.dispatchReplyWithBufferedBlockDispatcher({
		ctx: params.ctxPayload,
		cfg: params.cfg,
		dispatcherOptions: {
			...prefixOptions,
			deliver,
			onError: params.onDispatchError
		},
		replyOptions: {
			...params.replyOptions,
			onModelSelected
		}
	});
}
//#endregion
//#region src/plugin-sdk/outbound-media.ts
/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
	return await loadWebMedia(mediaUrl, {
		maxBytes: options.maxBytes,
		localRoots: options.mediaLocalRoots
	});
}
//#endregion
//#region src/plugin-sdk/runtime.ts
/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
function createLoggerBackedRuntime(params) {
	return {
		log: (...args) => {
			params.logger.info(format(...args));
		},
		error: (...args) => {
			params.logger.error(format(...args));
		},
		exit: (code) => {
			throw params.exitError?.(code) ?? /* @__PURE__ */ new Error(`exit ${code}`);
		}
	};
}
/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
function resolveRuntimeEnv(params) {
	return params.runtime ?? createLoggerBackedRuntime(params);
}
//#endregion
//#region src/plugin-sdk/text-chunking.ts
/** Chunk outbound text while preferring newline boundaries over spaces. */
function chunkTextForOutbound(text, limit) {
	return chunkTextByBreakResolver(text, limit, (window) => {
		const lastNewline = window.lastIndexOf("\n");
		const lastSpace = window.lastIndexOf(" ");
		return lastNewline > 0 ? lastNewline : lastSpace;
	});
}
//#endregion
//#region src/plugin-sdk/run-command.ts
/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
async function runPluginCommandWithTimeout(options) {
	const [command] = options.argv;
	if (!command) {return {
		code: 1,
		stdout: "",
		stderr: "command is required"
	};}
	try {
		const result = await runCommandWithTimeout(options.argv, {
			timeoutMs: options.timeoutMs,
			cwd: options.cwd,
			env: options.env
		});
		const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
		return {
			code: result.code ?? 1,
			stdout: result.stdout,
			stderr: timedOut ? result.stderr || `command timed out after ${options.timeoutMs}ms` : result.stderr
		};
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region src/plugin-sdk/ssrf-policy.ts
function normalizeHostnameSuffix(value) {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) {return "";}
	if (trimmed === "*" || trimmed === "*.") {return "*";}
	return trimmed.replace(/^\*\.?/, "").replace(/^\.+/, "").replace(/\.+$/, "");
}
function isHostnameAllowedBySuffixAllowlist(hostname, allowlist) {
	if (allowlist.includes("*")) {return true;}
	const normalized = hostname.toLowerCase();
	return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}
/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
function normalizeHostnameSuffixAllowlist(input, defaults) {
	const source = input && input.length > 0 ? input : defaults;
	if (!source || source.length === 0) {return [];}
	const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
	if (normalized.includes("*")) {return ["*"];}
	return Array.from(new Set(normalized));
}
/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
function isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") {return false;}
		return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
	} catch {
		return false;
	}
}
/**
* Converts suffix-style host allowlists (for example "example.com") into SSRF
* hostname allowlist patterns used by the shared fetch guard.
*
* Suffix semantics:
* - "example.com" allows "example.com" and "*.example.com"
* - "*" disables hostname allowlist restrictions
*/
function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts) {
	const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
	if (normalizedAllowHosts.length === 0) {return;}
	const patterns = /* @__PURE__ */ new Set();
	for (const normalized of normalizedAllowHosts) {
		if (normalized === "*") {return;}
		patterns.add(normalized);
		patterns.add(`*.${normalized}`);
	}
	if (patterns.size === 0) {return;}
	return { hostnameAllowlist: Array.from(patterns) };
}
//#endregion
//#region extensions/line/src/setup-core.ts
function patchLineAccountConfig(params) {
	const accountId = normalizeAccountId$1(params.accountId);
	const lineConfig = params.cfg.channels?.line ?? {};
	const clearFields = params.clearFields ?? [];
	if (accountId === "default") {
		const nextLine = { ...lineConfig };
		for (const field of clearFields) {delete nextLine[field];}
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				line: {
					...nextLine,
					...params.enabled ? { enabled: true } : {},
					...params.patch
				}
			}
		};
	}
	const nextAccount = { ...lineConfig.accounts?.[accountId] };
	for (const field of clearFields) {delete nextAccount[field];}
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			line: {
				...lineConfig,
				...params.enabled ? { enabled: true } : {},
				accounts: {
					...lineConfig.accounts,
					[accountId]: {
						...nextAccount,
						...params.enabled ? { enabled: true } : {},
						...params.patch
					}
				}
			}
		}
	};
}
function isLineConfigured(cfg, accountId) {
	const resolved = resolveLineAccount({
		cfg,
		accountId
	});
	return Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim());
}
function parseLineAllowFromId(raw) {
	const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
	if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {return null;}
	return trimmed;
}
const lineSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId$1(accountId),
	applyAccountName: ({ cfg, accountId, name }) => patchLineAccountConfig({
		cfg,
		accountId,
		patch: name?.trim() ? { name: name.trim() } : {}
	}),
	validateInput: ({ accountId, input }) => {
		const typedInput = input;
		if (typedInput.useEnv && accountId !== "default") {return "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.";}
		if (!typedInput.useEnv && !typedInput.channelAccessToken && !typedInput.tokenFile) {return "LINE requires channelAccessToken or --token-file (or --use-env).";}
		if (!typedInput.useEnv && !typedInput.channelSecret && !typedInput.secretFile) {return "LINE requires channelSecret or --secret-file (or --use-env).";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const typedInput = input;
		const normalizedAccountId = normalizeAccountId$1(accountId);
		if (normalizedAccountId === "default") {return patchLineAccountConfig({
			cfg,
			accountId: normalizedAccountId,
			enabled: true,
			clearFields: typedInput.useEnv ? [
				"channelAccessToken",
				"channelSecret",
				"tokenFile",
				"secretFile"
			] : void 0,
			patch: typedInput.useEnv ? {} : {
				...typedInput.tokenFile ? { tokenFile: typedInput.tokenFile } : typedInput.channelAccessToken ? { channelAccessToken: typedInput.channelAccessToken } : {},
				...typedInput.secretFile ? { secretFile: typedInput.secretFile } : typedInput.channelSecret ? { channelSecret: typedInput.channelSecret } : {}
			}
		});}
		return patchLineAccountConfig({
			cfg,
			accountId: normalizedAccountId,
			enabled: true,
			patch: {
				...typedInput.tokenFile ? { tokenFile: typedInput.tokenFile } : typedInput.channelAccessToken ? { channelAccessToken: typedInput.channelAccessToken } : {},
				...typedInput.secretFile ? { secretFile: typedInput.secretFile } : typedInput.channelSecret ? { channelSecret: typedInput.channelSecret } : {}
			}
		});
	}
};
//#endregion
//#region extensions/line/src/setup-surface.ts
const channel = "line";
const LINE_SETUP_HELP_LINES = [
	"1) Open the LINE Developers Console and create or pick a Messaging API channel",
	"2) Copy the channel access token and channel secret",
	"3) Enable Use webhook in the Messaging API settings",
	"4) Point the webhook at https://<gateway-host>/line/webhook",
	`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
];
const LINE_ALLOW_FROM_HELP_LINES = [
	"Allowlist LINE DMs by user id.",
	"LINE ids are case-sensitive.",
	"Examples:",
	"- U1234567890abcdef1234567890abcdef",
	"- line:user:U1234567890abcdef1234567890abcdef",
	"Multiple entries: comma-separated.",
	`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
];
const lineSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs token + secret",
		configuredHint: "configured",
		unconfiguredHint: "needs token + secret",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => listLineAccountIds(cfg).some((accountId) => isLineConfigured(cfg, accountId)),
		resolveStatusLines: ({ cfg, configured }) => [`LINE: ${configured ? "configured" : "needs token + secret"}`, `Accounts: ${listLineAccountIds(cfg).length || 0}`]
	},
	introNote: {
		title: "LINE Messaging API",
		lines: LINE_SETUP_HELP_LINES,
		shouldShow: ({ cfg, accountId }) => !isLineConfigured(cfg, accountId)
	},
	credentials: [{
		inputKey: "token",
		providerHint: channel,
		credentialLabel: "channel access token",
		preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
		helpTitle: "LINE Messaging API",
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: "LINE_CHANNEL_ACCESS_TOKEN detected. Use env var?",
		keepPrompt: "LINE channel access token already configured. Keep it?",
		inputPrompt: "Enter LINE channel access token",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveLineAccount({
				cfg,
				accountId
			});
			return {
				accountConfigured: Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim()),
				hasConfiguredValue: Boolean(resolved.config.channelAccessToken?.trim() || resolved.config.tokenFile?.trim()),
				resolvedValue: resolved.channelAccessToken.trim() || void 0,
				envValue: accountId === "default" ? process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || void 0 : void 0
			};
		},
		applyUseEnv: ({ cfg, accountId }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["channelAccessToken", "tokenFile"],
			patch: {}
		}),
		applySet: ({ cfg, accountId, resolvedValue }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["tokenFile"],
			patch: { channelAccessToken: resolvedValue }
		})
	}, {
		inputKey: "password",
		providerHint: "line-secret",
		credentialLabel: "channel secret",
		preferredEnvVar: "LINE_CHANNEL_SECRET",
		helpTitle: "LINE Messaging API",
		helpLines: LINE_SETUP_HELP_LINES,
		envPrompt: "LINE_CHANNEL_SECRET detected. Use env var?",
		keepPrompt: "LINE channel secret already configured. Keep it?",
		inputPrompt: "Enter LINE channel secret",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const resolved = resolveLineAccount({
				cfg,
				accountId
			});
			return {
				accountConfigured: Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim()),
				hasConfiguredValue: Boolean(resolved.config.channelSecret?.trim() || resolved.config.secretFile?.trim()),
				resolvedValue: resolved.channelSecret.trim() || void 0,
				envValue: accountId === "default" ? process.env.LINE_CHANNEL_SECRET?.trim() || void 0 : void 0
			};
		},
		applyUseEnv: ({ cfg, accountId }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["channelSecret", "secretFile"],
			patch: {}
		}),
		applySet: ({ cfg, accountId, resolvedValue }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			clearFields: ["secretFile"],
			patch: { channelSecret: resolvedValue }
		})
	}],
	allowFrom: {
		helpTitle: "LINE allowlist",
		helpLines: LINE_ALLOW_FROM_HELP_LINES,
		message: "LINE allowFrom (user id)",
		placeholder: "U1234567890abcdef1234567890abcdef",
		invalidWithoutCredentialNote: "LINE allowFrom requires raw user ids like U1234567890abcdef1234567890abcdef.",
		parseInputs: splitSetupEntries,
		parseId: parseLineAllowFromId,
		resolveEntries: async ({ entries }) => entries.map((entry) => {
			const id = parseLineAllowFromId(entry);
			return {
				input: entry,
				resolved: Boolean(id),
				id
			};
		}),
		apply: ({ cfg, accountId, allowFrom }) => patchLineAccountConfig({
			cfg,
			accountId,
			enabled: true,
			patch: {
				dmPolicy: "allowlist",
				allowFrom
			}
		})
	},
	dmPolicy: {
		label: "LINE",
		channel,
		policyKey: "channels.line.dmPolicy",
		allowFromKey: "channels.line.allowFrom",
		getCurrent: (cfg) => cfg.channels?.line?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setTopLevelChannelDmPolicyWithAllowFrom({
			cfg,
			channel,
			dmPolicy: policy
		})
	},
	completionNote: {
		title: "LINE webhook",
		lines: [
			"Enable Use webhook in the LINE console after saving credentials.",
			"Default webhook URL: https://<gateway-host>/line/webhook",
			"If you set channels.line.webhookPath, update the URL to match.",
			`Docs: ${formatDocsLink("/channels/line", "channels/line")}`
		]
	},
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
//#region src/line/config-schema.ts
const DmPolicySchema = z.enum([
	"open",
	"allowlist",
	"pairing",
	"disabled"
]);
const GroupPolicySchema = z.enum([
	"open",
	"allowlist",
	"disabled"
]);
const LineCommonConfigSchema = z.object({
	enabled: z.boolean().optional(),
	channelAccessToken: z.string().optional(),
	channelSecret: z.string().optional(),
	tokenFile: z.string().optional(),
	secretFile: z.string().optional(),
	name: z.string().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	responsePrefix: z.string().optional(),
	mediaMaxMb: z.number().optional(),
	webhookPath: z.string().optional()
});
const LineGroupConfigSchema = z.object({
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	requireMention: z.boolean().optional(),
	systemPrompt: z.string().optional(),
	skills: z.array(z.string()).optional()
}).strict();
const LineAccountConfigSchema = LineCommonConfigSchema.extend({ groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional() }).strict();
const LineConfigSchema = LineCommonConfigSchema.extend({
	accounts: z.record(z.string(), LineAccountConfigSchema.optional()).optional(),
	defaultAccount: z.string().optional(),
	groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional()
}).strict();
//#endregion
export { buildChannelSendResult as C, collectBlueBubblesStatusIssues as E, buildAccountScopedAllowlistConfigEditor as S, mapAllowlistResolutionInputs as T, sendMediaWithLeadingCaption as _, isHttpsUrlAllowedByHostnameSuffixAllowlist as a, resolveSenderCommandAuthorization as b, chunkTextForOutbound as c, loadOutboundMediaFromUrl as d, dispatchInboundReplyWithBase as f, resolveOutboundMediaUrls as g, isNumericTargetId as h, buildHostnameAllowlistPolicyFromSuffixAllowlist as i, createLoggerBackedRuntime as l, formatTextWithAttachmentLinks as m, lineSetupWizard as n, normalizeHostnameSuffixAllowlist as o, dispatchReplyFromConfigWithSettledDispatcher as p, lineSetupAdapter as r, runPluginCommandWithTimeout as s, LineConfigSchema as t, resolveRuntimeEnv as u, sendPayloadWithChunkedTextAndMedia as v, formatResolvedUnresolvedNote as w, resolveSenderCommandAuthorizationWithRuntime as x, resolveDirectDmAuthorizationOutcome as y };
