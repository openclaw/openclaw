import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { m as normalizeOptionalAccountId, p as normalizeAccountId } from "./session-key-47BV2tLd.js";
import { s as resolveStateDir } from "./paths-DVWx7USN.js";
import { D as triggerInternalHook, E as createInternalHookEvent, h as getActivePluginRegistry, t as createSubsystemLogger } from "./subsystem-B0uKDnzH.js";
import { t as getChannelDock } from "./dock-k3PRCoNo.js";
import { T as parseInlineDirectives, a as resolveMirroredTranscriptText, i as appendAssistantMessageToSessionTranscript } from "./sessions-Bk9xxDOW.js";
import { r as normalizeChannelId, t as getChannelPlugin } from "./plugins-D_msJzdO.js";
import { t as getAgentScopedMediaLocalRoots } from "./local-roots-DbFvAaXE.js";
import { c as resolveChunkMode, i as chunkMarkdownTextWithMode, l as resolveTextChunkLimit, n as chunkByParagraph, p as parseFenceSpans } from "./chunk-Do0HitoK.js";
import { n as resolveMarkdownTableMode } from "./markdown-tables-B31KzXG_.js";
import { i as isSilentReplyText, n as SILENT_REPLY_TOKEN } from "./tokens-j6DhISSx.js";
import { i as isMessagingToolDuplicate } from "./pi-embedded-helpers-VjN-WAoA.js";
import { n as generateSecureUuid } from "./secure-random-CV-D0cj2.js";
import { a as markdownToSignalTextChunks, t as sendMessageSignal } from "./send-Bg4ktfNQ.js";
import fs from "node:fs";
import path from "node:path";

//#region src/channels/plugins/media-limits.ts
const MB = 1024 * 1024;
function resolveChannelMediaMaxBytes(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelLimit = params.resolveChannelLimitMb({
		cfg: params.cfg,
		accountId
	});
	if (channelLimit) return channelLimit * MB;
	if (params.cfg.agents?.defaults?.mediaMaxMb) return params.cfg.agents.defaults.mediaMaxMb * MB;
}

//#endregion
//#region src/plugins/hooks.ts
/**
* Get hooks for a specific hook name, sorted by priority (higher first).
*/
function getHooksForName(registry, hookName) {
	return registry.typedHooks.filter((h) => h.hookName === hookName).toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
/**
* Create a hook runner for a specific registry.
*/
function createHookRunner(registry, options = {}) {
	const logger = options.logger;
	const catchErrors = options.catchErrors ?? true;
	const mergeBeforeModelResolve = (acc, next) => ({
		modelOverride: acc?.modelOverride ?? next.modelOverride,
		providerOverride: acc?.providerOverride ?? next.providerOverride
	});
	const mergeBeforePromptBuild = (acc, next) => ({
		systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
		prependContext: acc?.prependContext && next.prependContext ? `${acc.prependContext}\n\n${next.prependContext}` : next.prependContext ?? acc?.prependContext
	});
	const mergeSubagentSpawningResult = (acc, next) => {
		if (acc?.status === "error") return acc;
		if (next.status === "error") return next;
		return {
			status: "ok",
			threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady)
		};
	};
	const mergeSubagentDeliveryTargetResult = (acc, next) => {
		if (acc?.origin) return acc;
		return next;
	};
	const handleHookError = (params) => {
		const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${String(params.error)}`;
		if (catchErrors) {
			logger?.error(msg);
			return;
		}
		throw new Error(msg, { cause: params.error });
	};
	/**
	* Run a hook that doesn't return a value (fire-and-forget style).
	* All handlers are executed in parallel for performance.
	*/
	async function runVoidHook(hookName, event, ctx) {
		const hooks = getHooksForName(registry, hookName);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);
		const promises = hooks.map(async (hook) => {
			try {
				await hook.handler(event, ctx);
			} catch (err) {
				handleHookError({
					hookName,
					pluginId: hook.pluginId,
					error: err
				});
			}
		});
		await Promise.all(promises);
	}
	/**
	* Run a hook that can return a modifying result.
	* Handlers are executed sequentially in priority order, and results are merged.
	*/
	async function runModifyingHook(hookName, event, ctx, mergeResults) {
		const hooks = getHooksForName(registry, hookName);
		if (hooks.length === 0) return;
		logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);
		let result;
		for (const hook of hooks) try {
			const handlerResult = await hook.handler(event, ctx);
			if (handlerResult !== void 0 && handlerResult !== null) if (mergeResults && result !== void 0) result = mergeResults(result, handlerResult);
			else result = handlerResult;
		} catch (err) {
			handleHookError({
				hookName,
				pluginId: hook.pluginId,
				error: err
			});
		}
		return result;
	}
	/**
	* Run before_model_resolve hook.
	* Allows plugins to override provider/model before model resolution.
	*/
	async function runBeforeModelResolve(event, ctx) {
		return runModifyingHook("before_model_resolve", event, ctx, mergeBeforeModelResolve);
	}
	/**
	* Run before_prompt_build hook.
	* Allows plugins to inject context and system prompt before prompt submission.
	*/
	async function runBeforePromptBuild(event, ctx) {
		return runModifyingHook("before_prompt_build", event, ctx, mergeBeforePromptBuild);
	}
	/**
	* Run before_agent_start hook.
	* Legacy compatibility hook that combines model resolve + prompt build phases.
	*/
	async function runBeforeAgentStart(event, ctx) {
		return runModifyingHook("before_agent_start", event, ctx, (acc, next) => ({
			...mergeBeforePromptBuild(acc, next),
			...mergeBeforeModelResolve(acc, next)
		}));
	}
	/**
	* Run agent_end hook.
	* Allows plugins to analyze completed conversations.
	* Runs in parallel (fire-and-forget).
	*/
	async function runAgentEnd(event, ctx) {
		return runVoidHook("agent_end", event, ctx);
	}
	/**
	* Run llm_input hook.
	* Allows plugins to observe the exact input payload sent to the LLM.
	* Runs in parallel (fire-and-forget).
	*/
	async function runLlmInput(event, ctx) {
		return runVoidHook("llm_input", event, ctx);
	}
	/**
	* Run llm_output hook.
	* Allows plugins to observe the exact output payload returned by the LLM.
	* Runs in parallel (fire-and-forget).
	*/
	async function runLlmOutput(event, ctx) {
		return runVoidHook("llm_output", event, ctx);
	}
	/**
	* Run before_compaction hook.
	*/
	async function runBeforeCompaction(event, ctx) {
		return runVoidHook("before_compaction", event, ctx);
	}
	/**
	* Run after_compaction hook.
	*/
	async function runAfterCompaction(event, ctx) {
		return runVoidHook("after_compaction", event, ctx);
	}
	/**
	* Run before_reset hook.
	* Fired when /new or /reset clears a session, before messages are lost.
	* Runs in parallel (fire-and-forget).
	*/
	async function runBeforeReset(event, ctx) {
		return runVoidHook("before_reset", event, ctx);
	}
	/**
	* Run message_received hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runMessageReceived(event, ctx) {
		return runVoidHook("message_received", event, ctx);
	}
	/**
	* Run message_sending hook.
	* Allows plugins to modify or cancel outgoing messages.
	* Runs sequentially.
	*/
	async function runMessageSending(event, ctx) {
		return runModifyingHook("message_sending", event, ctx, (acc, next) => ({
			content: next.content ?? acc?.content,
			cancel: next.cancel ?? acc?.cancel
		}));
	}
	/**
	* Run message_sent hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runMessageSent(event, ctx) {
		return runVoidHook("message_sent", event, ctx);
	}
	/**
	* Run before_tool_call hook.
	* Allows plugins to modify or block tool calls.
	* Runs sequentially.
	*/
	async function runBeforeToolCall(event, ctx) {
		return runModifyingHook("before_tool_call", event, ctx, (acc, next) => ({
			params: next.params ?? acc?.params,
			block: next.block ?? acc?.block,
			blockReason: next.blockReason ?? acc?.blockReason
		}));
	}
	/**
	* Run after_tool_call hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runAfterToolCall(event, ctx) {
		return runVoidHook("after_tool_call", event, ctx);
	}
	/**
	* Run tool_result_persist hook.
	*
	* This hook is intentionally synchronous: it runs in hot paths where session
	* transcripts are appended synchronously.
	*
	* Handlers are executed sequentially in priority order (higher first). Each
	* handler may return `{ message }` to replace the message passed to the next
	* handler.
	*/
	function runToolResultPersist(event, ctx) {
		const hooks = getHooksForName(registry, "tool_result_persist");
		if (hooks.length === 0) return;
		let current = event.message;
		for (const hook of hooks) try {
			const out = hook.handler({
				...event,
				message: current
			}, ctx);
			if (out && typeof out.then === "function") {
				const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} returned a Promise; this hook is synchronous and the result was ignored.`;
				if (catchErrors) {
					logger?.warn?.(msg);
					continue;
				}
				throw new Error(msg);
			}
			const next = out?.message;
			if (next) current = next;
		} catch (err) {
			const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} failed: ${String(err)}`;
			if (catchErrors) logger?.error(msg);
			else throw new Error(msg, { cause: err });
		}
		return { message: current };
	}
	/**
	* Run before_message_write hook.
	*
	* This hook is intentionally synchronous: it runs on the hot path where
	* session transcripts are appended synchronously.
	*
	* Handlers are executed sequentially in priority order (higher first).
	* If any handler returns { block: true }, the message is NOT written
	* to the session JSONL and we return immediately.
	* If a handler returns { message }, the modified message replaces the
	* original for subsequent handlers and the final write.
	*/
	function runBeforeMessageWrite(event, ctx) {
		const hooks = getHooksForName(registry, "before_message_write");
		if (hooks.length === 0) return;
		let current = event.message;
		for (const hook of hooks) try {
			const out = hook.handler({
				...event,
				message: current
			}, ctx);
			if (out && typeof out.then === "function") {
				const msg = `[hooks] before_message_write handler from ${hook.pluginId} returned a Promise; this hook is synchronous and the result was ignored.`;
				if (catchErrors) {
					logger?.warn?.(msg);
					continue;
				}
				throw new Error(msg);
			}
			const result = out;
			if (result?.block) return { block: true };
			if (result?.message) current = result.message;
		} catch (err) {
			const msg = `[hooks] before_message_write handler from ${hook.pluginId} failed: ${String(err)}`;
			if (catchErrors) logger?.error(msg);
			else throw new Error(msg, { cause: err });
		}
		if (current !== event.message) return { message: current };
	}
	/**
	* Run session_start hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSessionStart(event, ctx) {
		return runVoidHook("session_start", event, ctx);
	}
	/**
	* Run session_end hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSessionEnd(event, ctx) {
		return runVoidHook("session_end", event, ctx);
	}
	/**
	* Run subagent_spawning hook.
	* Runs sequentially so channel plugins can deterministically provision session bindings.
	*/
	async function runSubagentSpawning(event, ctx) {
		return runModifyingHook("subagent_spawning", event, ctx, mergeSubagentSpawningResult);
	}
	/**
	* Run subagent_delivery_target hook.
	* Runs sequentially so channel plugins can deterministically resolve routing.
	*/
	async function runSubagentDeliveryTarget(event, ctx) {
		return runModifyingHook("subagent_delivery_target", event, ctx, mergeSubagentDeliveryTargetResult);
	}
	/**
	* Run subagent_spawned hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSubagentSpawned(event, ctx) {
		return runVoidHook("subagent_spawned", event, ctx);
	}
	/**
	* Run subagent_ended hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runSubagentEnded(event, ctx) {
		return runVoidHook("subagent_ended", event, ctx);
	}
	/**
	* Run gateway_start hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runGatewayStart(event, ctx) {
		return runVoidHook("gateway_start", event, ctx);
	}
	/**
	* Run gateway_stop hook.
	* Runs in parallel (fire-and-forget).
	*/
	async function runGatewayStop(event, ctx) {
		return runVoidHook("gateway_stop", event, ctx);
	}
	/**
	* Check if any hooks are registered for a given hook name.
	*/
	function hasHooks(hookName) {
		return registry.typedHooks.some((h) => h.hookName === hookName);
	}
	/**
	* Get count of registered hooks for a given hook name.
	*/
	function getHookCount(hookName) {
		return registry.typedHooks.filter((h) => h.hookName === hookName).length;
	}
	return {
		runBeforeModelResolve,
		runBeforePromptBuild,
		runBeforeAgentStart,
		runLlmInput,
		runLlmOutput,
		runAgentEnd,
		runBeforeCompaction,
		runAfterCompaction,
		runBeforeReset,
		runMessageReceived,
		runMessageSending,
		runMessageSent,
		runBeforeToolCall,
		runAfterToolCall,
		runToolResultPersist,
		runBeforeMessageWrite,
		runSessionStart,
		runSessionEnd,
		runSubagentSpawning,
		runSubagentDeliveryTarget,
		runSubagentSpawned,
		runSubagentEnded,
		runGatewayStart,
		runGatewayStop,
		hasHooks,
		getHookCount
	};
}

//#endregion
//#region src/plugins/hook-runner-global.ts
/**
* Global Plugin Hook Runner
*
* Singleton hook runner that's initialized when plugins are loaded
* and can be called from anywhere in the codebase.
*/
const log$1 = createSubsystemLogger("plugins");
let globalHookRunner = null;
let globalRegistry = null;
/**
* Initialize the global hook runner with a plugin registry.
* Called once when plugins are loaded during gateway startup.
*/
function initializeGlobalHookRunner(registry) {
	globalRegistry = registry;
	globalHookRunner = createHookRunner(registry, {
		logger: {
			debug: (msg) => log$1.debug(msg),
			warn: (msg) => log$1.warn(msg),
			error: (msg) => log$1.error(msg)
		},
		catchErrors: true
	});
	const hookCount = registry.hooks.length;
	if (hookCount > 0) log$1.info(`hook runner initialized with ${hookCount} registered hooks`);
}
/**
* Get the global hook runner.
* Returns null if plugins haven't been loaded yet.
*/
function getGlobalHookRunner() {
	return globalHookRunner;
}

//#endregion
//#region src/infra/outbound/target-normalization.ts
function normalizeChannelTargetInput(raw) {
	return raw.trim();
}
function normalizeTargetForProvider(provider, raw) {
	if (!raw) return;
	const providerId = normalizeChannelId(provider);
	return ((providerId ? getChannelPlugin(providerId) : void 0)?.messaging?.normalizeTarget?.(raw) ?? (raw.trim() || void 0)) || void 0;
}
function buildTargetResolverSignature(channel) {
	const resolver = getChannelPlugin(channel)?.messaging?.targetResolver;
	const hint = resolver?.hint ?? "";
	const looksLike = resolver?.looksLikeId;
	return hashSignature(`${hint}|${looksLike ? looksLike.toString() : ""}`);
}
function hashSignature(value) {
	let hash = 5381;
	for (let i = 0; i < value.length; i += 1) hash = (hash << 5) + hash ^ value.charCodeAt(i);
	return (hash >>> 0).toString(36);
}

//#endregion
//#region src/auto-reply/reply/reply-tags.ts
function extractReplyToTag(text, currentMessageId) {
	const result = parseInlineDirectives(text, {
		currentMessageId,
		stripAudioTag: false
	});
	return {
		cleaned: result.text,
		replyToId: result.replyToId,
		replyToCurrent: result.replyToCurrent,
		hasTag: result.hasReplyTag
	};
}

//#endregion
//#region src/auto-reply/reply/reply-threading.ts
function resolveReplyToMode(cfg, channel, accountId, chatType) {
	const provider = normalizeChannelId(channel);
	if (!provider) return "all";
	return getChannelDock(provider)?.threading?.resolveReplyToMode?.({
		cfg,
		accountId,
		chatType
	}) ?? "all";
}
function createReplyToModeFilter(mode, opts = {}) {
	let hasThreaded = false;
	return (payload) => {
		if (!payload.replyToId) return payload;
		if (mode === "off") {
			const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
			if (opts.allowExplicitReplyTagsWhenOff && isExplicit) return payload;
			return {
				...payload,
				replyToId: void 0
			};
		}
		if (mode === "all") return payload;
		if (hasThreaded) return {
			...payload,
			replyToId: void 0
		};
		hasThreaded = true;
		return payload;
	};
}
function createReplyToModeFilterForChannel(mode, channel) {
	const provider = normalizeChannelId(channel);
	const isWebchat = (typeof channel === "string" ? channel.trim().toLowerCase() : void 0) === "webchat";
	const dock = provider ? getChannelDock(provider) : void 0;
	return createReplyToModeFilter(mode, { allowExplicitReplyTagsWhenOff: provider ? dock?.threading?.allowExplicitReplyTagsWhenOff ?? dock?.threading?.allowTagsWhenOff ?? true : isWebchat });
}

//#endregion
//#region src/auto-reply/reply/reply-payloads.ts
function resolveReplyThreadingForPayload(params) {
	const implicitReplyToId = params.implicitReplyToId?.trim() || void 0;
	const currentMessageId = params.currentMessageId?.trim() || void 0;
	let resolved = params.payload.replyToId || params.payload.replyToCurrent === false || !implicitReplyToId ? params.payload : {
		...params.payload,
		replyToId: implicitReplyToId
	};
	if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
		const { cleaned, replyToId, replyToCurrent, hasTag } = extractReplyToTag(resolved.text, currentMessageId);
		resolved = {
			...resolved,
			text: cleaned ? cleaned : void 0,
			replyToId: replyToId ?? resolved.replyToId,
			replyToTag: hasTag || resolved.replyToTag,
			replyToCurrent: replyToCurrent || resolved.replyToCurrent
		};
	}
	if (resolved.replyToCurrent && !resolved.replyToId && currentMessageId) resolved = {
		...resolved,
		replyToId: currentMessageId
	};
	return resolved;
}
function applyReplyTagsToPayload(payload, currentMessageId) {
	return resolveReplyThreadingForPayload({
		payload,
		currentMessageId
	});
}
function isRenderablePayload(payload) {
	return Boolean(payload.text || payload.mediaUrl || payload.mediaUrls && payload.mediaUrls.length > 0 || payload.audioAsVoice || payload.channelData);
}
function shouldSuppressReasoningPayload(payload) {
	return payload.isReasoning === true;
}
function applyReplyThreading(params) {
	const { payloads, replyToMode, replyToChannel, currentMessageId } = params;
	const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
	const implicitReplyToId = currentMessageId?.trim() || void 0;
	return payloads.map((payload) => resolveReplyThreadingForPayload({
		payload,
		implicitReplyToId,
		currentMessageId
	})).filter(isRenderablePayload).map(applyReplyToMode);
}
function filterMessagingToolDuplicates(params) {
	const { payloads, sentTexts } = params;
	if (sentTexts.length === 0) return payloads;
	return payloads.filter((payload) => !isMessagingToolDuplicate(payload.text ?? "", sentTexts));
}
function filterMessagingToolMediaDuplicates(params) {
	const normalizeMediaForDedupe = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "";
		if (!trimmed.toLowerCase().startsWith("file://")) return trimmed;
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname || "");
		} catch {}
		return trimmed.replace(/^file:\/\//i, "");
	};
	const { payloads, sentMediaUrls } = params;
	if (sentMediaUrls.length === 0) return payloads;
	const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
	return payloads.map((payload) => {
		const mediaUrl = payload.mediaUrl;
		const mediaUrls = payload.mediaUrls;
		const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
		const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
		if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) return payload;
		return {
			...payload,
			mediaUrl: stripSingle ? void 0 : mediaUrl,
			mediaUrls: filteredUrls?.length ? filteredUrls : void 0
		};
	});
}
function shouldSuppressMessagingToolReplies(params) {
	const provider = params.messageProvider?.trim().toLowerCase();
	if (!provider) return false;
	const originTarget = normalizeTargetForProvider(provider, params.originatingTo);
	if (!originTarget) return false;
	const originAccount = normalizeOptionalAccountId(params.accountId);
	const sentTargets = params.messagingToolSentTargets ?? [];
	if (sentTargets.length === 0) return false;
	return sentTargets.some((target) => {
		if (!target?.provider) return false;
		if (target.provider.trim().toLowerCase() !== provider) return false;
		const targetKey = normalizeTargetForProvider(provider, target.to);
		if (!targetKey) return false;
		const targetAccount = normalizeOptionalAccountId(target.accountId);
		if (originAccount && targetAccount && originAccount !== targetAccount) return false;
		return targetKey === originTarget;
	});
}

//#endregion
//#region src/channels/plugins/registry-loader.ts
function createChannelRegistryLoader(resolveValue) {
	const cache = /* @__PURE__ */ new Map();
	let lastRegistry = null;
	return async (id) => {
		const registry = getActivePluginRegistry();
		if (registry !== lastRegistry) {
			cache.clear();
			lastRegistry = registry;
		}
		const cached = cache.get(id);
		if (cached) return cached;
		const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
		if (!pluginEntry) return;
		const resolved = resolveValue(pluginEntry);
		if (resolved) cache.set(id, resolved);
		return resolved;
	};
}

//#endregion
//#region src/channels/plugins/outbound/load.ts
const loadOutboundAdapterFromRegistry = createChannelRegistryLoader((entry) => entry.plugin.outbound);
async function loadChannelOutboundAdapter(id) {
	return loadOutboundAdapterFromRegistry(id);
}

//#endregion
//#region src/infra/outbound/abort.ts
/**
* Utility for checking AbortSignal state and throwing a standard AbortError.
*/
/**
* Throws an AbortError if the given signal has been aborted.
* Use at async checkpoints to support cancellation.
*/
function throwIfAborted(abortSignal) {
	if (abortSignal?.aborted) {
		const err = /* @__PURE__ */ new Error("Operation aborted");
		err.name = "AbortError";
		throw err;
	}
}

//#endregion
//#region src/infra/outbound/delivery-queue.ts
const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
function resolveQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}
/** Ensure the queue directory (and failed/ subdirectory) exist. */
async function ensureQueueDir(stateDir) {
	const queueDir = resolveQueueDir(stateDir);
	await fs.promises.mkdir(queueDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.mkdir(resolveFailedDir(stateDir), {
		recursive: true,
		mode: 448
	});
	return queueDir;
}
async function enqueueDelivery(params, stateDir) {
	const queueDir = await ensureQueueDir(stateDir);
	const id = generateSecureUuid();
	const entry = {
		id,
		enqueuedAt: Date.now(),
		channel: params.channel,
		to: params.to,
		accountId: params.accountId,
		payloads: params.payloads,
		threadId: params.threadId,
		replyToId: params.replyToId,
		bestEffort: params.bestEffort,
		gifPlayback: params.gifPlayback,
		silent: params.silent,
		mirror: params.mirror,
		retryCount: 0
	};
	const filePath = path.join(queueDir, `${id}.json`);
	const tmp = `${filePath}.${process.pid}.tmp`;
	const json = JSON.stringify(entry, null, 2);
	await fs.promises.writeFile(tmp, json, {
		encoding: "utf-8",
		mode: 384
	});
	await fs.promises.rename(tmp, filePath);
	return id;
}
/** Remove a successfully delivered entry from the queue. */
async function ackDelivery(id, stateDir) {
	const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if ((err && typeof err === "object" && "code" in err ? String(err.code) : null) !== "ENOENT") throw err;
	}
}
/** Update a queue entry after a failed delivery attempt. */
async function failDelivery(id, error, stateDir) {
	const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
	const raw = await fs.promises.readFile(filePath, "utf-8");
	const entry = JSON.parse(raw);
	entry.retryCount += 1;
	entry.lastAttemptAt = Date.now();
	entry.lastError = error;
	const tmp = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
		encoding: "utf-8",
		mode: 384
	});
	await fs.promises.rename(tmp, filePath);
}

//#endregion
//#region src/media/audio-tags.ts
/**
* Extract audio mode tag from text.
* Supports [[audio_as_voice]] to send audio as voice bubble instead of file.
* Default is file (preserves backward compatibility).
*/
function parseAudioTag(text) {
	const result = parseInlineDirectives(text, { stripReplyTags: false });
	return {
		text: result.text,
		audioAsVoice: result.audioAsVoice,
		hadTag: result.hasAudioTag
	};
}

//#endregion
//#region src/media/parse.ts
const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;
function normalizeMediaSource(src) {
	return src.startsWith("file://") ? src.replace("file://", "") : src;
}
function cleanCandidate(raw) {
	return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;
function isLikelyLocalPath(candidate) {
	return candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../") || candidate.startsWith("~") || WINDOWS_DRIVE_RE.test(candidate) || candidate.startsWith("\\\\") || !SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\"));
}
function isValidMedia(candidate, opts) {
	if (!candidate) return false;
	if (candidate.length > 4096) return false;
	if (!opts?.allowSpaces && /\s/.test(candidate)) return false;
	if (/^https?:\/\//i.test(candidate)) return true;
	if (isLikelyLocalPath(candidate)) return true;
	if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) return true;
	return false;
}
function unwrapQuoted(value) {
	const trimmed = value.trim();
	if (trimmed.length < 2) return;
	const first = trimmed[0];
	if (first !== trimmed[trimmed.length - 1]) return;
	if (first !== `"` && first !== "'" && first !== "`") return;
	return trimmed.slice(1, -1).trim();
}
function isInsideFence(fenceSpans, offset) {
	return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}
function splitMediaFromOutput(raw) {
	const trimmedRaw = raw.trimEnd();
	if (!trimmedRaw.trim()) return { text: "" };
	const media = [];
	let foundMediaToken = false;
	const fenceSpans = parseFenceSpans(trimmedRaw);
	const lines = trimmedRaw.split("\n");
	const keptLines = [];
	let lineOffset = 0;
	for (const line of lines) {
		if (isInsideFence(fenceSpans, lineOffset)) {
			keptLines.push(line);
			lineOffset += line.length + 1;
			continue;
		}
		if (!line.trimStart().startsWith("MEDIA:")) {
			keptLines.push(line);
			lineOffset += line.length + 1;
			continue;
		}
		const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
		if (matches.length === 0) {
			keptLines.push(line);
			lineOffset += line.length + 1;
			continue;
		}
		const pieces = [];
		let cursor = 0;
		for (const match of matches) {
			const start = match.index ?? 0;
			pieces.push(line.slice(cursor, start));
			const payload = match[1];
			const unwrapped = unwrapQuoted(payload);
			const payloadValue = unwrapped ?? payload;
			const parts = unwrapped ? [unwrapped] : payload.split(/\s+/).filter(Boolean);
			const mediaStartIndex = media.length;
			let validCount = 0;
			const invalidParts = [];
			let hasValidMedia = false;
			for (const part of parts) {
				const candidate = normalizeMediaSource(cleanCandidate(part));
				if (isValidMedia(candidate, unwrapped ? { allowSpaces: true } : void 0)) {
					media.push(candidate);
					hasValidMedia = true;
					foundMediaToken = true;
					validCount += 1;
				} else invalidParts.push(part);
			}
			const trimmedPayload = payloadValue.trim();
			const looksLikeLocalPath = isLikelyLocalPath(trimmedPayload) || trimmedPayload.startsWith("file://");
			if (!unwrapped && validCount === 1 && invalidParts.length > 0 && /\s/.test(payloadValue) && looksLikeLocalPath) {
				const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
				if (isValidMedia(fallback, { allowSpaces: true })) {
					media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
					hasValidMedia = true;
					foundMediaToken = true;
					validCount = 1;
					invalidParts.length = 0;
				}
			}
			if (!hasValidMedia) {
				const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
				if (isValidMedia(fallback, {
					allowSpaces: true,
					allowBareFilename: true
				})) {
					media.push(fallback);
					hasValidMedia = true;
					foundMediaToken = true;
					invalidParts.length = 0;
				}
			}
			if (hasValidMedia) {
				if (invalidParts.length > 0) pieces.push(invalidParts.join(" "));
			} else if (looksLikeLocalPath) foundMediaToken = true;
			else pieces.push(match[0]);
			cursor = start + match[0].length;
		}
		pieces.push(line.slice(cursor));
		const cleanedLine = pieces.join("").replace(/[ \t]{2,}/g, " ").trim();
		if (cleanedLine) keptLines.push(cleanedLine);
		lineOffset += line.length + 1;
	}
	let cleanedText = keptLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
	const audioTagResult = parseAudioTag(cleanedText);
	const hasAudioAsVoice = audioTagResult.audioAsVoice;
	if (audioTagResult.hadTag) cleanedText = audioTagResult.text.replace(/\n{2,}/g, "\n").trim();
	if (media.length === 0) {
		const result = { text: foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw };
		if (hasAudioAsVoice) result.audioAsVoice = true;
		return result;
	}
	return {
		text: cleanedText,
		mediaUrls: media,
		mediaUrl: media[0],
		...hasAudioAsVoice ? { audioAsVoice: true } : {}
	};
}

//#endregion
//#region src/auto-reply/reply/reply-directives.ts
function parseReplyDirectives(raw, options = {}) {
	const split = splitMediaFromOutput(raw);
	let text = split.text ?? "";
	const replyParsed = parseInlineDirectives(text, {
		currentMessageId: options.currentMessageId,
		stripAudioTag: false,
		stripReplyTags: true
	});
	if (replyParsed.hasReplyTag) text = replyParsed.text;
	const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
	const isSilent = isSilentReplyText(text, silentToken);
	if (isSilent) text = "";
	return {
		text,
		mediaUrls: split.mediaUrls,
		mediaUrl: split.mediaUrl,
		replyToId: replyParsed.replyToId,
		replyToCurrent: replyParsed.replyToCurrent,
		replyToTag: replyParsed.hasReplyTag,
		audioAsVoice: split.audioAsVoice,
		isSilent
	};
}

//#endregion
//#region src/infra/outbound/payloads.ts
function mergeMediaUrls(...lists) {
	const seen = /* @__PURE__ */ new Set();
	const merged = [];
	for (const list of lists) {
		if (!list) continue;
		for (const entry of list) {
			const trimmed = entry?.trim();
			if (!trimmed) continue;
			if (seen.has(trimmed)) continue;
			seen.add(trimmed);
			merged.push(trimmed);
		}
	}
	return merged;
}
function normalizeReplyPayloadsForDelivery(payloads) {
	return payloads.flatMap((payload) => {
		if (shouldSuppressReasoningPayload(payload)) return [];
		const parsed = parseReplyDirectives(payload.text ?? "");
		const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
		const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
		const mergedMedia = mergeMediaUrls(explicitMediaUrls, explicitMediaUrl ? [explicitMediaUrl] : void 0);
		const resolvedMediaUrl = (explicitMediaUrls?.length ?? 0) > 1 ? void 0 : explicitMediaUrl;
		const next = {
			...payload,
			text: parsed.text ?? "",
			mediaUrls: mergedMedia.length ? mergedMedia : void 0,
			mediaUrl: resolvedMediaUrl,
			replyToId: payload.replyToId ?? parsed.replyToId,
			replyToTag: payload.replyToTag || parsed.replyToTag,
			replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
			audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice)
		};
		if (parsed.isSilent && mergedMedia.length === 0) return [];
		if (!isRenderablePayload(next)) return [];
		return [next];
	});
}
function normalizeOutboundPayloads(payloads) {
	return normalizeReplyPayloadsForDelivery(payloads).map((payload) => {
		const channelData = payload.channelData;
		const normalized = {
			text: payload.text ?? "",
			mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : [])
		};
		if (channelData && Object.keys(channelData).length > 0) normalized.channelData = channelData;
		return normalized;
	}).filter((payload) => payload.text || payload.mediaUrls.length > 0 || Boolean(payload.channelData && Object.keys(payload.channelData).length > 0));
}
function normalizeOutboundPayloadsForJson(payloads) {
	return normalizeReplyPayloadsForDelivery(payloads).map((payload) => ({
		text: payload.text ?? "",
		mediaUrl: payload.mediaUrl ?? null,
		mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : void 0),
		channelData: payload.channelData
	}));
}
function formatOutboundPayloadLog(payload) {
	const lines = [];
	if (payload.text) lines.push(payload.text.trimEnd());
	for (const url of payload.mediaUrls) lines.push(`MEDIA:${url}`);
	return lines.join("\n");
}

//#endregion
//#region src/infra/outbound/deliver.ts
var deliver_exports = /* @__PURE__ */ __exportAll({ deliverOutboundPayloads: () => deliverOutboundPayloads });
const log = createSubsystemLogger("outbound/deliver");
const TELEGRAM_TEXT_LIMIT = 4096;
async function createChannelHandler(params) {
	const outbound = await loadChannelOutboundAdapter(params.channel);
	const handler = createPluginHandler({
		...params,
		outbound
	});
	if (!handler) throw new Error(`Outbound not configured for channel: ${params.channel}`);
	return handler;
}
function createPluginHandler(params) {
	const outbound = params.outbound;
	if (!outbound?.sendText || !outbound?.sendMedia) return null;
	const baseCtx = createChannelOutboundContextBase(params);
	const sendText = outbound.sendText;
	const sendMedia = outbound.sendMedia;
	const chunker = outbound.chunker ?? null;
	const chunkerMode = outbound.chunkerMode;
	const resolveCtx = (overrides) => ({
		...baseCtx,
		replyToId: overrides?.replyToId ?? baseCtx.replyToId,
		threadId: overrides?.threadId ?? baseCtx.threadId
	});
	return {
		chunker,
		chunkerMode,
		textChunkLimit: outbound.textChunkLimit,
		sendPayload: outbound.sendPayload ? async (payload, overrides) => outbound.sendPayload({
			...resolveCtx(overrides),
			text: payload.text ?? "",
			mediaUrl: payload.mediaUrl,
			payload
		}) : void 0,
		sendText: async (text, overrides) => sendText({
			...resolveCtx(overrides),
			text
		}),
		sendMedia: async (caption, mediaUrl, overrides) => sendMedia({
			...resolveCtx(overrides),
			text: caption,
			mediaUrl
		})
	};
}
function createChannelOutboundContextBase(params) {
	return {
		cfg: params.cfg,
		to: params.to,
		accountId: params.accountId,
		replyToId: params.replyToId,
		threadId: params.threadId,
		identity: params.identity,
		gifPlayback: params.gifPlayback,
		deps: params.deps,
		silent: params.silent,
		mediaLocalRoots: params.mediaLocalRoots
	};
}
const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
async function deliverOutboundPayloads(params) {
	const { channel, to, payloads } = params;
	const queueId = params.skipQueue ? null : await enqueueDelivery({
		channel,
		to,
		accountId: params.accountId,
		payloads,
		threadId: params.threadId,
		replyToId: params.replyToId,
		bestEffort: params.bestEffort,
		gifPlayback: params.gifPlayback,
		silent: params.silent,
		mirror: params.mirror
	}).catch(() => null);
	let hadPartialFailure = false;
	const wrappedParams = params.onError ? {
		...params,
		onError: (err, payload) => {
			hadPartialFailure = true;
			params.onError(err, payload);
		}
	} : params;
	try {
		const results = await deliverOutboundPayloadsCore(wrappedParams);
		if (queueId) if (hadPartialFailure) await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
		else await ackDelivery(queueId).catch(() => {});
		return results;
	} catch (err) {
		if (queueId) if (isAbortError(err)) await ackDelivery(queueId).catch(() => {});
		else await failDelivery(queueId, err instanceof Error ? err.message : String(err)).catch(() => {});
		throw err;
	}
}
/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(params) {
	const { cfg, channel, to, payloads } = params;
	const accountId = params.accountId;
	const deps = params.deps;
	const abortSignal = params.abortSignal;
	const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, params.session?.agentId ?? params.mirror?.agentId);
	const results = [];
	const handler = await createChannelHandler({
		cfg,
		channel,
		to,
		deps,
		accountId,
		replyToId: params.replyToId,
		threadId: params.threadId,
		identity: params.identity,
		gifPlayback: params.gifPlayback,
		silent: params.silent,
		mediaLocalRoots
	});
	const configuredTextLimit = handler.chunker ? resolveTextChunkLimit(cfg, channel, accountId, { fallbackLimit: handler.textChunkLimit }) : void 0;
	const textLimit = channel === "telegram" && typeof configuredTextLimit === "number" ? Math.min(configuredTextLimit, TELEGRAM_TEXT_LIMIT) : configuredTextLimit;
	const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
	const isSignalChannel = channel === "signal";
	const signalTableMode = isSignalChannel ? resolveMarkdownTableMode({
		cfg,
		channel: "signal",
		accountId
	}) : "code";
	const signalMaxBytes = isSignalChannel ? resolveChannelMediaMaxBytes({
		cfg,
		resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
		accountId
	}) : void 0;
	const sendTextChunks = async (text, overrides) => {
		throwIfAborted(abortSignal);
		if (!handler.chunker || textLimit === void 0) {
			results.push(await handler.sendText(text, overrides));
			return;
		}
		if (chunkMode === "newline") {
			const blockChunks = (handler.chunkerMode ?? "text") === "markdown" ? chunkMarkdownTextWithMode(text, textLimit, "newline") : chunkByParagraph(text, textLimit);
			if (!blockChunks.length && text) blockChunks.push(text);
			for (const blockChunk of blockChunks) {
				const chunks = handler.chunker(blockChunk, textLimit);
				if (!chunks.length && blockChunk) chunks.push(blockChunk);
				for (const chunk of chunks) {
					throwIfAborted(abortSignal);
					results.push(await handler.sendText(chunk, overrides));
				}
			}
			return;
		}
		const chunks = handler.chunker(text, textLimit);
		for (const chunk of chunks) {
			throwIfAborted(abortSignal);
			results.push(await handler.sendText(chunk, overrides));
		}
	};
	const sendSignalText = async (text, styles) => {
		throwIfAborted(abortSignal);
		return {
			channel: "signal",
			...await sendSignal(to, text, {
				maxBytes: signalMaxBytes,
				accountId: accountId ?? void 0,
				textMode: "plain",
				textStyles: styles
			})
		};
	};
	const sendSignalTextChunks = async (text) => {
		throwIfAborted(abortSignal);
		let signalChunks = textLimit === void 0 ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, { tableMode: signalTableMode }) : markdownToSignalTextChunks(text, textLimit, { tableMode: signalTableMode });
		if (signalChunks.length === 0 && text) signalChunks = [{
			text,
			styles: []
		}];
		for (const chunk of signalChunks) {
			throwIfAborted(abortSignal);
			results.push(await sendSignalText(chunk.text, chunk.styles));
		}
	};
	const sendSignalMedia = async (caption, mediaUrl) => {
		throwIfAborted(abortSignal);
		const formatted = markdownToSignalTextChunks(caption, Number.POSITIVE_INFINITY, { tableMode: signalTableMode })[0] ?? {
			text: caption,
			styles: []
		};
		return {
			channel: "signal",
			...await sendSignal(to, formatted.text, {
				mediaUrl,
				maxBytes: signalMaxBytes,
				accountId: accountId ?? void 0,
				textMode: "plain",
				textStyles: formatted.styles,
				mediaLocalRoots
			})
		};
	};
	const normalizeWhatsAppPayload = (payload) => {
		const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
		const normalizedText = (typeof payload.text === "string" ? payload.text : "").replace(/^(?:[ \t]*\r?\n)+/, "");
		if (!normalizedText.trim()) {
			if (!hasMedia) return null;
			return {
				...payload,
				text: ""
			};
		}
		return {
			...payload,
			text: normalizedText
		};
	};
	const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads).flatMap((payload) => {
		if (channel !== "whatsapp") return [payload];
		const normalized = normalizeWhatsAppPayload(payload);
		return normalized ? [normalized] : [];
	});
	const hookRunner = getGlobalHookRunner();
	const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
	if (hookRunner?.hasHooks("message_sent") && params.session?.agentId && !sessionKeyForInternalHooks) log.warn("deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped", {
		channel,
		to,
		agentId: params.session.agentId
	});
	for (const payload of normalizedPayloads) {
		const payloadSummary = {
			text: payload.text ?? "",
			mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
			channelData: payload.channelData
		};
		const emitMessageSent = (params) => {
			if (hookRunner?.hasHooks("message_sent")) hookRunner.runMessageSent({
				to,
				content: params.content,
				success: params.success,
				...params.error ? { error: params.error } : {}
			}, {
				channelId: channel,
				accountId: accountId ?? void 0,
				conversationId: to
			}).catch(() => {});
			if (!sessionKeyForInternalHooks) return;
			triggerInternalHook(createInternalHookEvent("message", "sent", sessionKeyForInternalHooks, {
				to,
				content: params.content,
				success: params.success,
				...params.error ? { error: params.error } : {},
				channelId: channel,
				accountId: accountId ?? void 0,
				conversationId: to,
				messageId: params.messageId
			})).catch(() => {});
		};
		try {
			throwIfAborted(abortSignal);
			let effectivePayload = payload;
			if (hookRunner?.hasHooks("message_sending")) try {
				const sendingResult = await hookRunner.runMessageSending({
					to,
					content: payloadSummary.text,
					metadata: {
						channel,
						accountId,
						mediaUrls: payloadSummary.mediaUrls
					}
				}, {
					channelId: channel,
					accountId: accountId ?? void 0
				});
				if (sendingResult?.cancel) continue;
				if (sendingResult?.content != null) {
					effectivePayload = {
						...payload,
						text: sendingResult.content
					};
					payloadSummary.text = sendingResult.content;
				}
			} catch {}
			params.onPayload?.(payloadSummary);
			const sendOverrides = {
				replyToId: effectivePayload.replyToId ?? params.replyToId ?? void 0,
				threadId: params.threadId ?? void 0
			};
			if (handler.sendPayload && effectivePayload.channelData) {
				const delivery = await handler.sendPayload(effectivePayload, sendOverrides);
				results.push(delivery);
				emitMessageSent({
					success: true,
					content: payloadSummary.text,
					messageId: delivery.messageId
				});
				continue;
			}
			if (payloadSummary.mediaUrls.length === 0) {
				const beforeCount = results.length;
				if (isSignalChannel) await sendSignalTextChunks(payloadSummary.text);
				else await sendTextChunks(payloadSummary.text, sendOverrides);
				const messageId = results.at(-1)?.messageId;
				emitMessageSent({
					success: results.length > beforeCount,
					content: payloadSummary.text,
					messageId
				});
				continue;
			}
			let first = true;
			let lastMessageId;
			for (const url of payloadSummary.mediaUrls) {
				throwIfAborted(abortSignal);
				const caption = first ? payloadSummary.text : "";
				first = false;
				if (isSignalChannel) {
					const delivery = await sendSignalMedia(caption, url);
					results.push(delivery);
					lastMessageId = delivery.messageId;
				} else {
					const delivery = await handler.sendMedia(caption, url, sendOverrides);
					results.push(delivery);
					lastMessageId = delivery.messageId;
				}
			}
			emitMessageSent({
				success: true,
				content: payloadSummary.text,
				messageId: lastMessageId
			});
		} catch (err) {
			emitMessageSent({
				success: false,
				content: payloadSummary.text,
				error: err instanceof Error ? err.message : String(err)
			});
			if (!params.bestEffort) throw err;
			params.onError?.(err, payloadSummary);
		}
	}
	if (params.mirror && results.length > 0) {
		const mirrorText = resolveMirroredTranscriptText({
			text: params.mirror.text,
			mediaUrls: params.mirror.mediaUrls
		});
		if (mirrorText) await appendAssistantMessageToSessionTranscript({
			agentId: params.mirror.agentId,
			sessionKey: params.mirror.sessionKey,
			text: mirrorText
		});
	}
	return results;
}

//#endregion
export { initializeGlobalHookRunner as C, getGlobalHookRunner as S, createReplyToModeFilterForChannel as _, normalizeOutboundPayloadsForJson as a, normalizeChannelTargetInput as b, splitMediaFromOutput as c, applyReplyThreading as d, filterMessagingToolDuplicates as f, shouldSuppressReasoningPayload as g, shouldSuppressMessagingToolReplies as h, normalizeOutboundPayloads as i, throwIfAborted as l, isRenderablePayload as m, deliver_exports as n, normalizeReplyPayloadsForDelivery as o, filterMessagingToolMediaDuplicates as p, formatOutboundPayloadLog as r, parseReplyDirectives as s, deliverOutboundPayloads as t, applyReplyTagsToPayload as u, resolveReplyToMode as v, resolveChannelMediaMaxBytes as w, normalizeTargetForProvider as x, buildTargetResolverSignature as y };