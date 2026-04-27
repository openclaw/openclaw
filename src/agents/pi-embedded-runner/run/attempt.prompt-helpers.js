import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../../music-generation-task-status.js";
import { prependSystemPromptAdditionAfterCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { derivePromptTokens } from "../../usage.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../../video-generation-task-status.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { log } from "../logger.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";
export async function resolvePromptBuildHookResult(params) {
    const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
        ? await params.hookRunner
            .runBeforePromptBuild({
            prompt: params.prompt,
            messages: params.messages,
        }, params.hookCtx)
            .catch((hookErr) => {
            log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
            return undefined;
        })
        : undefined;
    const legacyResult = params.legacyBeforeAgentStartResult ??
        (params.hookRunner?.hasHooks("before_agent_start")
            ? await params.hookRunner
                .runBeforeAgentStart({
                prompt: params.prompt,
                messages: params.messages,
            }, params.hookCtx)
                .catch((hookErr) => {
                log.warn(`before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`);
                return undefined;
            })
            : undefined);
    return {
        systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
        prependContext: joinPresentTextSegments([
            promptBuildResult?.prependContext,
            legacyResult?.prependContext,
        ]),
        prependSystemContext: joinPresentTextSegments([
            promptBuildResult?.prependSystemContext,
            legacyResult?.prependSystemContext,
        ]),
        appendSystemContext: joinPresentTextSegments([
            promptBuildResult?.appendSystemContext,
            legacyResult?.appendSystemContext,
        ]),
    };
}
export function resolvePromptModeForSession(sessionKey) {
    if (!sessionKey) {
        return "full";
    }
    return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}
export function shouldInjectHeartbeatPrompt(params) {
    return (params.isDefaultAgent &&
        shouldInjectHeartbeatPromptForTrigger(params.trigger) &&
        Boolean(resolveHeartbeatPromptForSystemPrompt({
            config: params.config,
            agentId: params.agentId,
            defaultAgentId: params.defaultAgentId,
        })));
}
export function shouldWarnOnOrphanedUserRepair(trigger) {
    return trigger === "user" || trigger === "manual";
}
export function hasPromptSubmissionContent(params) {
    return params.prompt.trim().length > 0 || params.messages.length > 0 || params.imageCount > 0;
}
const QUEUED_USER_MESSAGE_MARKER = "[Queued user message that arrived while the previous turn was still active]";
const MAX_STRUCTURED_MEDIA_REF_CHARS = 300;
const MAX_STRUCTURED_JSON_STRING_CHARS = 300;
const MAX_STRUCTURED_JSON_DEPTH = 4;
const MAX_STRUCTURED_JSON_ARRAY_ITEMS = 16;
const MAX_STRUCTURED_JSON_OBJECT_KEYS = 32;
function summarizeStructuredMediaRef(label, value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const dataUriMatch = trimmed.match(/^data:([^;,]+)?(?:;[^,]*)?,/i);
    if (dataUriMatch) {
        const mimeType = dataUriMatch[1]?.trim() || "unknown";
        return `[${label}] inline data URI (${mimeType}, ${trimmed.length} chars)`;
    }
    if (trimmed.length > MAX_STRUCTURED_MEDIA_REF_CHARS) {
        return `[${label}] ${trimmed.slice(0, MAX_STRUCTURED_MEDIA_REF_CHARS)}... (${trimmed.length} chars)`;
    }
    return `[${label}] ${trimmed}`;
}
function summarizeStructuredJsonString(value) {
    const mediaSummary = summarizeStructuredMediaRef("value", value);
    if (mediaSummary?.includes("inline data URI")) {
        return mediaSummary;
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_STRUCTURED_JSON_STRING_CHARS) {
        return `${trimmed.slice(0, MAX_STRUCTURED_JSON_STRING_CHARS)}... (${trimmed.length} chars)`;
    }
    return value;
}
function sanitizeStructuredJsonValue(value, depth = 0, seen = new WeakSet()) {
    if (typeof value === "string") {
        return summarizeStructuredJsonString(value);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return "[circular]";
    }
    if (depth >= MAX_STRUCTURED_JSON_DEPTH) {
        return "[max depth]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const limited = value
            .slice(0, MAX_STRUCTURED_JSON_ARRAY_ITEMS)
            .map((item) => sanitizeStructuredJsonValue(item, depth + 1, seen));
        if (value.length > MAX_STRUCTURED_JSON_ARRAY_ITEMS) {
            limited.push(`[${value.length - MAX_STRUCTURED_JSON_ARRAY_ITEMS} more items]`);
        }
        seen.delete(value);
        return limited;
    }
    const output = {};
    let copied = 0;
    let skipped = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) {
            continue;
        }
        if (copied >= MAX_STRUCTURED_JSON_OBJECT_KEYS) {
            skipped += 1;
            continue;
        }
        output[key] = sanitizeStructuredJsonValue(value[key], depth + 1, seen);
        copied += 1;
    }
    if (skipped > 0) {
        output.__truncated = `${skipped} more keys`;
    }
    seen.delete(value);
    return output;
}
function stringifyStructuredJsonFallback(part) {
    try {
        const serialized = JSON.stringify(sanitizeStructuredJsonValue(part));
        if (!serialized || serialized === "{}") {
            return undefined;
        }
        const withoutInlineData = serialized.replace(/data:[^"'\\\s]+/gi, (match) => `[inline data URI: ${match.length} chars]`);
        return withoutInlineData.length > 1_000
            ? `${withoutInlineData.slice(0, 1_000)}... (${withoutInlineData.length} chars)`
            : withoutInlineData;
    }
    catch {
        return undefined;
    }
}
function stringifyStructuredContentPart(part) {
    if (!part || typeof part !== "object") {
        return undefined;
    }
    const record = part;
    if (record.type === "text") {
        const text = typeof record.text === "string" ? record.text.trim() : "";
        return text || undefined;
    }
    if (record.type === "image_url") {
        const imageUrl = record.image_url;
        const url = typeof imageUrl === "string"
            ? imageUrl
            : imageUrl && typeof imageUrl === "object"
                ? imageUrl.url
                : undefined;
        return summarizeStructuredMediaRef("image_url", url);
    }
    if (record.type === "image" || record.type === "input_image") {
        return (summarizeStructuredMediaRef(record.type, record.url) ??
            summarizeStructuredMediaRef(record.type, record.source));
    }
    if (typeof record.type === "string") {
        const typedRef = summarizeStructuredMediaRef(record.type, record.audio_url) ??
            summarizeStructuredMediaRef(record.type, record.media_url) ??
            summarizeStructuredMediaRef(record.type, record.url) ??
            summarizeStructuredMediaRef(record.type, record.source);
        if (typedRef) {
            return typedRef;
        }
    }
    return stringifyStructuredJsonFallback(part);
}
function extractUserMessagePromptText(content) {
    if (typeof content === "string") {
        const trimmed = content.trim();
        return trimmed || undefined;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }
    const text = content
        .flatMap((part) => {
        const text = stringifyStructuredContentPart(part);
        return text ? [text] : [];
    })
        .join("\n")
        .trim();
    return text || undefined;
}
function promptAlreadyIncludesQueuedUserMessage(prompt, orphanText) {
    const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
    const normalizedOrphanText = orphanText.replace(/\r\n/g, "\n").trim();
    if (!normalizedOrphanText) {
        return false;
    }
    const queuedBlockPrefix = `${QUEUED_USER_MESSAGE_MARKER}\n${normalizedOrphanText}`;
    return (normalizedPrompt === queuedBlockPrefix ||
        normalizedPrompt.startsWith(`${queuedBlockPrefix}\n`) ||
        normalizedPrompt.includes(`\n${queuedBlockPrefix}\n`) ||
        `\n${normalizedPrompt}\n`.includes(`\n${normalizedOrphanText}\n`));
}
export function mergeOrphanedTrailingUserPrompt(params) {
    const orphanText = extractUserMessagePromptText(params.leafMessage.content);
    if (!orphanText) {
        return { prompt: params.prompt, merged: false, removeLeaf: true };
    }
    if (promptAlreadyIncludesQueuedUserMessage(params.prompt, orphanText)) {
        return { prompt: params.prompt, merged: false, removeLeaf: true };
    }
    return {
        prompt: [QUEUED_USER_MESSAGE_MARKER, orphanText, "", params.prompt].join("\n"),
        merged: true,
        removeLeaf: true,
    };
}
export function resolveAttemptFsWorkspaceOnly(params) {
    return resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: params.sessionAgentId,
    });
}
export function prependSystemPromptAddition(params) {
    return prependSystemPromptAdditionAfterCacheBoundary(params);
}
export function resolveAttemptPrependSystemContext(params) {
    const activeMediaTaskPromptContexts = params.trigger === "user" || params.trigger === "manual"
        ? [
            buildActiveVideoGenerationTaskPromptContextForSession(params.sessionKey),
            buildActiveMusicGenerationTaskPromptContextForSession(params.sessionKey),
        ]
        : [];
    return joinPresentTextSegments([
        ...activeMediaTaskPromptContexts,
        params.hookPrependSystemContext,
    ]);
}
/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params) {
    return {
        ...buildEmbeddedCompactionRuntimeContext({
            sessionKey: params.attempt.sessionKey,
            messageChannel: params.attempt.messageChannel,
            messageProvider: params.attempt.messageProvider,
            agentAccountId: params.attempt.agentAccountId,
            currentChannelId: params.attempt.currentChannelId,
            currentThreadTs: params.attempt.currentThreadTs,
            currentMessageId: params.attempt.currentMessageId,
            authProfileId: params.attempt.authProfileId,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            config: params.attempt.config,
            skillsSnapshot: params.attempt.skillsSnapshot,
            senderIsOwner: params.attempt.senderIsOwner,
            senderId: params.attempt.senderId,
            provider: params.attempt.provider,
            modelId: params.attempt.modelId,
            thinkLevel: params.attempt.thinkLevel,
            reasoningLevel: params.attempt.reasoningLevel,
            bashElevated: params.attempt.bashElevated,
            extraSystemPrompt: params.attempt.extraSystemPrompt,
            ownerNumbers: params.attempt.ownerNumbers,
        }),
        ...(typeof params.tokenBudget === "number" &&
            Number.isFinite(params.tokenBudget) &&
            params.tokenBudget > 0
            ? { tokenBudget: Math.floor(params.tokenBudget) }
            : {}),
        ...(typeof params.currentTokenCount === "number" &&
            Number.isFinite(params.currentTokenCount) &&
            params.currentTokenCount > 0
            ? { currentTokenCount: Math.floor(params.currentTokenCount) }
            : {}),
        ...(params.promptCache ? { promptCache: params.promptCache } : {}),
    };
}
export function buildAfterTurnRuntimeContextFromUsage(params) {
    return buildAfterTurnRuntimeContext({
        ...params,
        currentTokenCount: derivePromptTokens(params.lastCallUsage),
    });
}
