import { sanitizeProviderReplayHistoryWithPlugin, validateProviderReplayTurnsWithPlugin, } from "../../plugins/provider-runtime.js";
import { hasInterSessionUserProvenance, normalizeInputProvenance, } from "../../sessions/input-provenance.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { downgradeOpenAIFunctionCallReasoningPairs, downgradeOpenAIReasoningBlocks, sanitizeGoogleTurnOrdering, sanitizeSessionMessagesImages, validateAnthropicTurns, validateGeminiTurns, } from "../pi-embedded-helpers.js";
import { sanitizeToolCallInputs, sanitizeToolUseResultPairing, stripToolResultDetails, } from "../session-transcript-repair.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../stream-message-shared.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { resolveTranscriptPolicy, shouldAllowProviderOwnedThinkingReplay, } from "../transcript-policy.js";
import { makeZeroUsageSnapshot, normalizeUsage, } from "../usage.js";
import { dropThinkingBlocks, stripInvalidThinkingSignatures } from "./thinking.js";
const INTER_SESSION_PREFIX_BASE = "[Inter-session message]";
const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
function createProviderReplayPluginParams(params) {
    const context = {
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        model: params.model,
        sessionId: params.sessionId,
    };
    return {
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        context,
    };
}
function buildInterSessionPrefix(message) {
    const provenance = normalizeInputProvenance(message.provenance);
    if (!provenance) {
        return INTER_SESSION_PREFIX_BASE;
    }
    const details = [
        provenance.sourceSessionKey ? `sourceSession=${provenance.sourceSessionKey}` : undefined,
        provenance.sourceChannel ? `sourceChannel=${provenance.sourceChannel}` : undefined,
        provenance.sourceTool ? `sourceTool=${provenance.sourceTool}` : undefined,
    ].filter(Boolean);
    if (details.length === 0) {
        return INTER_SESSION_PREFIX_BASE;
    }
    return `${INTER_SESSION_PREFIX_BASE} ${details.join(" ")}`;
}
function annotateInterSessionUserMessages(messages) {
    let touched = false;
    const out = [];
    for (const msg of messages) {
        if (!hasInterSessionUserProvenance(msg)) {
            out.push(msg);
            continue;
        }
        const prefix = buildInterSessionPrefix(msg);
        const user = msg;
        if (typeof user.content === "string") {
            if (user.content.startsWith(prefix)) {
                out.push(msg);
                continue;
            }
            touched = true;
            out.push({
                ...msg,
                content: `${prefix}\n${user.content}`,
            });
            continue;
        }
        if (!Array.isArray(user.content)) {
            out.push(msg);
            continue;
        }
        const textIndex = user.content.findIndex((block) => block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string");
        if (textIndex >= 0) {
            const existing = user.content[textIndex];
            if (existing.text.startsWith(prefix)) {
                out.push(msg);
                continue;
            }
            const nextContent = [...user.content];
            nextContent[textIndex] = {
                ...existing,
                text: `${prefix}\n${existing.text}`,
            };
            touched = true;
            out.push({
                ...msg,
                content: nextContent,
            });
            continue;
        }
        touched = true;
        out.push({
            ...msg,
            content: [{ type: "text", text: prefix }, ...user.content],
        });
    }
    return touched ? out : messages;
}
function parseMessageTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}
function stripStaleAssistantUsageBeforeLatestCompaction(messages) {
    let latestCompactionSummaryIndex = -1;
    let latestCompactionTimestamp = null;
    for (let i = 0; i < messages.length; i += 1) {
        const entry = messages[i];
        if (entry?.role !== "compactionSummary") {
            continue;
        }
        latestCompactionSummaryIndex = i;
        latestCompactionTimestamp = parseMessageTimestamp(entry.timestamp ?? null);
    }
    if (latestCompactionSummaryIndex === -1) {
        return messages;
    }
    const out = [...messages];
    let touched = false;
    for (let i = 0; i < out.length; i += 1) {
        const candidate = out[i];
        if (!candidate || candidate.role !== "assistant") {
            continue;
        }
        if (!candidate.usage || typeof candidate.usage !== "object") {
            continue;
        }
        const messageTimestamp = parseMessageTimestamp(candidate.timestamp);
        const staleByTimestamp = latestCompactionTimestamp !== null &&
            messageTimestamp !== null &&
            messageTimestamp <= latestCompactionTimestamp;
        const staleByLegacyOrdering = i < latestCompactionSummaryIndex;
        if (!staleByTimestamp && !staleByLegacyOrdering) {
            continue;
        }
        // pi-coding-agent expects assistant usage to always be present during context
        // accounting. Keep stale snapshots structurally valid, but zeroed out.
        const candidateRecord = candidate;
        out[i] = {
            ...candidateRecord,
            usage: makeZeroUsageSnapshot(),
        };
        touched = true;
    }
    return touched ? out : messages;
}
// `provider:"openclaw"` assistant entries written by the channel-delivery
// transcript mirror (`model:"delivery-mirror"`, see config/sessions/transcript.ts)
// and by the Gateway transcript-inject helper (`model:"gateway-injected"`, see
// gateway/server-methods/chat-transcript-inject.ts) are user-visible transcript
// records, not model output. Replaying them to the actual provider duplicates
// content and, on Bedrock or strict OpenAI-compatible providers, can also
// trigger turn-ordering rejections.
const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
function isTranscriptOnlyOpenclawAssistant(message) {
    if (!message || message.role !== "assistant") {
        return false;
    }
    const provider = message.provider;
    const model = message.model;
    return (provider === "openclaw" &&
        typeof model === "string" &&
        TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model));
}
export function normalizeAssistantReplayContent(messages) {
    let touched = false;
    const out = [];
    for (const message of messages) {
        if (!message || message.role !== "assistant") {
            out.push(message);
            continue;
        }
        if (isTranscriptOnlyOpenclawAssistant(message)) {
            // Drop from the in-memory replay copy; the persisted JSONL keeps the
            // entry so user-facing transcript surfaces are unchanged.
            touched = true;
            continue;
        }
        const replayContent = message.content;
        if (typeof replayContent === "string") {
            out.push({
                ...message,
                content: [{ type: "text", text: replayContent }],
            });
            touched = true;
            continue;
        }
        if (Array.isArray(replayContent) && replayContent.length === 0) {
            // An assistant turn can legitimately end with `content: []` — for
            // example the silent-reply / NO_REPLY path locked in by
            // run.empty-error-retry.test.ts ("Clean stop with no output is a
            // legitimate silent reply, not a crash"). We must NOT inject the
            // failure sentinel into those turns: doing so would fabricate a
            // failure statement in the next provider request and change model
            // behavior even when no failure occurred.
            //
            // Only `stopReason: "error"` turns are the Bedrock-Converse replay
            // poison this fix is scoped to: the provider rejects assistant
            // messages with no ContentBlock, and the persisted error turn was
            // never going to render anything useful to the model anyway. Leaving
            // non-error empty-content turns untouched preserves silent-reply
            // semantics on every other code path.
            const stopReason = message.stopReason;
            if (stopReason === "error") {
                out.push({
                    ...message,
                    content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
                });
                touched = true;
                continue;
            }
        }
        out.push(message);
    }
    return touched ? out : messages;
}
function normalizeAssistantUsageSnapshot(usage) {
    const normalized = normalizeUsage((usage ?? undefined));
    if (!normalized) {
        return makeZeroUsageSnapshot();
    }
    const input = normalized.input ?? 0;
    const output = normalized.output ?? 0;
    const cacheRead = normalized.cacheRead ?? 0;
    const cacheWrite = normalized.cacheWrite ?? 0;
    const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
    const cost = normalizeAssistantUsageCost(usage);
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        ...(cost ? { cost } : {}),
    };
}
function normalizeAssistantUsageCost(usage) {
    const base = makeZeroUsageSnapshot().cost;
    if (!usage || typeof usage !== "object") {
        return undefined;
    }
    const rawCost = usage.cost;
    if (!rawCost || typeof rawCost !== "object") {
        return undefined;
    }
    const cost = rawCost;
    const inputRaw = toFiniteCostNumber(cost.input);
    const outputRaw = toFiniteCostNumber(cost.output);
    const cacheReadRaw = toFiniteCostNumber(cost.cacheRead);
    const cacheWriteRaw = toFiniteCostNumber(cost.cacheWrite);
    const totalRaw = toFiniteCostNumber(cost.total);
    if (inputRaw === undefined &&
        outputRaw === undefined &&
        cacheReadRaw === undefined &&
        cacheWriteRaw === undefined &&
        totalRaw === undefined) {
        return undefined;
    }
    const input = inputRaw ?? base.input;
    const output = outputRaw ?? base.output;
    const cacheRead = cacheReadRaw ?? base.cacheRead;
    const cacheWrite = cacheWriteRaw ?? base.cacheWrite;
    const total = totalRaw ?? input + output + cacheRead + cacheWrite;
    return { input, output, cacheRead, cacheWrite, total };
}
function toFiniteCostNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function ensureAssistantUsageSnapshots(messages) {
    if (messages.length === 0) {
        return messages;
    }
    let touched = false;
    const out = [...messages];
    for (let i = 0; i < out.length; i += 1) {
        const message = out[i];
        if (!message || message.role !== "assistant") {
            continue;
        }
        const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
        const usageCost = message.usage && typeof message.usage === "object"
            ? message.usage.cost
            : undefined;
        const normalizedCost = normalizedUsage.cost;
        if (message.usage &&
            typeof message.usage === "object" &&
            message.usage.input === normalizedUsage.input &&
            message.usage.output === normalizedUsage.output &&
            message.usage.cacheRead === normalizedUsage.cacheRead &&
            message.usage.cacheWrite === normalizedUsage.cacheWrite &&
            message.usage.totalTokens === normalizedUsage.totalTokens &&
            ((normalizedCost &&
                usageCost &&
                typeof usageCost === "object" &&
                usageCost.input === normalizedCost.input &&
                usageCost.output === normalizedCost.output &&
                usageCost.cacheRead === normalizedCost.cacheRead &&
                usageCost.cacheWrite === normalizedCost.cacheWrite &&
                usageCost.total === normalizedCost.total) ||
                (!normalizedCost && usageCost === undefined))) {
            continue;
        }
        out[i] = {
            ...message,
            usage: normalizedUsage,
        };
        touched = true;
    }
    return touched ? out : messages;
}
function createProviderReplaySessionState(sessionManager) {
    return {
        getCustomEntries() {
            try {
                const customEntries = [];
                for (const entry of sessionManager.getEntries()) {
                    const candidate = entry;
                    if (candidate?.type !== "custom" || typeof candidate.customType !== "string") {
                        continue;
                    }
                    const customType = candidate.customType.trim();
                    if (!customType) {
                        continue;
                    }
                    customEntries.push({
                        customType,
                        data: candidate.data,
                    });
                }
                return customEntries;
            }
            catch {
                return [];
            }
        },
        appendCustomEntry(customType, data) {
            try {
                sessionManager.appendCustomEntry(customType, data);
            }
            catch {
                // ignore persistence failures
            }
        },
    };
}
function readLastModelSnapshot(sessionManager) {
    try {
        const entries = sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
                continue;
            }
            const data = entry?.data;
            if (data && typeof data === "object") {
                return data;
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
function appendModelSnapshot(sessionManager, data) {
    try {
        sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
    }
    catch {
        // ignore persistence failures
    }
}
function isSameModelSnapshot(a, b) {
    const normalize = (value) => value ?? "";
    return (normalize(a.provider) === normalize(b.provider) &&
        normalize(a.modelApi) === normalize(b.modelApi) &&
        normalize(a.modelId) === normalize(b.modelId));
}
/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run.
 */
export async function sanitizeSessionHistory(params) {
    // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
    const policy = params.policy ??
        resolveTranscriptPolicy({
            modelApi: params.modelApi,
            provider: params.provider,
            modelId: params.modelId,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            model: params.model,
        });
    const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
        modelApi: params.modelApi,
        policy,
    });
    const isOpenAIResponsesApi = params.modelApi === "openai-responses" ||
        params.modelApi === "openai-codex-responses" ||
        params.modelApi === "azure-openai-responses";
    const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
    const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
    const modelChanged = priorSnapshot
        ? !isSameModelSnapshot(priorSnapshot, {
            timestamp: 0,
            provider: params.provider,
            modelApi: params.modelApi,
            modelId: params.modelId,
        })
        : false;
    const normalizedAssistantReplay = normalizeAssistantReplayContent(withInterSessionMarkers);
    const sanitizedImages = await sanitizeSessionMessagesImages(normalizedAssistantReplay, "session:history", {
        sanitizeMode: policy.sanitizeMode,
        sanitizeToolCallIds: policy.sanitizeToolCallIds && !allowProviderOwnedThinkingReplay && !isOpenAIResponsesApi,
        toolCallIdMode: policy.toolCallIdMode,
        preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
        preserveSignatures: policy.preserveSignatures,
        sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
        ...resolveImageSanitizationLimits(params.config),
    });
    const validatedThinkingSignatures = policy.preserveSignatures
        ? stripInvalidThinkingSignatures(sanitizedImages)
        : sanitizedImages;
    const droppedThinking = policy.dropThinkingBlocks
        ? dropThinkingBlocks(validatedThinkingSignatures)
        : validatedThinkingSignatures;
    const sanitizedToolCalls = sanitizeToolCallInputs(droppedThinking, {
        allowedToolNames: params.allowedToolNames,
        allowProviderOwnedThinkingReplay,
    });
    // OpenAI Responses rejects orphan/missing function_call_output items. Upstream
    // Codex repairs those gaps with "aborted"; keep that before the fc_* downgrade
    // so both call and result ids are rewritten together. Covered by unit replay
    // tests plus live OpenAI/Codex and generic replay-repair model tests.
    const openAIRepairedToolCalls = isOpenAIResponsesApi && policy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairing(sanitizedToolCalls, {
            erroredAssistantResultPolicy: "drop",
            // Match upstream Codex history normalization for OpenAI Responses:
            // missing function_call_output entries are model-visible "aborted".
            missingToolResultText: "aborted",
        })
        : sanitizedToolCalls;
    const openAISafeToolCalls = isOpenAIResponsesApi
        ? downgradeOpenAIFunctionCallReasoningPairs(downgradeOpenAIReasoningBlocks(openAIRepairedToolCalls, {
            dropReplayableReasoning: modelChanged,
        }))
        : sanitizedToolCalls;
    const sanitizedToolIds = policy.sanitizeToolCallIds && policy.toolCallIdMode
        ? sanitizeToolCallIdsForCloudCodeAssist(openAISafeToolCalls, policy.toolCallIdMode, {
            preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
            preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
            allowedToolNames: params.allowedToolNames,
        })
        : openAISafeToolCalls;
    // Gemini/Anthropic-class providers also require tool results to stay adjacent
    // to their assistant tool calls. They do not use Codex's "aborted" text, but
    // the same ordering repair is live-tested with Gemini 3 Flash.
    const repairedTools = !isOpenAIResponsesApi && policy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairing(sanitizedToolIds, {
            erroredAssistantResultPolicy: "drop",
        })
        : sanitizedToolIds;
    const sanitizedToolResults = stripToolResultDetails(repairedTools);
    const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(stripStaleAssistantUsageBeforeLatestCompaction(sanitizedToolResults));
    const provider = params.provider?.trim();
    let providerSanitized;
    if (provider && provider.length > 0) {
        const pluginParams = createProviderReplayPluginParams({ ...params, provider });
        const providerResult = await sanitizeProviderReplayHistoryWithPlugin({
            ...pluginParams,
            context: {
                ...pluginParams.context,
                sessionId: params.sessionId ?? "",
                messages: sanitizedCompactionUsage,
                allowedToolNames: params.allowedToolNames,
                sessionState: createProviderReplaySessionState(params.sessionManager),
            },
        });
        providerSanitized = providerResult ?? undefined;
    }
    const sanitizedWithProvider = providerSanitized ?? sanitizedCompactionUsage;
    if (hasSnapshot && (!priorSnapshot || modelChanged)) {
        appendModelSnapshot(params.sessionManager, {
            timestamp: Date.now(),
            provider: params.provider,
            modelApi: params.modelApi,
            modelId: params.modelId,
        });
    }
    if (!policy.applyGoogleTurnOrdering) {
        return sanitizedWithProvider;
    }
    // Strict OpenAI-compatible providers (vLLM, Gemma, etc.) also reject
    // conversations that start with an assistant turn (e.g. delivery-mirror
    // messages after /new). Provider hooks may already have applied a
    // provider-owned ordering rewrite above; keep this generic fallback for the
    // strict OpenAI-compatible path and for any provider that leaves assistant-
    // first repair to core. See #38962.
    return sanitizeGoogleTurnOrdering(sanitizedWithProvider);
}
/**
 * Runs provider-owned replay validation before falling back to the remaining
 * generic validator pipeline.
 */
export async function validateReplayTurns(params) {
    const policy = params.policy ??
        resolveTranscriptPolicy({
            modelApi: params.modelApi,
            provider: params.provider,
            modelId: params.modelId,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            model: params.model,
        });
    const provider = params.provider?.trim();
    if (provider) {
        const pluginParams = createProviderReplayPluginParams({ ...params, provider });
        const providerValidated = await validateProviderReplayTurnsWithPlugin({
            ...pluginParams,
            context: {
                ...pluginParams.context,
                messages: params.messages,
            },
        });
        if (providerValidated) {
            return providerValidated;
        }
    }
    const validatedGemini = policy.validateGeminiTurns
        ? validateGeminiTurns(params.messages)
        : params.messages;
    return policy.validateAnthropicTurns ? validateAnthropicTurns(validatedGemini) : validatedGemini;
}
