import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { pluginRegistrationContractRegistry } from "../plugins/contracts/registry.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, readStringValue, } from "../shared/string-coerce.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { normalizeToolName } from "./tool-policy.js";
const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;
function truncateToolText(text) {
    if (text.length <= TOOL_RESULT_MAX_CHARS) {
        return text;
    }
    return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}
function normalizeToolErrorText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) {
        return undefined;
    }
    return firstLine.length > TOOL_ERROR_MAX_CHARS
        ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
        : firstLine;
}
function isErrorLikeStatus(status) {
    const normalized = normalizeOptionalLowercaseString(status);
    if (!normalized) {
        return false;
    }
    if (normalized === "0" ||
        normalized === "ok" ||
        normalized === "success" ||
        normalized === "completed" ||
        normalized === "running") {
        return false;
    }
    return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}
function readErrorCandidate(value) {
    if (typeof value === "string") {
        return normalizeToolErrorText(value);
    }
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const record = value;
    if (typeof record.message === "string") {
        return normalizeToolErrorText(record.message);
    }
    if (typeof record.error === "string") {
        return normalizeToolErrorText(record.error);
    }
    return undefined;
}
function extractErrorField(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const record = value;
    const direct = readErrorCandidate(record.error) ??
        readErrorCandidate(record.message) ??
        readErrorCandidate(record.reason);
    if (direct) {
        return direct;
    }
    const status = normalizeOptionalString(record.status) ?? "";
    if (!status || !isErrorLikeStatus(status)) {
        return undefined;
    }
    return normalizeToolErrorText(status);
}
export function sanitizeToolResult(result) {
    if (!result || typeof result !== "object") {
        return result;
    }
    const record = result;
    const content = Array.isArray(record.content) ? record.content : null;
    if (!content) {
        return record;
    }
    const sanitized = content.map((item) => {
        if (!item || typeof item !== "object") {
            return item;
        }
        const entry = item;
        const type = readStringValue(entry.type);
        if (type === "text" && typeof entry.text === "string") {
            return Object.assign({}, entry, { text: truncateToolText(entry.text) });
        }
        if (type === "image") {
            const data = readStringValue(entry.data);
            const bytes = data ? data.length : undefined;
            const cleaned = { ...entry };
            delete cleaned.data;
            return Object.assign({}, cleaned, { bytes, omitted: true });
        }
        return entry;
    });
    return { ...record, content: sanitized };
}
export function extractToolResultText(result) {
    if (!result || typeof result !== "object") {
        return undefined;
    }
    const record = result;
    const texts = collectTextContentBlocks(record.content)
        .map((item) => {
        const trimmed = item.trim();
        return trimmed ? trimmed : undefined;
    })
        .filter((value) => Boolean(value));
    if (texts.length === 0) {
        return undefined;
    }
    return texts.join("\n");
}
// Core tool names that are allowed to emit local MEDIA: paths.
// Plugin/MCP tools are intentionally excluded to prevent untrusted file reads.
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
    "agents_list",
    "apply_patch",
    "browser",
    "canvas",
    "cron",
    "edit",
    "exec",
    "gateway",
    "image",
    "image_generate",
    "memory_get",
    "memory_search",
    "message",
    "music_generate",
    "nodes",
    "process",
    "read",
    "session_status",
    "sessions_history",
    "sessions_list",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "tts",
    "video_generate",
    "web_fetch",
    "web_search",
    "x_search",
    "write",
]);
const TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS = new Set(pluginRegistrationContractRegistry.flatMap((entry) => entry.toolNames));
const HTTP_URL_RE = /^https?:\/\//i;
function readToolResultDetails(result) {
    if (!result || typeof result !== "object") {
        return undefined;
    }
    const record = result;
    return record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details
        : undefined;
}
function readToolResultStatus(result) {
    const status = readToolResultDetails(result)?.status;
    return normalizeOptionalLowercaseString(status);
}
function isExternalToolResult(result) {
    const details = readToolResultDetails(result);
    if (!details) {
        return false;
    }
    return typeof details.mcpServer === "string" || typeof details.mcpTool === "string";
}
export function isToolResultMediaTrusted(toolName, result) {
    if (!toolName || isExternalToolResult(result)) {
        return false;
    }
    const normalized = normalizeToolName(toolName);
    return (TRUSTED_TOOL_RESULT_MEDIA.has(normalized) || TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS.has(normalized));
}
export function filterToolResultMediaUrls(toolName, mediaUrls, result, builtinToolNames) {
    if (mediaUrls.length === 0) {
        return mediaUrls;
    }
    if (isToolResultMediaTrusted(toolName, result)) {
        // When the current run provides its exact registered tool names (core
        // built-ins plus bundled/trusted plugin tools), require the raw emitted
        // tool name to match one of them before allowing local MEDIA: paths.
        // This blocks normalized aliases and case-variant collisions such as
        // "Bash" -> "bash" or "Web_Search" -> "web_search" from inheriting a
        // registered tool's media trust.
        if (builtinToolNames !== undefined) {
            const registeredName = toolName?.trim();
            if (!registeredName || !builtinToolNames.has(registeredName)) {
                return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
            }
        }
        return mediaUrls;
    }
    return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}
function readToolResultDetailsMedia(result) {
    const details = readToolResultDetails(result);
    const media = details?.media && typeof details.media === "object" && !Array.isArray(details.media)
        ? details.media
        : undefined;
    return media;
}
function collectStructuredMediaUrls(media) {
    const urls = [];
    if (typeof media.mediaUrl === "string" && media.mediaUrl.trim()) {
        urls.push(media.mediaUrl.trim());
    }
    if (Array.isArray(media.mediaUrls)) {
        urls.push(...media.mediaUrls
            .filter((value) => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean));
    }
    return Array.from(new Set(urls));
}
function extractTextContentMediaArtifact(content) {
    const mediaUrls = [];
    let audioAsVoice = false;
    let hasImageContent = false;
    for (const item of content) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const entry = item;
        if (entry.type === "image") {
            hasImageContent = true;
            continue;
        }
        if (entry.type !== "text" || typeof entry.text !== "string") {
            continue;
        }
        const parsed = splitMediaFromOutput(entry.text);
        if (parsed.audioAsVoice) {
            audioAsVoice = true;
        }
        if (parsed.mediaUrls?.length) {
            mediaUrls.push(...parsed.mediaUrls);
        }
    }
    return {
        mediaUrls,
        ...(audioAsVoice ? { audioAsVoice: true } : {}),
        hasImageContent,
    };
}
export function extractToolResultMediaArtifact(result) {
    if (!result || typeof result !== "object") {
        return undefined;
    }
    const record = result;
    const detailsMedia = readToolResultDetailsMedia(record);
    if (detailsMedia) {
        const mediaUrls = collectStructuredMediaUrls(detailsMedia);
        if (mediaUrls.length > 0) {
            return {
                mediaUrls,
                ...(detailsMedia.audioAsVoice === true ? { audioAsVoice: true } : {}),
                ...(detailsMedia.trustedLocalMedia === true ? { trustedLocalMedia: true } : {}),
            };
        }
    }
    const content = Array.isArray(record.content) ? record.content : null;
    if (!content) {
        return undefined;
    }
    const textMedia = extractTextContentMediaArtifact(content);
    if (textMedia.mediaUrls.length > 0) {
        return {
            mediaUrls: textMedia.mediaUrls,
            ...(textMedia.audioAsVoice ? { audioAsVoice: true } : {}),
        };
    }
    // Fall back to legacy details.path when image content exists but no
    // structured media details or MEDIA: text.
    if (textMedia.hasImageContent) {
        const details = record.details;
        const p = normalizeOptionalString(details?.path) ?? "";
        if (p) {
            return { mediaUrls: [p] };
        }
    }
    return undefined;
}
export function extractToolResultMediaPaths(result) {
    return extractToolResultMediaArtifact(result)?.mediaUrls ?? [];
}
export function isToolResultError(result) {
    const normalized = readToolResultStatus(result);
    if (!normalized) {
        return false;
    }
    return normalized === "error" || normalized === "timeout";
}
export function isToolResultTimedOut(result) {
    const normalizedStatus = readToolResultStatus(result);
    if (normalizedStatus === "timeout") {
        return true;
    }
    return readToolResultDetails(result)?.timedOut === true;
}
export function extractToolErrorMessage(result) {
    if (!result || typeof result !== "object") {
        return undefined;
    }
    const record = result;
    const fromDetails = extractErrorField(record.details);
    if (fromDetails) {
        return fromDetails;
    }
    const fromRoot = extractErrorField(record);
    if (fromRoot) {
        return fromRoot;
    }
    const text = extractToolResultText(result);
    if (!text) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(text);
        const fromJson = extractErrorField(parsed);
        if (fromJson) {
            return fromJson;
        }
    }
    catch {
        // Fall through to first-line text fallback.
    }
    return normalizeToolErrorText(text);
}
function resolveMessageToolTarget(args) {
    const toRaw = readStringValue(args.to);
    if (toRaw) {
        return toRaw;
    }
    return readStringValue(args.target);
}
export function extractMessagingToolSend(toolName, args) {
    // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
    const action = normalizeOptionalString(args.action) ?? "";
    const accountId = normalizeOptionalString(args.accountId);
    if (toolName === "message") {
        if (action !== "send" && action !== "thread-reply") {
            return undefined;
        }
        const toRaw = resolveMessageToolTarget(args);
        if (!toRaw) {
            return undefined;
        }
        const providerRaw = normalizeOptionalString(args.provider) ?? "";
        const channelRaw = normalizeOptionalString(args.channel) ?? "";
        const providerHint = providerRaw || channelRaw;
        const providerId = providerHint ? normalizeChannelId(providerHint) : null;
        const provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
        const to = normalizeTargetForProvider(provider, toRaw);
        return to ? { tool: toolName, provider, accountId, to } : undefined;
    }
    const providerId = normalizeChannelId(toolName);
    if (!providerId) {
        return undefined;
    }
    const plugin = getChannelPlugin(providerId);
    const extracted = plugin?.actions?.extractToolSend?.({ args });
    if (!extracted?.to) {
        return undefined;
    }
    const to = normalizeTargetForProvider(providerId, extracted.to);
    return to
        ? {
            tool: toolName,
            provider: providerId,
            accountId: extracted.accountId ?? accountId,
            to,
        }
        : undefined;
}
