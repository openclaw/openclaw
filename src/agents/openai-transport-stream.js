import { randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream, getEnvApiKey, parseStreamingJson, } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import OpenAI, { AzureOpenAI } from "openai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveProviderTransportTurnStateWithPlugin } from "../plugins/provider-runtime.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { flattenCompletionMessagesToStringContent } from "./openai-completions-string-content.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import { normalizeOpenAIReasoningEffort, resolveOpenAIReasoningEffortForModel, } from "./openai-reasoning-effort.js";
import { applyOpenAIResponsesPayloadPolicy, resolveOpenAIResponsesPayloadPolicy, } from "./openai-responses-payload-policy.js";
import { findOpenAIStrictToolSchemaDiagnostics, normalizeOpenAIStrictToolParameters, resolveOpenAIStrictToolFlagForInventory, resolveOpenAIStrictToolSetting, } from "./openai-tool-schema.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import { mergeTransportMetadata, sanitizeTransportPayloadText } from "./transport-stream-shared.js";
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";
const log = createSubsystemLogger("openai-transport");
export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";
function stringifyUnknown(value, fallback = "") {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return fallback;
}
function stringifyJsonLike(value, fallback = "") {
    if (typeof value === "string") {
        return value;
    }
    if (value && typeof value === "object") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return fallback;
}
function getServiceTierCostMultiplier(serviceTier) {
    switch (serviceTier) {
        case "flex":
            return 0.5;
        case "priority":
            return 2;
        default:
            return 1;
    }
}
function applyServiceTierPricing(usage, serviceTier) {
    const multiplier = getServiceTierCostMultiplier(serviceTier);
    if (multiplier === 1) {
        return;
    }
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total =
        usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
export function resolveAzureOpenAIApiVersion(env = process.env) {
    return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}
function shortHash(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}
function encodeTextSignatureV1(id, phase) {
    return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}
function parseTextSignature(signature) {
    if (!signature) {
        return undefined;
    }
    if (signature.startsWith("{")) {
        try {
            const parsed = JSON.parse(signature);
            if (parsed.v === 1 && typeof parsed.id === "string") {
                return parsed.phase === "commentary" || parsed.phase === "final_answer"
                    ? { id: parsed.id, phase: parsed.phase }
                    : { id: parsed.id };
            }
        }
        catch {
            // Keep legacy plain-string behavior below.
        }
    }
    return { id: signature };
}
function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
    const messages = [];
    const normalizeIdPart = (part) => {
        const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
        const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
        return normalized.replace(/_+$/, "");
    };
    const buildForeignResponsesItemId = (itemId) => {
        const normalized = `fc_${shortHash(itemId)}`;
        return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
    };
    const normalizeToolCallId = (id, _targetModel, source) => {
        if (!allowedToolCallProviders.has(model.provider)) {
            return normalizeIdPart(id);
        }
        if (!id.includes("|")) {
            return normalizeIdPart(id);
        }
        const [callId, itemId] = id.split("|");
        const normalizedCallId = normalizeIdPart(callId);
        const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
        let normalizedItemId = isForeignToolCall
            ? buildForeignResponsesItemId(itemId)
            : normalizeIdPart(itemId);
        if (!normalizedItemId.startsWith("fc_")) {
            normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
        }
        return `${normalizedCallId}|${normalizedItemId}`;
    };
    const transformedMessages = transformTransportMessages(context.messages, model, normalizeToolCallId);
    const includeSystemPrompt = options?.includeSystemPrompt ?? true;
    if (includeSystemPrompt && context.systemPrompt) {
        messages.push({
            role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
            content: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        });
    }
    let msgIndex = 0;
    for (const msg of transformedMessages) {
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                messages.push({
                    role: "user",
                    content: [{ type: "input_text", text: sanitizeTransportPayloadText(msg.content) }],
                });
            }
            else {
                const content = msg.content.map((item) => item.type === "text"
                    ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
                    : {
                        type: "input_image",
                        detail: "auto",
                        image_url: `data:${item.mimeType};base64,${item.data}`,
                    }).filter((item) => model.input.includes("image") || item.type !== "input_image");
                if (content.length > 0) {
                    messages.push({ role: "user", content });
                }
            }
        }
        else if (msg.role === "assistant") {
            const output = [];
            const isDifferentModel = msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
            for (const block of msg.content) {
                if (block.type === "thinking") {
                    if (block.thinkingSignature) {
                        output.push(JSON.parse(block.thinkingSignature));
                    }
                }
                else if (block.type === "text") {
                    let msgId = parseTextSignature(block.textSignature)?.id ?? `msg_${msgIndex}`;
                    if (msgId.length > 64) {
                        msgId = `msg_${shortHash(msgId)}`;
                    }
                    output.push({
                        type: "message",
                        role: "assistant",
                        content: [
                            {
                                type: "output_text",
                                text: sanitizeTransportPayloadText(block.text),
                                annotations: [],
                            },
                        ],
                        status: "completed",
                        id: msgId,
                        phase: parseTextSignature(block.textSignature)?.phase,
                    });
                }
                else if (block.type === "toolCall") {
                    const [callId, itemIdRaw] = block.id.split("|");
                    const itemId = isDifferentModel && itemIdRaw?.startsWith("fc_") ? undefined : itemIdRaw;
                    output.push({
                        type: "function_call",
                        id: itemId,
                        call_id: callId,
                        name: block.name,
                        arguments: typeof block.arguments === "string"
                            ? block.arguments
                            : JSON.stringify(block.arguments ?? {}),
                    });
                }
            }
            if (output.length > 0) {
                messages.push(...output);
            }
        }
        else if (msg.role === "toolResult") {
            const textResult = msg.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
            const hasImages = msg.content.some((item) => item.type === "image");
            const [callId] = msg.toolCallId.split("|");
            messages.push({
                type: "function_call_output",
                call_id: callId,
                output: hasImages && model.input.includes("image")
                    ? [
                        ...(textResult
                            ? [{ type: "input_text", text: sanitizeTransportPayloadText(textResult) }]
                            : []),
                        ...msg.content
                            .filter((item) => item.type === "image")
                            .map((item) => ({
                            type: "input_image",
                            detail: "auto",
                            image_url: `data:${item.mimeType};base64,${item.data}`,
                        })),
                    ]
                    : sanitizeTransportPayloadText(textResult || "(see attached image)"),
            });
        }
        msgIndex += 1;
    }
    return messages;
}
function convertResponsesTools(tools, model, options) {
    const strict = resolveOpenAIStrictToolFlagWithDiagnostics(tools, options?.strict, {
        transport: "responses",
        model,
    });
    return tools.map((tool) => {
        const base = {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
        };
        return strict === undefined ? base : { ...base, strict };
    });
}
function resolveOpenAIStrictToolFlagWithDiagnostics(tools, strictSetting, context) {
    const strict = resolveOpenAIStrictToolFlagForInventory(tools, strictSetting);
    if (strictSetting === true && strict === false && log.isEnabled("debug", "any")) {
        const diagnostics = findOpenAIStrictToolSchemaDiagnostics(tools);
        const sample = diagnostics.slice(0, 5).map((entry) => ({
            tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
            violations: entry.violations.slice(0, 8),
        }));
        log.debug(`OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ` +
            `${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} ` +
            `because ${diagnostics.length} tool schema(s) are not strict-compatible`, {
            transport: context.transport,
            provider: context.model.provider,
            model: context.model.id,
            incompatibleToolCount: diagnostics.length,
            sample,
        });
    }
    return strict;
}
async function processResponsesStream(openaiStream, output, stream, model, options) {
    let currentItem = null;
    let currentBlock = null;
    const blockIndex = () => output.content.length - 1;
    for await (const rawEvent of openaiStream) {
        const event = rawEvent;
        const type = stringifyUnknown(event.type);
        if (type === "response.created") {
            output.responseId = stringifyUnknown(event.response?.id);
        }
        else if (type === "response.output_item.added") {
            const item = event.item;
            if (item.type === "reasoning") {
                currentItem = item;
                currentBlock = { type: "thinking", thinking: "" };
                output.content.push(currentBlock);
                stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
            }
            else if (item.type === "message") {
                currentItem = item;
                currentBlock = { type: "text", text: "" };
                output.content.push(currentBlock);
                stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
            }
            else if (item.type === "function_call") {
                currentItem = item;
                currentBlock = {
                    type: "toolCall",
                    id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
                    name: stringifyUnknown(item.name),
                    arguments: {},
                    partialJson: stringifyJsonLike(item.arguments),
                };
                output.content.push(currentBlock);
                stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
            }
        }
        else if (type === "response.reasoning_summary_text.delta") {
            if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
                currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
                stream.push({
                    type: "thinking_delta",
                    contentIndex: blockIndex(),
                    delta: stringifyUnknown(event.delta),
                    partial: output,
                });
            }
        }
        else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
            if (currentItem?.type === "message" && currentBlock?.type === "text") {
                currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
                stream.push({
                    type: "text_delta",
                    contentIndex: blockIndex(),
                    delta: stringifyUnknown(event.delta),
                    partial: output,
                });
            }
        }
        else if (type === "response.function_call_arguments.delta") {
            if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
                currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
                currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
                stream.push({
                    type: "toolcall_delta",
                    contentIndex: blockIndex(),
                    delta: stringifyJsonLike(event.delta),
                    partial: output,
                });
            }
        }
        else if (type === "response.output_item.done") {
            const item = event.item;
            if (item.type === "reasoning" && currentBlock?.type === "thinking") {
                const summary = Array.isArray(item.summary)
                    ? item.summary
                        .map((part) => {
                        const summaryPart = part;
                        return summaryPart.text ?? "";
                    })
                        .join("\n\n")
                    : "";
                currentBlock.thinking = summary;
                currentBlock.thinkingSignature = JSON.stringify(item);
                stream.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: stringifyUnknown(currentBlock.thinking),
                    partial: output,
                });
                currentBlock = null;
            }
            else if (item.type === "message" && currentBlock?.type === "text") {
                const content = Array.isArray(item.content) ? item.content : [];
                currentBlock.text = content
                    .map((part) => {
                    const contentPart = part;
                    return contentPart.type === "output_text"
                        ? (contentPart.text ?? "")
                        : (contentPart.refusal ?? "");
                })
                    .join("");
                currentBlock.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), item.phase ?? undefined);
                stream.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: stringifyUnknown(currentBlock.text),
                    partial: output,
                });
                currentBlock = null;
            }
            else if (item.type === "function_call") {
                const args = currentBlock?.type === "toolCall" && currentBlock.partialJson
                    ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}"))
                    : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
                stream.push({
                    type: "toolcall_end",
                    contentIndex: blockIndex(),
                    toolCall: {
                        type: "toolCall",
                        id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
                        name: stringifyUnknown(item.name),
                        arguments: args,
                    },
                    partial: output,
                });
                currentBlock = null;
            }
        }
        else if (type === "response.completed") {
            const response = event.response;
            if (typeof response?.id === "string") {
                output.responseId = response.id;
            }
            const usage = response?.usage;
            if (usage) {
                const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                output.usage = {
                    input: (usage.input_tokens || 0) - cachedTokens,
                    output: usage.output_tokens || 0,
                    cacheRead: cachedTokens,
                    cacheWrite: 0,
                    totalTokens: usage.total_tokens || 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                };
            }
            calculateCost(model, output.usage);
            if (options?.applyServiceTierPricing) {
                options.applyServiceTierPricing(output.usage, response?.service_tier ??
                    options.serviceTier);
            }
            output.stopReason = mapResponsesStopReason(response?.status);
            if (output.content.some((block) => block.type === "toolCall") &&
                output.stopReason === "stop") {
                output.stopReason = "toolUse";
            }
        }
        else if (type === "error") {
            throw new Error(`Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`);
        }
        else if (type === "response.failed") {
            const response = event.response;
            const msg = response?.error
                ? `${response.error.code || "unknown"}: ${response.error.message || "no message"}`
                : response?.incomplete_details?.reason
                    ? `incomplete: ${response.incomplete_details.reason}`
                    : "Unknown error (no error details in response)";
            throw new Error(msg);
        }
    }
}
function mapResponsesStopReason(status) {
    if (!status) {
        return "stop";
    }
    switch (status) {
        case "completed":
            return "stop";
        case "incomplete":
            return "length";
        case "failed":
        case "cancelled":
            return "error";
        case "in_progress":
        case "queued":
            return "stop";
        default:
            throw new Error(`Unhandled stop reason: ${status}`);
    }
}
function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders) {
    const headers = { ...model.headers };
    if (model.provider === "github-copilot") {
        Object.assign(headers, buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages: hasCopilotVisionInput(context.messages),
        }));
    }
    if (optionHeaders) {
        Object.assign(headers, optionHeaders);
    }
    if (turnHeaders) {
        Object.assign(headers, turnHeaders);
    }
    return headers;
}
function resolveProviderTransportTurnState(model, params) {
    return resolveProviderTransportTurnStateWithPlugin({
        provider: model.provider,
        context: {
            provider: model.provider,
            modelId: model.id,
            model: model,
            sessionId: params.sessionId,
            turnId: params.turnId,
            attempt: params.attempt,
            transport: params.transport,
        },
    });
}
function createOpenAIResponsesClient(model, context, apiKey, optionHeaders, turnHeaders) {
    return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
        fetch: buildGuardedModelFetch(model),
    });
}
export function createOpenAIResponsesTransportStreamFn() {
    return (model, context, options) => {
        const eventStream = createAssistantMessageEventStream();
        const stream = eventStream;
        void (async () => {
            const output = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            try {
                const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
                const turnState = resolveProviderTransportTurnState(model, {
                    sessionId: options?.sessionId,
                    turnId: randomUUID(),
                    attempt: 1,
                    transport: "stream",
                });
                const client = createOpenAIResponsesClient(model, context, apiKey, options?.headers, turnState?.headers);
                let params = buildOpenAIResponsesParams(model, context, options, turnState?.metadata);
                const nextParams = await options?.onPayload?.(params, model);
                if (nextParams !== undefined) {
                    params = nextParams;
                }
                params = mergeTransportMetadata(params, turnState?.metadata);
                const responseStream = (await client.responses.create(params, options?.signal ? { signal: options.signal } : undefined));
                stream.push({ type: "start", partial: output });
                await processResponsesStream(responseStream, output, stream, model, {
                    serviceTier: options?.serviceTier,
                    applyServiceTierPricing,
                });
                if (options?.signal?.aborted) {
                    throw new Error("Request was aborted");
                }
                if (output.stopReason === "aborted" || output.stopReason === "error") {
                    throw new Error("An unknown error occurred");
                }
                stream.push({ type: "done", reason: output.stopReason, message: output });
                stream.end();
            }
            catch (error) {
                output.stopReason = options?.signal?.aborted ? "aborted" : "error";
                output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                stream.push({ type: "error", reason: output.stopReason, error: output });
                stream.end();
            }
        })();
        return eventStream;
    };
}
function resolveCacheRetention(cacheRetention) {
    if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
        return cacheRetention;
    }
    if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
        return "long";
    }
    return "short";
}
function getPromptCacheRetention(baseUrl, cacheRetention) {
    if (cacheRetention !== "long") {
        return undefined;
    }
    return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}
function resolveOpenAIReasoningEffort(options) {
    return normalizeOpenAIReasoningEffort(options?.reasoningEffort ?? options?.reasoning ?? "high");
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasResponsesWebSearchTool(tools) {
    if (!Array.isArray(tools)) {
        return false;
    }
    return tools.some((tool) => {
        if (!isRecord(tool)) {
            return false;
        }
        if (tool.type === "web_search") {
            return true;
        }
        if (tool.type === "function" && tool.name === "web_search") {
            return true;
        }
        const fn = tool.function;
        return isRecord(fn) && fn.name === "web_search";
    });
}
function raiseMinimalReasoningForResponsesWebSearch(params) {
    if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) {
        return params.effort;
    }
    for (const effort of ["low", "medium", "high"]) {
        const resolved = resolveOpenAIReasoningEffortForModel({
            model: params.model,
            effort,
        });
        if (resolved && resolved !== "none" && resolved !== "minimal") {
            return resolved;
        }
    }
    return params.effort;
}
function isOpenAICodexResponsesModel(model) {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}
function buildOpenAICodexResponsesInstructions(context) {
    if (!context.systemPrompt) {
        return undefined;
    }
    return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}
export function buildOpenAIResponsesParams(model, context, options, metadata) {
    const isCodexResponses = isOpenAICodexResponsesModel(model);
    const compat = getCompat(model);
    const supportsDeveloperRole = typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
    const messages = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]), { includeSystemPrompt: !isCodexResponses, supportsDeveloperRole });
    const cacheRetention = resolveCacheRetention(options?.cacheRetention);
    const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
        storeMode: "disable",
    });
    const params = {
        model: model.id,
        input: messages,
        stream: true,
        prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
        prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
        ...(isCodexResponses ? { instructions: buildOpenAICodexResponsesInstructions(context) } : {}),
        ...(metadata ? { metadata } : {}),
    };
    if (options?.maxTokens) {
        params.max_output_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
        params.temperature = options.temperature;
    }
    if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
        params.service_tier = options.serviceTier;
    }
    if (context.tools) {
        params.tools = convertResponsesTools(context.tools, model, {
            strict: resolveOpenAIStrictToolSetting(model, {
                transport: "stream",
            }),
        });
    }
    if (model.reasoning) {
        if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
            const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
            const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
                model,
                effort: requestedReasoningEffort,
            });
            const reasoningEffort = resolvedReasoningEffort
                ? raiseMinimalReasoningForResponsesWebSearch({
                    model,
                    effort: resolvedReasoningEffort,
                    tools: params.tools,
                })
                : undefined;
            if (reasoningEffort) {
                params.reasoning = {
                    effort: reasoningEffort,
                    ...(reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }),
                };
                if (reasoningEffort !== "none") {
                    params.include = ["reasoning.encrypted_content"];
                }
            }
        }
        else if (model.provider !== "github-copilot") {
            const reasoningEffort = resolveOpenAIReasoningEffortForModel({
                model,
                effort: "none",
            });
            if (reasoningEffort) {
                params.reasoning = {
                    effort: reasoningEffort,
                };
            }
        }
    }
    applyOpenAIResponsesPayloadPolicy(params, payloadPolicy);
    return params;
}
export function createAzureOpenAIResponsesTransportStreamFn() {
    return (model, context, options) => {
        const eventStream = createAssistantMessageEventStream();
        const stream = eventStream;
        void (async () => {
            const output = {
                role: "assistant",
                content: [],
                api: "azure-openai-responses",
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            try {
                const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
                const turnState = resolveProviderTransportTurnState(model, {
                    sessionId: options?.sessionId,
                    turnId: randomUUID(),
                    attempt: 1,
                    transport: "stream",
                });
                const client = createAzureOpenAIClient(model, context, apiKey, options?.headers, turnState?.headers);
                const deploymentName = resolveAzureDeploymentName(model);
                let params = buildAzureOpenAIResponsesParams(model, context, options, deploymentName, turnState?.metadata);
                const nextParams = await options?.onPayload?.(params, model);
                if (nextParams !== undefined) {
                    params = nextParams;
                }
                params = mergeTransportMetadata(params, turnState?.metadata);
                const responseStream = (await client.responses.create(params, options?.signal ? { signal: options.signal } : undefined));
                stream.push({ type: "start", partial: output });
                await processResponsesStream(responseStream, output, stream, model);
                if (options?.signal?.aborted) {
                    throw new Error("Request was aborted");
                }
                if (output.stopReason === "aborted" || output.stopReason === "error") {
                    throw new Error("An unknown error occurred");
                }
                stream.push({ type: "done", reason: output.stopReason, message: output });
                stream.end();
            }
            catch (error) {
                output.stopReason = options?.signal?.aborted ? "aborted" : "error";
                output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                stream.push({ type: "error", reason: output.stopReason, error: output });
                stream.end();
            }
        })();
        return eventStream;
    };
}
function normalizeAzureBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
}
function resolveAzureDeploymentName(model) {
    const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    if (deploymentMap) {
        for (const entry of deploymentMap.split(",")) {
            const [modelId, deploymentName] = entry.split("=", 2).map((value) => value?.trim());
            if (modelId === model.id && deploymentName) {
                return deploymentName;
            }
        }
    }
    return model.id;
}
function createAzureOpenAIClient(model, context, apiKey, optionHeaders, turnHeaders) {
    return new AzureOpenAI({
        apiKey,
        apiVersion: resolveAzureOpenAIApiVersion(),
        dangerouslyAllowBrowser: true,
        defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
        baseURL: normalizeAzureBaseUrl(model.baseUrl),
        fetch: buildGuardedModelFetch(model),
    });
}
function buildAzureOpenAIResponsesParams(model, context, options, deploymentName, metadata) {
    const params = buildOpenAIResponsesParams(model, context, options, metadata);
    params.model = deploymentName;
    delete params.store;
    return params;
}
function hasToolHistory(messages) {
    return messages.some((message) => message.role === "toolResult" ||
        (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")));
}
function createOpenAICompletionsClient(model, context, apiKey, optionHeaders) {
    const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
    return new OpenAI({
        apiKey,
        baseURL: clientConfig.baseURL,
        dangerouslyAllowBrowser: true,
        defaultHeaders: clientConfig.defaultHeaders,
        defaultQuery: clientConfig.defaultQuery,
        fetch: buildGuardedModelFetch(model),
    });
}
function isAzureOpenAICompatibleHost(hostname) {
    return (hostname.endsWith(".openai.azure.com") ||
        hostname.endsWith(".services.ai.azure.com") ||
        hostname.endsWith(".cognitiveservices.azure.com"));
}
function buildOpenAICompletionsClientConfig(model, context, optionHeaders) {
    const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
    const defaultQuery = {};
    let baseURL = model.baseUrl;
    let isAzureHost = false;
    try {
        const parsed = new URL(model.baseUrl);
        isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
        parsed.searchParams.forEach((value, key) => {
            if (value) {
                defaultQuery[key] = value;
            }
        });
        parsed.search = "";
        baseURL = parsed.toString().replace(/\/$/, "");
    }
    catch {
        // Keep the configured base URL unchanged; the OpenAI SDK will surface invalid URLs.
    }
    if (isAzureHost) {
        const apiVersionHeader = Object.keys(headers).find((key) => key.toLowerCase() === "api-version");
        if (apiVersionHeader) {
            const apiVersion = headers[apiVersionHeader]?.trim();
            delete headers[apiVersionHeader];
            if (apiVersion && !defaultQuery["api-version"]) {
                defaultQuery["api-version"] = apiVersion;
            }
        }
    }
    return {
        baseURL,
        defaultHeaders: headers,
        defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : undefined,
    };
}
export function createOpenAICompletionsTransportStreamFn() {
    return (model, context, options) => {
        const eventStream = createAssistantMessageEventStream();
        const stream = eventStream;
        void (async () => {
            const output = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            try {
                const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
                const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
                let params = buildOpenAICompletionsParams(model, context, options);
                const nextParams = await options?.onPayload?.(params, model);
                if (nextParams !== undefined) {
                    params = nextParams;
                }
                const responseStream = (await client.chat.completions.create(params, {
                    signal: options?.signal,
                }));
                stream.push({ type: "start", partial: output });
                await processOpenAICompletionsStream(responseStream, output, model, stream);
                if (options?.signal?.aborted) {
                    throw new Error("Request was aborted");
                }
                stream.push({ type: "done", reason: output.stopReason, message: output });
                stream.end();
            }
            catch (error) {
                output.stopReason = options?.signal?.aborted ? "aborted" : "error";
                output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                stream.push({ type: "error", reason: output.stopReason, error: output });
                stream.end();
            }
        })();
        return eventStream;
    };
}
async function processOpenAICompletionsStream(responseStream, output, model, stream) {
    const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256_000;
    const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256_000;
    const compat = getCompat(model);
    let currentBlock = null;
    let pendingPostToolCallDeltas = [];
    let pendingPostToolCallBytes = 0;
    let currentToolCallArgumentBytes = 0;
    let isFlushingPendingPostToolCallDeltas = false;
    const blockIndex = () => output.content.length - 1;
    const measureUtf8Bytes = (text) => Buffer.byteLength(text, "utf8");
    const finishCurrentBlock = () => {
        if (!currentBlock) {
            return;
        }
        if (currentBlock.type === "toolCall") {
            currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
            const completed = {
                ...currentBlock,
                arguments: parseStreamingJson(currentBlock.partialArgs),
            };
            output.content[blockIndex()] = completed;
        }
    };
    const queuePostToolCallDelta = (next) => {
        const nextBytes = measureUtf8Bytes(next.text);
        if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) {
            throw new Error("Exceeded post-tool-call delta buffer limit");
        }
        pendingPostToolCallBytes += nextBytes;
        const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
        if (!previous || previous.kind !== next.kind) {
            pendingPostToolCallDeltas.push(next);
            return;
        }
        if (next.kind === "thinking" && previous.kind === "thinking") {
            if (previous.signature !== next.signature) {
                pendingPostToolCallDeltas.push(next);
                return;
            }
            previous.text += next.text;
            return;
        }
        previous.text += next.text;
    };
    const appendThinkingDeltaInternal = (reasoningDelta) => {
        if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock();
            currentBlock = {
                type: "thinking",
                thinking: "",
                thinkingSignature: reasoningDelta.signature,
            };
            output.content.push(currentBlock);
            stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
        }
        currentBlock.thinking += reasoningDelta.text;
        stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: reasoningDelta.text,
            partial: output,
        });
    };
    const appendTextDeltaInternal = (text) => {
        if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock();
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
        currentBlock.text += text;
        stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: text,
            partial: output,
        });
    };
    const flushPendingPostToolCallDeltas = () => {
        if (isFlushingPendingPostToolCallDeltas ||
            currentBlock?.type === "toolCall" ||
            pendingPostToolCallDeltas.length === 0) {
            return;
        }
        isFlushingPendingPostToolCallDeltas = true;
        const bufferedDeltas = pendingPostToolCallDeltas;
        pendingPostToolCallDeltas = [];
        pendingPostToolCallBytes = 0;
        for (const delta of bufferedDeltas) {
            if (delta.kind === "text") {
                appendTextDeltaInternal(delta.text);
            }
            else {
                appendThinkingDeltaInternal(delta);
            }
        }
        isFlushingPendingPostToolCallDeltas = false;
    };
    const appendThinkingDelta = (reasoningDelta) => {
        flushPendingPostToolCallDeltas();
        appendThinkingDeltaInternal(reasoningDelta);
    };
    const appendTextDelta = (text) => {
        flushPendingPostToolCallDeltas();
        appendTextDeltaInternal(text);
    };
    for await (const rawChunk of responseStream) {
        if (!rawChunk || typeof rawChunk !== "object") {
            continue;
        }
        const chunk = rawChunk;
        output.responseId ||= chunk.id;
        if (chunk.usage) {
            output.usage = parseTransportChunkUsage(chunk.usage, model);
        }
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) {
            continue;
        }
        const choiceUsage = choice.usage;
        if (!chunk.usage && choiceUsage) {
            output.usage = parseTransportChunkUsage(choiceUsage, model);
        }
        if (choice.finish_reason) {
            const finishReasonResult = mapStopReason(choice.finish_reason);
            output.stopReason = finishReasonResult.stopReason;
            if (finishReasonResult.errorMessage) {
                output.errorMessage = finishReasonResult.errorMessage;
            }
        }
        if (!choice.delta) {
            continue;
        }
        if (choice.delta.content) {
            if (currentBlock?.type === "toolCall") {
                queuePostToolCallDelta({ kind: "text", text: choice.delta.content });
            }
            else {
                appendTextDelta(choice.delta.content);
            }
            continue;
        }
        const reasoningDeltas = getCompletionsReasoningDeltas(choice.delta, compat.visibleReasoningDetailTypes);
        for (const reasoningDelta of reasoningDeltas) {
            if (currentBlock?.type === "toolCall") {
                queuePostToolCallDelta({ ...reasoningDelta });
                continue;
            }
            if (reasoningDelta.kind === "text") {
                appendTextDelta(reasoningDelta.text);
            }
            else {
                appendThinkingDelta(reasoningDelta);
            }
        }
        if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
            for (const toolCall of choice.delta.tool_calls) {
                if (!currentBlock ||
                    currentBlock.type !== "toolCall" ||
                    (toolCall.id && currentBlock.id !== toolCall.id)) {
                    const switchingToolCall = currentBlock?.type === "toolCall";
                    finishCurrentBlock();
                    if (switchingToolCall) {
                        currentBlock = null;
                        flushPendingPostToolCallDeltas();
                    }
                    const initialSig = extractGoogleThoughtSignature(toolCall);
                    currentBlock = {
                        type: "toolCall",
                        id: toolCall.id || "",
                        name: toolCall.function?.name || "",
                        arguments: {},
                        partialArgs: "",
                        ...(initialSig ? { thoughtSignature: initialSig } : {}),
                    };
                    currentToolCallArgumentBytes = 0;
                    output.content.push(currentBlock);
                    stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
                }
                if (currentBlock.type !== "toolCall") {
                    continue;
                }
                if (toolCall.id) {
                    currentBlock.id = toolCall.id;
                }
                if (toolCall.function?.name) {
                    currentBlock.name = toolCall.function.name;
                }
                const deltaSig = extractGoogleThoughtSignature(toolCall);
                if (deltaSig) {
                    currentBlock.thoughtSignature = deltaSig;
                }
                if (toolCall.function?.arguments) {
                    const nextArgumentBytes = measureUtf8Bytes(toolCall.function.arguments);
                    if (currentToolCallArgumentBytes + nextArgumentBytes >
                        MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES) {
                        throw new Error("Exceeded tool-call argument buffer limit");
                    }
                    currentToolCallArgumentBytes += nextArgumentBytes;
                    currentBlock.partialArgs += toolCall.function.arguments;
                    currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
                    stream.push({
                        type: "toolcall_delta",
                        contentIndex: blockIndex(),
                        delta: toolCall.function.arguments,
                        partial: output,
                    });
                }
            }
        }
        flushPendingPostToolCallDeltas();
    }
    finishCurrentBlock();
    if (currentBlock?.type === "toolCall") {
        currentBlock = null;
    }
    flushPendingPostToolCallDeltas();
    const hasToolCalls = output.content.some((block) => block.type === "toolCall");
    if (output.stopReason === "toolUse" && !hasToolCalls) {
        output.stopReason = "stop";
    }
}
function getCompletionsReasoningDeltas(delta, visibleReasoningDetailTypes) {
    const output = [];
    const pushDelta = (next) => {
        const previous = output[output.length - 1];
        if (!previous || previous.kind !== next.kind) {
            output.push(next);
            return;
        }
        if (next.kind === "thinking" && previous.kind === "thinking") {
            if (previous.signature !== next.signature) {
                output.push(next);
                return;
            }
            previous.text += next.text;
            return;
        }
        previous.text += next.text;
    };
    const reasoningDetails = delta.reasoning_details;
    let usedReasoningThinkingDetails = false;
    if (Array.isArray(reasoningDetails)) {
        const visibleTypes = new Set(visibleReasoningDetailTypes);
        for (const item of reasoningDetails) {
            const detail = item;
            if (typeof detail.text !== "string" || !detail.text) {
                continue;
            }
            if (detail.type === "reasoning.text") {
                usedReasoningThinkingDetails = true;
                pushDelta({ kind: "thinking", signature: "reasoning_details", text: detail.text });
                continue;
            }
            if (typeof detail.type === "string" && visibleTypes.has(detail.type)) {
                pushDelta({ kind: "text", text: detail.text });
            }
        }
    }
    if (!usedReasoningThinkingDetails) {
        const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
        for (const field of reasoningFields) {
            const value = delta[field];
            if (typeof value === "string" && value.length > 0) {
                pushDelta({ kind: "thinking", signature: field, text: value });
                break;
            }
        }
    }
    return output;
}
function detectCompat(model) {
    const provider = model.provider;
    const { capabilities, defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
    const endpointClass = capabilities.endpointClass;
    const isDefaultRoute = endpointClass === "default";
    const isGroq = endpointClass === "groq-native" || (isDefaultRoute && provider === "groq");
    const reasoningEffortMap = isGroq && model.id === "qwen/qwen3-32b"
        ? {
            minimal: "default",
            low: "default",
            medium: "default",
            high: "default",
            xhigh: "default",
        }
        : {};
    return {
        supportsStore: compatDefaults.supportsStore,
        supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
        supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
        reasoningEffortMap,
        supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
        maxTokensField: compatDefaults.maxTokensField,
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        thinkingFormat: compatDefaults.thinkingFormat,
        visibleReasoningDetailTypes: compatDefaults.visibleReasoningDetailTypes,
        openRouterRouting: {},
        vercelGatewayRouting: {},
        supportsStrictMode: compatDefaults.supportsStrictMode,
    };
}
function getCompat(model) {
    const detected = detectCompat(model);
    const compat = model.compat ?? {};
    const supportsStore = typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
    const supportsReasoningEffort = typeof compat.supportsReasoningEffort === "boolean"
        ? compat.supportsReasoningEffort
        : detected.supportsReasoningEffort;
    return {
        supportsStore,
        supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
        supportsReasoningEffort,
        reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, detected.reasoningEffortMap),
        supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
        maxTokensField: compat.maxTokensField ?? detected.maxTokensField,
        requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
        requiresAssistantAfterToolResult: compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
        requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
        thinkingFormat: compat.thinkingFormat ?? detected.thinkingFormat,
        openRouterRouting: compat.openRouterRouting ?? {},
        vercelGatewayRouting: compat.vercelGatewayRouting ??
            detected.vercelGatewayRouting,
        supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
        supportsPromptCacheKey: compat.supportsPromptCacheKey === true,
        requiresStringContent: compat.requiresStringContent ?? false,
        visibleReasoningDetailTypes: compat.visibleReasoningDetailTypes ?? detected.visibleReasoningDetailTypes,
    };
}
function resolveOpenAICompletionsReasoningEffort(options) {
    return options?.reasoningEffort ?? options?.reasoning ?? "high";
}
function convertTools(tools, compat, model) {
    const strict = resolveOpenAIStrictToolFlagWithDiagnostics(tools, resolveOpenAIStrictToolSetting(model, {
        transport: "stream",
        supportsStrictMode: compat?.supportsStrictMode,
    }), {
        transport: "completions",
        model,
    });
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
            ...(strict === undefined ? {} : { strict }),
        },
    }));
}
function extractGoogleThoughtSignature(toolCall) {
    const tc = toolCall;
    if (!tc) {
        return undefined;
    }
    const extra = tc.extra_content?.google;
    const fromExtra = extra?.thought_signature;
    if (typeof fromExtra === "string" && fromExtra.length > 0) {
        return fromExtra;
    }
    const fromFunction = tc.function
        ?.thought_signature;
    return typeof fromFunction === "string" && fromFunction.length > 0 ? fromFunction : undefined;
}
function isGoogleOpenAICompatModel(model) {
    const endpointClass = detectOpenAICompletionsCompat(model)
        .capabilities.endpointClass;
    return (model.provider === "google" ||
        endpointClass === "google-generative-ai" ||
        endpointClass === "google-vertex");
}
function injectToolCallThoughtSignatures(outgoingMessages, context, model) {
    if (!isGoogleOpenAICompatModel(model)) {
        return;
    }
    const sigById = new Map();
    for (const msg of context.messages ?? []) {
        if (msg.role !== "assistant") {
            continue;
        }
        const source = msg;
        if (source.api !== model.api ||
            source.provider !== model.provider ||
            source.model !== model.id) {
            continue;
        }
        if (!Array.isArray(source.content)) {
            continue;
        }
        for (const block of source.content) {
            if (block.type !== "toolCall") {
                continue;
            }
            const id = block.id;
            const sig = block.thoughtSignature;
            if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
                sigById.set(id, sig);
            }
        }
    }
    if (sigById.size === 0) {
        return;
    }
    for (const message of outgoingMessages) {
        const toolCalls = message.tool_calls;
        if (!Array.isArray(toolCalls)) {
            continue;
        }
        for (const toolCall of toolCalls) {
            const id = toolCall.id;
            if (typeof id !== "string") {
                continue;
            }
            const sig = sigById.get(id);
            if (!sig) {
                continue;
            }
            const extra = toolCall.extra_content && typeof toolCall.extra_content === "object"
                ? toolCall.extra_content
                : {};
            toolCall.extra_content = extra;
            const google = extra.google && typeof extra.google === "object"
                ? extra.google
                : {};
            extra.google = google;
            google.thought_signature = sig;
        }
    }
}
export function buildOpenAICompletionsParams(model, context, options) {
    const compat = getCompat(model);
    const compatDetection = detectOpenAICompletionsCompat(model);
    const completionsContext = context.systemPrompt
        ? {
            ...context,
            systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
        }
        : context;
    const messages = convertMessages(model, completionsContext, compat);
    injectToolCallThoughtSignatures(messages, context, model);
    const cacheRetention = resolveCacheRetention(options?.cacheRetention);
    const params = {
        model: model.id,
        messages: compat.requiresStringContent
            ? flattenCompletionMessagesToStringContent(messages)
            : messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (compat.supportsStore) {
        params.store = false;
    }
    if (compat.supportsPromptCacheKey && cacheRetention !== "none" && options?.sessionId) {
        params.prompt_cache_key = options.sessionId;
    }
    if (options?.maxTokens) {
        if (compat.maxTokensField === "max_tokens") {
            params.max_tokens = options.maxTokens;
        }
        else {
            params.max_completion_tokens = options.maxTokens;
        }
    }
    if (options?.temperature !== undefined) {
        params.temperature = options.temperature;
    }
    if (context.tools) {
        params.tools = convertTools(context.tools, compat, model);
        if (options?.toolChoice) {
            params.tool_choice = options.toolChoice;
        }
        else if (compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
            Array.isArray(params.tools) &&
            params.tools.length > 0) {
            params.tool_choice = "auto";
        }
    }
    else if (hasToolHistory(context.messages)) {
        params.tools = [];
    }
    const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
    const resolvedCompletionsReasoningEffort = completionsReasoningEffort
        ? resolveOpenAIReasoningEffortForModel({
            model,
            effort: completionsReasoningEffort,
            fallbackMap: compat.reasoningEffortMap,
        })
        : undefined;
    if (compat.thinkingFormat === "openrouter" &&
        model.reasoning &&
        resolvedCompletionsReasoningEffort) {
        params.reasoning = {
            effort: resolvedCompletionsReasoningEffort,
        };
    }
    else if (resolvedCompletionsReasoningEffort &&
        model.reasoning &&
        compat.supportsReasoningEffort) {
        params.reasoning_effort = resolvedCompletionsReasoningEffort;
    }
    return params;
}
export function parseTransportChunkUsage(rawUsage, model) {
    const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
    const promptTokens = rawUsage.prompt_tokens || 0;
    const input = Math.max(0, promptTokens - cachedTokens);
    const outputTokens = rawUsage.completion_tokens || 0;
    const usage = {
        input,
        output: outputTokens,
        cacheRead: cachedTokens,
        cacheWrite: 0,
        totalTokens: input + outputTokens + cachedTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    return usage;
}
function mapStopReason(reason) {
    if (reason === null) {
        return { stopReason: "stop" };
    }
    switch (reason) {
        case "stop":
        case "end":
            return { stopReason: "stop" };
        case "length":
            return { stopReason: "length" };
        case "function_call":
        case "tool_call":
        case "tool_calls":
            return { stopReason: "toolUse" };
        case "content_filter":
            return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
        case "network_error":
            return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
        default:
            return {
                stopReason: "error",
                errorMessage: `Provider finish_reason: ${reason}`,
            };
    }
}
export const __testing = {
    buildOpenAICompletionsClientConfig,
    processOpenAICompletionsStream,
};
