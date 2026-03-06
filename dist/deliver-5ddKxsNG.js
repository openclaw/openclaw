import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { o as logVerbose } from "./globals-DBA9iEt5.js";
import { t as createSubsystemLogger } from "./subsystem-B6NrUFrh.js";
import { _ as normalizeAccountId, v as normalizeOptionalAccountId } from "./session-key-D_MAPrS9.js";
import { E as triggerInternalHook, f as getActivePluginRegistryVersion, u as getActivePluginRegistry, w as createInternalHookEvent } from "./registry-DBb6KIXY.js";
import { t as getChannelDock } from "./dock-D67Q8hqq.js";
import { r as normalizeChannelId, t as getChannelPlugin } from "./plugins-CVNXMV8f.js";
import { F as parseInlineDirectives, i as resolveMirroredTranscriptText, r as appendAssistantMessageToSessionTranscript } from "./sessions-DICryTKD.js";
import { i as isMessagingToolDuplicate } from "./pi-embedded-helpers-4c583e5O.js";
import { t as getAgentScopedMediaLocalRoots } from "./local-roots-BGOsLcJv.js";
import { i as isSilentReplyText, n as SILENT_REPLY_TOKEN } from "./tokens-4Dj4pceq.js";
import { r as parseTelegramTarget } from "./targets-CBX3SUVD.js";
import { d as chunkMarkdownTextWithMode, h as resolveTextChunkLimit, l as chunkByParagraph, m as resolveChunkMode, s as resolveMarkdownTableMode, v as parseFenceSpans } from "./ir-uwbSpW7L.js";
import { c as markdownToSignalTextChunks, t as sendMessageSignal } from "./send-B7BgbN_b.js";
import { i as failDelivery, r as enqueueDelivery, t as ackDelivery } from "./delivery-queue-y-ZMXS4i.js";

//#region src/shared/text/join-segments.ts
function concatOptionalTextSegments(params) {
	const separator = params.separator ?? "\n\n";
	if (params.left && params.right) return `${params.left}${separator}${params.right}`;
	return params.right ?? params.left;
}
function joinPresentTextSegments(segments, options) {
	const separator = options?.separator ?? "\n\n";
	const trim = options?.trim ?? false;
	const values = [];
	for (const segment of segments) {
		if (typeof segment !== "string") continue;
		const normalized = trim ? segment.trim() : segment;
		if (!normalized) continue;
		values.push(normalized);
	}
	return values.length > 0 ? values.join(separator) : void 0;
}

//#endregion
//#region src/plugins/hooks.ts
/**
* Plugin Hook Runner
*
* Provides utilities for executing plugin lifecycle hooks with proper
* error handling, priority ordering, and async support.
*/
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
		prependContext: concatOptionalTextSegments({
			left: acc?.prependContext,
			right: next.prependContext
		}),
		prependSystemContext: concatOptionalTextSegments({
			left: acc?.prependSystemContext,
			right: next.prependSystemContext
		}),
		appendSystemContext: concatOptionalTextSegments({
			left: acc?.appendSystemContext,
			right: next.appendSystemContext
		})
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
async function runGlobalGatewayStopSafely(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("gateway_stop")) return;
	try {
		await hookRunner.runGatewayStop(params.event, params.ctx);
	} catch (err) {
		if (params.onError) {
			params.onError(err);
			return;
		}
		log$1.warn(`gateway_stop hook failed: ${String(err)}`);
	}
}

//#endregion
//#region src/infra/outbound/target-normalization.ts
function normalizeChannelTargetInput(raw) {
	return raw.trim();
}
const targetNormalizerCacheByChannelId = /* @__PURE__ */ new Map();
function resolveTargetNormalizer(channelId) {
	const version = getActivePluginRegistryVersion();
	const cached = targetNormalizerCacheByChannelId.get(channelId);
	if (cached?.version === version) return cached.normalizer;
	const normalizer = getChannelPlugin(channelId)?.messaging?.normalizeTarget;
	targetNormalizerCacheByChannelId.set(channelId, {
		version,
		normalizer
	});
	return normalizer;
}
function normalizeTargetForProvider(provider, raw) {
	if (!raw) return;
	const fallback = raw.trim() || void 0;
	if (!fallback) return;
	const providerId = normalizeChannelId(provider);
	return ((providerId ? resolveTargetNormalizer(providerId) : void 0)?.(raw) ?? fallback) || void 0;
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
const PROVIDER_ALIAS_MAP = { lark: "feishu" };
function normalizeProviderForComparison(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	const lowered = trimmed.toLowerCase();
	const normalizedChannel = normalizeChannelId(trimmed);
	if (normalizedChannel) return normalizedChannel;
	return PROVIDER_ALIAS_MAP[lowered] ?? lowered;
}
function normalizeThreadIdForComparison(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	if (/^-?\d+$/.test(trimmed)) return String(Number.parseInt(trimmed, 10));
	return trimmed.toLowerCase();
}
function resolveTargetProviderForComparison(params) {
	const targetProvider = normalizeProviderForComparison(params.targetProvider);
	if (!targetProvider || targetProvider === "message") return params.currentProvider;
	return targetProvider;
}
function targetsMatchForSuppression(params) {
	if (params.provider !== "telegram") return params.targetKey === params.originTarget;
	const origin = parseTelegramTarget(params.originTarget);
	const target = parseTelegramTarget(params.targetKey);
	const targetThreadId = normalizeThreadIdForComparison(params.targetThreadId) ?? (target.messageThreadId != null ? String(target.messageThreadId) : void 0);
	const originThreadId = origin.messageThreadId != null ? String(origin.messageThreadId) : void 0;
	if (origin.chatId.trim().toLowerCase() !== target.chatId.trim().toLowerCase()) return false;
	if (originThreadId && targetThreadId != null) return originThreadId === targetThreadId;
	if (originThreadId && targetThreadId == null) return false;
	if (!originThreadId && targetThreadId != null) return false;
	return true;
}
function shouldSuppressMessagingToolReplies(params) {
	const provider = normalizeProviderForComparison(params.messageProvider);
	if (!provider) return false;
	const originTarget = normalizeTargetForProvider(provider, params.originatingTo);
	if (!originTarget) return false;
	const originAccount = normalizeOptionalAccountId(params.accountId);
	const sentTargets = params.messagingToolSentTargets ?? [];
	if (sentTargets.length === 0) return false;
	return sentTargets.some((target) => {
		const targetProvider = resolveTargetProviderForComparison({
			currentProvider: provider,
			targetProvider: target?.provider
		});
		if (targetProvider !== provider) return false;
		const targetKey = normalizeTargetForProvider(targetProvider, target.to);
		if (!targetKey) return false;
		const targetAccount = normalizeOptionalAccountId(target.accountId);
		if (originAccount && targetAccount && originAccount !== targetAccount) return false;
		return targetsMatchForSuppression({
			provider,
			originTarget,
			targetKey,
			targetThreadId: target.threadId
		});
	});
}

//#endregion
//#region src/hooks/fire-and-forget.ts
function fireAndForgetHook(task, label, logger = logVerbose) {
	task.catch((err) => {
		logger(`${label}: ${String(err)}`);
	});
}

//#endregion
//#region src/hooks/message-hook-mappers.ts
function deriveInboundMessageHookContext(ctx, overrides) {
	const content = overrides?.content ?? (typeof ctx.BodyForCommands === "string" ? ctx.BodyForCommands : typeof ctx.RawBody === "string" ? ctx.RawBody : typeof ctx.Body === "string" ? ctx.Body : "");
	const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
	const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? void 0;
	const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
	return {
		from: ctx.From ?? "",
		to: ctx.To,
		content,
		body: ctx.Body,
		bodyForAgent: ctx.BodyForAgent,
		transcript: ctx.Transcript,
		timestamp: typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : void 0,
		channelId,
		accountId: ctx.AccountId,
		conversationId,
		messageId: overrides?.messageId ?? ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast,
		senderId: ctx.SenderId,
		senderName: ctx.SenderName,
		senderUsername: ctx.SenderUsername,
		senderE164: ctx.SenderE164,
		provider: ctx.Provider,
		surface: ctx.Surface,
		threadId: ctx.MessageThreadId,
		mediaPath: ctx.MediaPath,
		mediaType: ctx.MediaType,
		originatingChannel: ctx.OriginatingChannel,
		originatingTo: ctx.OriginatingTo,
		guildId: ctx.GroupSpace,
		channelName: ctx.GroupChannel,
		isGroup,
		groupId: isGroup ? conversationId : void 0
	};
}
function buildCanonicalSentMessageHookContext(params) {
	return {
		to: params.to,
		content: params.content,
		success: params.success,
		error: params.error,
		channelId: params.channelId,
		accountId: params.accountId,
		conversationId: params.conversationId ?? params.to,
		messageId: params.messageId,
		isGroup: params.isGroup,
		groupId: params.groupId
	};
}
function toPluginMessageContext(canonical) {
	return {
		channelId: canonical.channelId,
		accountId: canonical.accountId,
		conversationId: canonical.conversationId
	};
}
function toPluginMessageReceivedEvent(canonical) {
	return {
		from: canonical.from,
		content: canonical.content,
		timestamp: canonical.timestamp,
		metadata: {
			to: canonical.to,
			provider: canonical.provider,
			surface: canonical.surface,
			threadId: canonical.threadId,
			originatingChannel: canonical.originatingChannel,
			originatingTo: canonical.originatingTo,
			messageId: canonical.messageId,
			senderId: canonical.senderId,
			senderName: canonical.senderName,
			senderUsername: canonical.senderUsername,
			senderE164: canonical.senderE164,
			guildId: canonical.guildId,
			channelName: canonical.channelName
		}
	};
}
function toPluginMessageSentEvent(canonical) {
	return {
		to: canonical.to,
		content: canonical.content,
		success: canonical.success,
		...canonical.error ? { error: canonical.error } : {}
	};
}
function toInternalMessageReceivedContext(canonical) {
	return {
		from: canonical.from,
		content: canonical.content,
		timestamp: canonical.timestamp,
		channelId: canonical.channelId,
		accountId: canonical.accountId,
		conversationId: canonical.conversationId,
		messageId: canonical.messageId,
		metadata: {
			to: canonical.to,
			provider: canonical.provider,
			surface: canonical.surface,
			threadId: canonical.threadId,
			senderId: canonical.senderId,
			senderName: canonical.senderName,
			senderUsername: canonical.senderUsername,
			senderE164: canonical.senderE164,
			guildId: canonical.guildId,
			channelName: canonical.channelName
		}
	};
}
function toInternalMessageTranscribedContext(canonical, cfg) {
	return {
		from: canonical.from,
		to: canonical.to,
		body: canonical.body,
		bodyForAgent: canonical.bodyForAgent,
		transcript: canonical.transcript ?? "",
		timestamp: canonical.timestamp,
		channelId: canonical.channelId,
		conversationId: canonical.conversationId,
		messageId: canonical.messageId,
		senderId: canonical.senderId,
		senderName: canonical.senderName,
		senderUsername: canonical.senderUsername,
		provider: canonical.provider,
		surface: canonical.surface,
		mediaPath: canonical.mediaPath,
		mediaType: canonical.mediaType,
		cfg
	};
}
function toInternalMessagePreprocessedContext(canonical, cfg) {
	return {
		from: canonical.from,
		to: canonical.to,
		body: canonical.body,
		bodyForAgent: canonical.bodyForAgent,
		transcript: canonical.transcript,
		timestamp: canonical.timestamp,
		channelId: canonical.channelId,
		conversationId: canonical.conversationId,
		messageId: canonical.messageId,
		senderId: canonical.senderId,
		senderName: canonical.senderName,
		senderUsername: canonical.senderUsername,
		provider: canonical.provider,
		surface: canonical.surface,
		mediaPath: canonical.mediaPath,
		mediaType: canonical.mediaType,
		isGroup: canonical.isGroup,
		groupId: canonical.groupId,
		cfg
	};
}
function toInternalMessageSentContext(canonical) {
	return {
		to: canonical.to,
		content: canonical.content,
		success: canonical.success,
		...canonical.error ? { error: canonical.error } : {},
		channelId: canonical.channelId,
		accountId: canonical.accountId,
		conversationId: canonical.conversationId,
		messageId: canonical.messageId,
		...canonical.isGroup != null ? { isGroup: canonical.isGroup } : {},
		...canonical.groupId ? { groupId: canonical.groupId } : {}
	};
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
function mayContainFenceMarkers(input) {
	return input.includes("```") || input.includes("~~~");
}
function isInsideFence(fenceSpans, offset) {
	return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}
function splitMediaFromOutput(raw) {
	const trimmedRaw = raw.trimEnd();
	if (!trimmedRaw.trim()) return { text: "" };
	const mayContainMediaToken = /media:/i.test(trimmedRaw);
	const mayContainAudioTag = trimmedRaw.includes("[[");
	if (!mayContainMediaToken && !mayContainAudioTag) return { text: trimmedRaw };
	const media = [];
	let foundMediaToken = false;
	const hasFenceMarkers = mayContainFenceMarkers(trimmedRaw);
	const fenceSpans = hasFenceMarkers ? parseFenceSpans(trimmedRaw) : [];
	const lines = trimmedRaw.split("\n");
	const keptLines = [];
	let lineOffset = 0;
	for (const line of lines) {
		if (hasFenceMarkers && isInsideFence(fenceSpans, lineOffset)) {
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
	const normalized = [];
	for (const payload of payloads) {
		if (shouldSuppressReasoningPayload(payload)) continue;
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
		if (parsed.isSilent && mergedMedia.length === 0) continue;
		if (!isRenderablePayload(next)) continue;
		normalized.push(next);
	}
	return normalized;
}
function normalizeOutboundPayloads(payloads) {
	const normalizedPayloads = [];
	for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
		const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const channelData = payload.channelData;
		const hasChannelData = Boolean(channelData && Object.keys(channelData).length > 0);
		const text = payload.text ?? "";
		if (!text && mediaUrls.length === 0 && !hasChannelData) continue;
		normalizedPayloads.push({
			text,
			mediaUrls,
			...hasChannelData ? { channelData } : {}
		});
	}
	return normalizedPayloads;
}
function normalizeOutboundPayloadsForJson(payloads) {
	const normalized = [];
	for (const payload of normalizeReplyPayloadsForDelivery(payloads)) normalized.push({
		text: payload.text ?? "",
		mediaUrl: payload.mediaUrl ?? null,
		mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : void 0),
		channelData: payload.channelData
	});
	return normalized;
}
function formatOutboundPayloadLog(payload) {
	const lines = [];
	if (payload.text) lines.push(payload.text.trimEnd());
	for (const url of payload.mediaUrls) lines.push(`MEDIA:${url}`);
	return lines.join("\n");
}

//#endregion
//#region src/infra/outbound/sanitize-text.ts
/**
* Sanitize model output for plain-text messaging surfaces.
*
* LLMs occasionally produce HTML tags (`<br>`, `<b>`, `<i>`, etc.) that render
* correctly on web but appear as literal text on WhatsApp, Signal, SMS, and IRC.
*
* Converts common inline HTML to lightweight-markup equivalents used by
* WhatsApp/Signal/Telegram and strips any remaining tags.
*
* @see https://github.com/openclaw/openclaw/issues/31884
* @see https://github.com/openclaw/openclaw/issues/18558
*/
/** Channels where HTML tags should be converted/stripped. */
const PLAIN_TEXT_SURFACES = new Set([
	"whatsapp",
	"signal",
	"sms",
	"irc",
	"telegram",
	"imessage",
	"googlechat"
]);
/** Returns `true` when the channel cannot render raw HTML. */
function isPlainTextSurface(channelId) {
	return PLAIN_TEXT_SURFACES.has(channelId.toLowerCase());
}
/**
* Convert common HTML tags to their plain-text/lightweight-markup equivalents
* and strip anything that remains.
*
* The function is intentionally conservative — it only targets tags that models
* are known to produce and avoids false positives on angle brackets in normal
* prose (e.g. `a < b`).
*/
function sanitizeForPlainText(text) {
	return text.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div)>/gi, "\n").replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*").replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_").replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~").replace(/<code>(.*?)<\/code>/gi, "`$1`").replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n").replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n").replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "").replace(/\n{3,}/g, "\n\n");
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
	if (!outbound?.sendText) return null;
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
		supportsMedia: Boolean(sendMedia),
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
		sendMedia: async (caption, mediaUrl, overrides) => {
			if (sendMedia) return sendMedia({
				...resolveCtx(overrides),
				text: caption,
				mediaUrl
			});
			return sendText({
				...resolveCtx(overrides),
				text: caption
			});
		}
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
function hasMediaPayload(payload) {
	return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}
function hasChannelDataPayload(payload) {
	return Boolean(payload.channelData && Object.keys(payload.channelData).length > 0);
}
function normalizePayloadForChannelDelivery(payload, channelId) {
	const hasMedia = hasMediaPayload(payload);
	const hasChannelData = hasChannelDataPayload(payload);
	const rawText = typeof payload.text === "string" ? payload.text : "";
	const normalizedText = channelId === "whatsapp" ? rawText.replace(/^(?:[ \t]*\r?\n)+/, "") : rawText;
	if (!normalizedText.trim()) {
		if (!hasMedia && !hasChannelData) return null;
		return {
			...payload,
			text: ""
		};
	}
	if (normalizedText === rawText) return payload;
	return {
		...payload,
		text: normalizedText
	};
}
function normalizePayloadsForChannelDelivery(payloads, channel) {
	const normalizedPayloads = [];
	for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
		let sanitizedPayload = payload;
		if (isPlainTextSurface(channel) && payload.text) {
			if (!(channel === "telegram" && payload.channelData)) sanitizedPayload = {
				...payload,
				text: sanitizeForPlainText(payload.text)
			};
		}
		const normalized = normalizePayloadForChannelDelivery(sanitizedPayload, channel);
		if (normalized) normalizedPayloads.push(normalized);
	}
	return normalizedPayloads;
}
function buildPayloadSummary(payload) {
	return {
		text: payload.text ?? "",
		mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
		channelData: payload.channelData
	};
}
function createMessageSentEmitter(params) {
	const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
	const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
	const emitMessageSent = (event) => {
		if (!hasMessageSentHooks && !canEmitInternalHook) return;
		const canonical = buildCanonicalSentMessageHookContext({
			to: params.to,
			content: event.content,
			success: event.success,
			error: event.error,
			channelId: params.channel,
			accountId: params.accountId ?? void 0,
			conversationId: params.to,
			messageId: event.messageId,
			isGroup: params.mirrorIsGroup,
			groupId: params.mirrorGroupId
		});
		if (hasMessageSentHooks) fireAndForgetHook(params.hookRunner.runMessageSent(toPluginMessageSentEvent(canonical), toPluginMessageContext(canonical)), "deliverOutboundPayloads: message_sent plugin hook failed", (message) => {
			log.warn(message);
		});
		if (!canEmitInternalHook) return;
		fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "sent", params.sessionKeyForInternalHooks, toInternalMessageSentContext(canonical))), "deliverOutboundPayloads: message:sent internal hook failed", (message) => {
			log.warn(message);
		});
	};
	return {
		emitMessageSent,
		hasMessageSentHooks
	};
}
async function applyMessageSendingHook(params) {
	if (!params.enabled) return {
		cancelled: false,
		payload: params.payload,
		payloadSummary: params.payloadSummary
	};
	try {
		const sendingResult = await params.hookRunner.runMessageSending({
			to: params.to,
			content: params.payloadSummary.text,
			metadata: {
				channel: params.channel,
				accountId: params.accountId,
				mediaUrls: params.payloadSummary.mediaUrls
			}
		}, {
			channelId: params.channel,
			accountId: params.accountId ?? void 0
		});
		if (sendingResult?.cancel) return {
			cancelled: true,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		if (sendingResult?.content == null) return {
			cancelled: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		return {
			cancelled: false,
			payload: {
				...params.payload,
				text: sendingResult.content
			},
			payloadSummary: {
				...params.payloadSummary,
				text: sendingResult.content
			}
		};
	} catch {
		return {
			cancelled: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
	}
}
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
				cfg,
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
				cfg,
				mediaUrl,
				maxBytes: signalMaxBytes,
				accountId: accountId ?? void 0,
				textMode: "plain",
				textStyles: formatted.styles,
				mediaLocalRoots
			})
		};
	};
	const normalizedPayloads = normalizePayloadsForChannelDelivery(payloads, channel);
	const hookRunner = getGlobalHookRunner();
	const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
	const mirrorIsGroup = params.mirror?.isGroup;
	const mirrorGroupId = params.mirror?.groupId;
	const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
		hookRunner,
		channel,
		to,
		accountId,
		sessionKeyForInternalHooks,
		mirrorIsGroup,
		mirrorGroupId
	});
	const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
	if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) log.warn("deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped", {
		channel,
		to,
		agentId: params.session.agentId
	});
	for (const payload of normalizedPayloads) {
		let payloadSummary = buildPayloadSummary(payload);
		try {
			throwIfAborted(abortSignal);
			const hookResult = await applyMessageSendingHook({
				hookRunner,
				enabled: hasMessageSendingHooks,
				payload,
				payloadSummary,
				to,
				channel,
				accountId
			});
			if (hookResult.cancelled) continue;
			const effectivePayload = hookResult.payload;
			payloadSummary = hookResult.payloadSummary;
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
			if (!handler.supportsMedia) {
				log.warn("Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used", {
					channel,
					to,
					mediaCount: payloadSummary.mediaUrls.length
				});
				const fallbackText = payloadSummary.text.trim();
				if (!fallbackText) throw new Error("Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload");
				const beforeCount = results.length;
				await sendTextChunks(fallbackText, sendOverrides);
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
export { initializeGlobalHookRunner as A, shouldSuppressReasoningPayload as C, normalizeChannelTargetInput as D, buildTargetResolverSignature as E, joinPresentTextSegments as M, normalizeTargetForProvider as O, shouldSuppressMessagingToolReplies as S, resolveReplyToMode as T, applyReplyTagsToPayload as _, normalizeOutboundPayloadsForJson as a, filterMessagingToolMediaDuplicates as b, parseReplyDirectives as c, toInternalMessagePreprocessedContext as d, toInternalMessageReceivedContext as f, fireAndForgetHook as g, toPluginMessageReceivedEvent as h, normalizeOutboundPayloads as i, runGlobalGatewayStopSafely as j, getGlobalHookRunner as k, splitMediaFromOutput as l, toPluginMessageContext as m, deliver_exports as n, normalizeReplyPayloadsForDelivery as o, toInternalMessageTranscribedContext as p, formatOutboundPayloadLog as r, throwIfAborted as s, deliverOutboundPayloads as t, deriveInboundMessageHookContext as u, applyReplyThreading as v, createReplyToModeFilterForChannel as w, isRenderablePayload as x, filterMessagingToolDuplicates as y };