import { EventEmitter } from "node:events";
import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import { hasInterSessionUserProvenance, normalizeInputProvenance, } from "../../sessions/input-provenance.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { downgradeOpenAIFunctionCallReasoningPairs, downgradeOpenAIReasoningBlocks, isCompactionFailureError, isGoogleModelApi, sanitizeGoogleTurnOrdering, sanitizeSessionMessagesImages, } from "../pi-embedded-helpers.js";
import { cleanToolSchemaForGemini } from "../pi-tools.schema.js";
import { sanitizeToolCallInputs, stripToolResultDetails, sanitizeToolUseResultPairing, } from "../session-transcript-repair.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { makeZeroUsageSnapshot } from "../usage.js";
import { log } from "./logger.js";
import { dropThinkingBlocks } from "./thinking.js";
import { describeUnknownError } from "./utils.js";
const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS = new Set([
    "patternProperties",
    "additionalProperties",
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "examples",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "multipleOf",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
]);
const INTER_SESSION_PREFIX_BASE = "[Inter-session message]";
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
function findUnsupportedSchemaKeywords(schema, path) {
    if (!schema || typeof schema !== "object") {
        return [];
    }
    if (Array.isArray(schema)) {
        return schema.flatMap((item, index) => findUnsupportedSchemaKeywords(item, `${path}[${index}]`));
    }
    const record = schema;
    const violations = [];
    const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
        ? record.properties
        : undefined;
    if (properties) {
        for (const [key, value] of Object.entries(properties)) {
            violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`));
        }
    }
    for (const [key, value] of Object.entries(record)) {
        if (key === "properties") {
            continue;
        }
        if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
            violations.push(`${path}.${key}`);
        }
        if (value && typeof value === "object") {
            violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
        }
    }
    return violations;
}
export function sanitizeToolsForGoogle(params) {
    // Cloud Code Assist uses the OpenAPI 3.03 `parameters` field for both Gemini
    // AND Claude models.  This field does not support JSON Schema keywords such as
    // patternProperties, additionalProperties, $ref, etc.  We must clean schemas
    // for every provider that routes through this path.
    if (params.provider !== "google-gemini-cli") {
        return params.tools;
    }
    return params.tools.map((tool) => {
        if (!tool.parameters || typeof tool.parameters !== "object") {
            return tool;
        }
        return {
            ...tool,
            parameters: cleanToolSchemaForGemini(tool.parameters),
        };
    });
}
export function logToolSchemasForGoogle(params) {
    if (params.provider !== "google-gemini-cli") {
        return;
    }
    const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
    const tools = sanitizeToolsForGoogle(params);
    log.info("google tool schema snapshot", {
        provider: params.provider,
        toolCount: tools.length,
        tools: toolNames,
    });
    for (const [index, tool] of tools.entries()) {
        const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`);
        if (violations.length > 0) {
            log.warn("google tool schema has unsupported keywords", {
                index,
                tool: tool.name,
                violations: violations.slice(0, 12),
                violationCount: violations.length,
            });
        }
    }
}
// Event emitter for unhandled compaction failures that escape try-catch blocks.
// Listeners can use this to trigger session recovery with retry.
const compactionFailureEmitter = new EventEmitter();
/**
 * Register a listener for unhandled compaction failures.
 * Called when auto-compaction fails in a way that escapes the normal try-catch,
 * e.g., when the summarization request itself exceeds the model's token limit.
 * Returns an unsubscribe function.
 */
export function onUnhandledCompactionFailure(cb) {
    compactionFailureEmitter.on("failure", cb);
    return () => compactionFailureEmitter.off("failure", cb);
}
registerUnhandledRejectionHandler((reason) => {
    const message = describeUnknownError(reason);
    if (!isCompactionFailureError(message)) {
        return false;
    }
    log.error(`Auto-compaction failed (unhandled): ${message}`);
    compactionFailureEmitter.emit("failure", message);
    return true;
});
const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
function readLastModelSnapshot(sessionManager) {
    try {
        const entries = sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
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
function hasGoogleTurnOrderingMarker(sessionManager) {
    try {
        return sessionManager
            .getEntries()
            .some((entry) => entry?.type === "custom" &&
            entry?.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE);
    }
    catch {
        return false;
    }
}
function markGoogleTurnOrderingMarker(sessionManager) {
    try {
        sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
            timestamp: Date.now(),
        });
    }
    catch {
        // ignore marker persistence failures
    }
}
export function applyGoogleTurnOrderingFix(params) {
    if (!isGoogleModelApi(params.modelApi)) {
        return { messages: params.messages, didPrepend: false };
    }
    const first = params.messages[0];
    if (first?.role !== "assistant") {
        return { messages: params.messages, didPrepend: false };
    }
    const sanitized = sanitizeGoogleTurnOrdering(params.messages);
    const didPrepend = sanitized !== params.messages;
    if (didPrepend && !hasGoogleTurnOrderingMarker(params.sessionManager)) {
        const warn = params.warn ?? ((message) => log.warn(message));
        warn(`google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`);
        markGoogleTurnOrderingMarker(params.sessionManager);
    }
    return { messages: sanitized, didPrepend };
}
export async function sanitizeSessionHistory(params) {
    // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
    const policy = params.policy ??
        resolveTranscriptPolicy({
            modelApi: params.modelApi,
            provider: params.provider,
            modelId: params.modelId,
        });
    const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
    const sanitizedImages = await sanitizeSessionMessagesImages(withInterSessionMarkers, "session:history", {
        sanitizeMode: policy.sanitizeMode,
        sanitizeToolCallIds: policy.sanitizeToolCallIds,
        toolCallIdMode: policy.toolCallIdMode,
        preserveSignatures: policy.preserveSignatures,
        sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
        ...resolveImageSanitizationLimits(params.config),
    });
    const droppedThinking = policy.dropThinkingBlocks
        ? dropThinkingBlocks(sanitizedImages)
        : sanitizedImages;
    const sanitizedToolCalls = sanitizeToolCallInputs(droppedThinking, {
        allowedToolNames: params.allowedToolNames,
    });
    const repairedTools = policy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairing(sanitizedToolCalls)
        : sanitizedToolCalls;
    const sanitizedToolResults = stripToolResultDetails(repairedTools);
    const sanitizedCompactionUsage = stripStaleAssistantUsageBeforeLatestCompaction(sanitizedToolResults);
    const isOpenAIResponsesApi = params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses";
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
    const sanitizedOpenAI = isOpenAIResponsesApi
        ? downgradeOpenAIFunctionCallReasoningPairs(downgradeOpenAIReasoningBlocks(sanitizedCompactionUsage))
        : sanitizedCompactionUsage;
    if (hasSnapshot && (!priorSnapshot || modelChanged)) {
        appendModelSnapshot(params.sessionManager, {
            timestamp: Date.now(),
            provider: params.provider,
            modelApi: params.modelApi,
            modelId: params.modelId,
        });
    }
    if (!policy.applyGoogleTurnOrdering) {
        return sanitizedOpenAI;
    }
    return applyGoogleTurnOrderingFix({
        messages: sanitizedOpenAI,
        modelApi: params.modelApi,
        sessionManager: params.sessionManager,
        sessionId: params.sessionId,
    }).messages;
}
