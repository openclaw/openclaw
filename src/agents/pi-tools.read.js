import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { SafeOpenError, openFileWithinRoot, readFileWithinRoot, writeFileWithinRoot, } from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";
const DEFAULT_READ_PAGE_MAX_BYTES = 50 * 1024;
const MAX_ADAPTIVE_READ_MAX_BYTES = 512 * 1024;
const ADAPTIVE_READ_CONTEXT_SHARE = 0.2;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_ADAPTIVE_READ_PAGES = 8;
const READ_CONTINUATION_NOTICE_RE = /\n\n\[(?:Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function resolveAdaptiveReadMaxBytes(options) {
    const contextWindowTokens = options?.modelContextWindowTokens;
    if (typeof contextWindowTokens !== "number" ||
        !Number.isFinite(contextWindowTokens) ||
        contextWindowTokens <= 0) {
        return DEFAULT_READ_PAGE_MAX_BYTES;
    }
    const fromContext = Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * ADAPTIVE_READ_CONTEXT_SHARE);
    return clamp(fromContext, DEFAULT_READ_PAGE_MAX_BYTES, MAX_ADAPTIVE_READ_MAX_BYTES);
}
function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)}KB`;
    }
    return `${bytes}B`;
}
function getToolResultText(result) {
    const content = Array.isArray(result.content) ? result.content : [];
    const textBlocks = content
        .map((block) => {
        if (block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string") {
            return block.text;
        }
        return undefined;
    })
        .filter((value) => typeof value === "string");
    if (textBlocks.length === 0) {
        return undefined;
    }
    return textBlocks.join("\n");
}
function withToolResultText(result, text) {
    const content = Array.isArray(result.content) ? result.content : [];
    let replaced = false;
    const nextContent = content.map((block) => {
        if (!replaced &&
            block &&
            typeof block === "object" &&
            block.type === "text") {
            replaced = true;
            return {
                ...block,
                text,
            };
        }
        return block;
    });
    if (replaced) {
        return {
            ...result,
            content: nextContent,
        };
    }
    const textBlock = { type: "text", text };
    return {
        ...result,
        content: [textBlock],
    };
}
function extractReadTruncationDetails(result) {
    const details = result.details;
    if (!details || typeof details !== "object") {
        return null;
    }
    const truncation = details.truncation;
    if (!truncation || typeof truncation !== "object") {
        return null;
    }
    const record = truncation;
    if (record.truncated !== true) {
        return null;
    }
    const outputLinesRaw = record.outputLines;
    const outputLines = typeof outputLinesRaw === "number" && Number.isFinite(outputLinesRaw)
        ? Math.max(0, Math.floor(outputLinesRaw))
        : 0;
    return {
        truncated: true,
        outputLines,
        firstLineExceedsLimit: record.firstLineExceedsLimit === true,
    };
}
function stripReadContinuationNotice(text) {
    return text.replace(READ_CONTINUATION_NOTICE_RE, "");
}
function stripReadTruncationContentDetails(result) {
    const details = result.details;
    if (!details || typeof details !== "object") {
        return result;
    }
    const detailsRecord = details;
    const truncationRaw = detailsRecord.truncation;
    if (!truncationRaw || typeof truncationRaw !== "object") {
        return result;
    }
    const truncation = truncationRaw;
    if (!Object.prototype.hasOwnProperty.call(truncation, "content")) {
        return result;
    }
    const { content: _content, ...restTruncation } = truncation;
    return {
        ...result,
        details: {
            ...detailsRecord,
            truncation: restTruncation,
        },
    };
}
async function executeReadWithAdaptivePaging(params) {
    const userLimit = params.args.limit;
    const hasExplicitLimit = typeof userLimit === "number" && Number.isFinite(userLimit) && userLimit > 0;
    if (hasExplicitLimit) {
        return await params.base.execute(params.toolCallId, params.args, params.signal);
    }
    const offsetRaw = params.args.offset;
    let nextOffset = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0
        ? Math.floor(offsetRaw)
        : 1;
    let firstResult = null;
    let aggregatedText = "";
    let aggregatedBytes = 0;
    let capped = false;
    let continuationOffset;
    for (let page = 0; page < MAX_ADAPTIVE_READ_PAGES; page += 1) {
        const pageArgs = { ...params.args, offset: nextOffset };
        const pageResult = await params.base.execute(params.toolCallId, pageArgs, params.signal);
        firstResult ??= pageResult;
        const rawText = getToolResultText(pageResult);
        if (typeof rawText !== "string") {
            return pageResult;
        }
        const truncation = extractReadTruncationDetails(pageResult);
        const canContinue = Boolean(truncation?.truncated) &&
            !truncation?.firstLineExceedsLimit &&
            (truncation?.outputLines ?? 0) > 0 &&
            page < MAX_ADAPTIVE_READ_PAGES - 1;
        const pageText = canContinue ? stripReadContinuationNotice(rawText) : rawText;
        const delimiter = aggregatedText ? "\n\n" : "";
        const nextBytes = Buffer.byteLength(`${delimiter}${pageText}`, "utf-8");
        if (aggregatedText && aggregatedBytes + nextBytes > params.maxBytes) {
            capped = true;
            continuationOffset = nextOffset;
            break;
        }
        aggregatedText += `${delimiter}${pageText}`;
        aggregatedBytes += nextBytes;
        if (!canContinue || !truncation) {
            return withToolResultText(pageResult, aggregatedText);
        }
        nextOffset += truncation.outputLines;
        continuationOffset = nextOffset;
        if (aggregatedBytes >= params.maxBytes) {
            capped = true;
            break;
        }
    }
    if (!firstResult) {
        return await params.base.execute(params.toolCallId, params.args, params.signal);
    }
    let finalText = aggregatedText;
    if (capped && continuationOffset) {
        finalText += `\n\n[Read output capped at ${formatBytes(params.maxBytes)} for this call. Use offset=${continuationOffset} to continue.]`;
    }
    return withToolResultText(firstResult, finalText);
}
function rewriteReadImageHeader(text, mimeType) {
    // pi-coding-agent uses: "Read image file [image/png]"
    if (text.startsWith("Read image file [") && text.endsWith("]")) {
        return `Read image file [${mimeType}]`;
    }
    return text;
}
async function normalizeReadImageResult(result, filePath) {
    const content = Array.isArray(result.content) ? result.content : [];
    const image = content.find((b) => !!b &&
        typeof b === "object" &&
        b.type === "image" &&
        typeof b.data === "string" &&
        typeof b.mimeType === "string");
    if (!image) {
        return result;
    }
    if (!image.data.trim()) {
        throw new Error(`read: image payload is empty (${filePath})`);
    }
    const sniffed = await sniffMimeFromBase64(image.data);
    if (!sniffed) {
        return result;
    }
    if (!sniffed.startsWith("image/")) {
        throw new Error(`read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`);
    }
    if (sniffed === image.mimeType) {
        return result;
    }
    const nextContent = content.map((block) => {
        if (block && typeof block === "object" && block.type === "image") {
            const b = block;
            return { ...b, mimeType: sniffed };
        }
        if (block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string") {
            const b = block;
            return {
                ...b,
                text: rewriteReadImageHeader(b.text, sniffed),
            };
        }
        return block;
    });
    return { ...result, content: nextContent };
}
const RETRY_GUIDANCE_SUFFIX = " Supply correct parameters before retrying.";
function parameterValidationError(message) {
    return new Error(`${message}.${RETRY_GUIDANCE_SUFFIX}`);
}
export const CLAUDE_PARAM_GROUPS = {
    read: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
    write: [
        { keys: ["path", "file_path"], label: "path (path or file_path)" },
        { keys: ["content"], label: "content" },
    ],
    edit: [
        { keys: ["path", "file_path"], label: "path (path or file_path)" },
        {
            keys: ["oldText", "old_string"],
            label: "oldText (oldText or old_string)",
        },
        {
            keys: ["newText", "new_string"],
            label: "newText (newText or new_string)",
            allowEmpty: true,
        },
    ],
};
function extractStructuredText(value, depth = 0) {
    if (depth > 6) {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => extractStructuredText(entry, depth + 1))
            .filter((entry) => typeof entry === "string");
        return parts.length > 0 ? parts.join("") : undefined;
    }
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const record = value;
    if (typeof record.text === "string") {
        return record.text;
    }
    if (typeof record.content === "string") {
        return record.content;
    }
    if (Array.isArray(record.content)) {
        return extractStructuredText(record.content, depth + 1);
    }
    if (Array.isArray(record.parts)) {
        return extractStructuredText(record.parts, depth + 1);
    }
    if (typeof record.value === "string" && record.value.length > 0) {
        const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
        const kind = typeof record.kind === "string" ? record.kind.toLowerCase() : "";
        if (type.includes("text") || kind === "text") {
            return record.value;
        }
    }
    return undefined;
}
function normalizeTextLikeParam(record, key) {
    const value = record[key];
    if (typeof value === "string") {
        return;
    }
    const extracted = extractStructuredText(value);
    if (typeof extracted === "string") {
        record[key] = extracted;
    }
}
// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params) {
    if (!params || typeof params !== "object") {
        return undefined;
    }
    const record = params;
    const normalized = { ...record };
    // file_path → path (read, write, edit)
    if ("file_path" in normalized && !("path" in normalized)) {
        normalized.path = normalized.file_path;
        delete normalized.file_path;
    }
    // old_string → oldText (edit)
    if ("old_string" in normalized && !("oldText" in normalized)) {
        normalized.oldText = normalized.old_string;
        delete normalized.old_string;
    }
    // new_string → newText (edit)
    if ("new_string" in normalized && !("newText" in normalized)) {
        normalized.newText = normalized.new_string;
        delete normalized.new_string;
    }
    // Some providers/models emit text payloads as structured blocks instead of raw strings.
    // Normalize these for write/edit so content matching and writes stay deterministic.
    normalizeTextLikeParam(normalized, "content");
    normalizeTextLikeParam(normalized, "oldText");
    normalizeTextLikeParam(normalized, "newText");
    return normalized;
}
export function patchToolSchemaForClaudeCompatibility(tool) {
    const schema = tool.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : undefined;
    if (!schema || !schema.properties || typeof schema.properties !== "object") {
        return tool;
    }
    const properties = { ...schema.properties };
    const required = Array.isArray(schema.required)
        ? schema.required.filter((key) => typeof key === "string")
        : [];
    let changed = false;
    const aliasPairs = [
        { original: "path", alias: "file_path" },
        { original: "oldText", alias: "old_string" },
        { original: "newText", alias: "new_string" },
    ];
    for (const { original, alias } of aliasPairs) {
        if (!(original in properties)) {
            continue;
        }
        if (!(alias in properties)) {
            properties[alias] = properties[original];
            changed = true;
        }
        const idx = required.indexOf(original);
        if (idx !== -1) {
            required.splice(idx, 1);
            changed = true;
        }
    }
    if (!changed) {
        return tool;
    }
    return {
        ...tool,
        parameters: {
            ...schema,
            properties,
            required,
        },
    };
}
export function assertRequiredParams(record, groups, toolName) {
    if (!record || typeof record !== "object") {
        throw parameterValidationError(`Missing parameters for ${toolName}`);
    }
    const missingLabels = [];
    for (const group of groups) {
        const satisfied = group.keys.some((key) => {
            if (!(key in record)) {
                return false;
            }
            const value = record[key];
            if (typeof value !== "string") {
                return false;
            }
            if (group.allowEmpty) {
                return true;
            }
            return value.trim().length > 0;
        });
        if (!satisfied) {
            const label = group.label ?? group.keys.join(" or ");
            missingLabels.push(label);
        }
    }
    if (missingLabels.length > 0) {
        const joined = missingLabels.join(", ");
        const noun = missingLabels.length === 1 ? "parameter" : "parameters";
        throw parameterValidationError(`Missing required ${noun}: ${joined}`);
    }
}
// Generic wrapper to normalize parameters for any tool
export function wrapToolParamNormalization(tool, requiredParamGroups) {
    const patched = patchToolSchemaForClaudeCompatibility(tool);
    return {
        ...patched,
        execute: async (toolCallId, params, signal, onUpdate) => {
            const normalized = normalizeToolParams(params);
            const record = normalized ??
                (params && typeof params === "object" ? params : undefined);
            if (requiredParamGroups?.length) {
                assertRequiredParams(record, requiredParamGroups, tool.name);
            }
            return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
        },
    };
}
export function wrapToolWorkspaceRootGuard(tool, root) {
    return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}
function mapContainerPathToWorkspaceRoot(params) {
    const containerWorkdir = params.containerWorkdir?.trim();
    if (!containerWorkdir) {
        return params.filePath;
    }
    const normalizedWorkdir = containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalizedWorkdir.startsWith("/")) {
        return params.filePath;
    }
    if (!normalizedWorkdir) {
        return params.filePath;
    }
    let candidate = params.filePath.startsWith("@") ? params.filePath.slice(1) : params.filePath;
    if (/^file:\/\//i.test(candidate)) {
        try {
            candidate = fileURLToPath(candidate);
        }
        catch {
            try {
                const parsed = new URL(candidate);
                if (parsed.protocol !== "file:") {
                    return params.filePath;
                }
                candidate = decodeURIComponent(parsed.pathname || "");
                if (!candidate.startsWith("/")) {
                    return params.filePath;
                }
            }
            catch {
                return params.filePath;
            }
        }
    }
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    if (normalizedCandidate === normalizedWorkdir) {
        return path.resolve(params.root);
    }
    const prefix = `${normalizedWorkdir}/`;
    if (!normalizedCandidate.startsWith(prefix)) {
        return candidate;
    }
    const relative = normalizedCandidate.slice(prefix.length);
    if (!relative) {
        return path.resolve(params.root);
    }
    return path.resolve(params.root, ...relative.split("/").filter(Boolean));
}
export function wrapToolWorkspaceRootGuardWithOptions(tool, root, options) {
    return {
        ...tool,
        execute: async (toolCallId, args, signal, onUpdate) => {
            const normalized = normalizeToolParams(args);
            const record = normalized ??
                (args && typeof args === "object" ? args : undefined);
            const filePath = record?.path;
            if (typeof filePath === "string" && filePath.trim()) {
                const sandboxPath = mapContainerPathToWorkspaceRoot({
                    filePath,
                    root,
                    containerWorkdir: options?.containerWorkdir,
                });
                await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
            }
            return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
        },
    };
}
export function createSandboxedReadTool(params) {
    const base = createReadTool(params.root, {
        operations: createSandboxReadOperations(params),
    });
    return createOpenClawReadTool(base, {
        modelContextWindowTokens: params.modelContextWindowTokens,
        imageSanitization: params.imageSanitization,
    });
}
export function createSandboxedWriteTool(params) {
    const base = createWriteTool(params.root, {
        operations: createSandboxWriteOperations(params),
    });
    return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}
export function createSandboxedEditTool(params) {
    const base = createEditTool(params.root, {
        operations: createSandboxEditOperations(params),
    });
    return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit);
}
export function createHostWorkspaceWriteTool(root, options) {
    const base = createWriteTool(root, {
        operations: createHostWriteOperations(root, options),
    });
    return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}
export function createHostWorkspaceEditTool(root, options) {
    const base = createEditTool(root, {
        operations: createHostEditOperations(root, options),
    });
    return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit);
}
export function createOpenClawReadTool(base, options) {
    const patched = patchToolSchemaForClaudeCompatibility(base);
    return {
        ...patched,
        execute: async (toolCallId, params, signal) => {
            const normalized = normalizeToolParams(params);
            const record = normalized ??
                (params && typeof params === "object" ? params : undefined);
            assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
            const result = await executeReadWithAdaptivePaging({
                base,
                toolCallId,
                args: (normalized ?? params ?? {}),
                signal,
                maxBytes: resolveAdaptiveReadMaxBytes(options),
            });
            const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
            const strippedDetailsResult = stripReadTruncationContentDetails(result);
            const normalizedResult = await normalizeReadImageResult(strippedDetailsResult, filePath);
            return sanitizeToolResultImages(normalizedResult, `read:${filePath}`, options?.imageSanitization);
        },
    };
}
function createSandboxReadOperations(params) {
    return {
        readFile: (absolutePath) => params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
        access: async (absolutePath) => {
            const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
            if (!stat) {
                throw createFsAccessError("ENOENT", absolutePath);
            }
        },
        detectImageMimeType: async (absolutePath) => {
            const buffer = await params.bridge.readFile({ filePath: absolutePath, cwd: params.root });
            const mime = await detectMime({ buffer, filePath: absolutePath });
            return mime && mime.startsWith("image/") ? mime : undefined;
        },
    };
}
function createSandboxWriteOperations(params) {
    return {
        mkdir: async (dir) => {
            await params.bridge.mkdirp({ filePath: dir, cwd: params.root });
        },
        writeFile: async (absolutePath, content) => {
            await params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content });
        },
    };
}
function createSandboxEditOperations(params) {
    return {
        readFile: (absolutePath) => params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
        writeFile: (absolutePath, content) => params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content }),
        access: async (absolutePath) => {
            const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
            if (!stat) {
                throw createFsAccessError("ENOENT", absolutePath);
            }
        },
    };
}
function createHostWriteOperations(root, options) {
    const workspaceOnly = options?.workspaceOnly ?? false;
    if (!workspaceOnly) {
        // When workspaceOnly is false, allow writes anywhere on the host
        return {
            mkdir: async (dir) => {
                const resolved = path.resolve(dir);
                await fs.mkdir(resolved, { recursive: true });
            },
            writeFile: async (absolutePath, content) => {
                const resolved = path.resolve(absolutePath);
                const dir = path.dirname(resolved);
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(resolved, content, "utf-8");
            },
        };
    }
    // When workspaceOnly is true, enforce workspace boundary
    return {
        mkdir: async (dir) => {
            const relative = toRelativeWorkspacePath(root, dir, { allowRoot: true });
            const resolved = relative ? path.resolve(root, relative) : path.resolve(root);
            await assertSandboxPath({ filePath: resolved, cwd: root, root });
            await fs.mkdir(resolved, { recursive: true });
        },
        writeFile: async (absolutePath, content) => {
            const relative = toRelativeWorkspacePath(root, absolutePath);
            await writeFileWithinRoot({
                rootDir: root,
                relativePath: relative,
                data: content,
                mkdir: true,
            });
        },
    };
}
function createHostEditOperations(root, options) {
    const workspaceOnly = options?.workspaceOnly ?? false;
    if (!workspaceOnly) {
        // When workspaceOnly is false, allow edits anywhere on the host
        return {
            readFile: async (absolutePath) => {
                const resolved = path.resolve(absolutePath);
                return await fs.readFile(resolved);
            },
            writeFile: async (absolutePath, content) => {
                const resolved = path.resolve(absolutePath);
                const dir = path.dirname(resolved);
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(resolved, content, "utf-8");
            },
            access: async (absolutePath) => {
                const resolved = path.resolve(absolutePath);
                await fs.access(resolved);
            },
        };
    }
    // When workspaceOnly is true, enforce workspace boundary
    return {
        readFile: async (absolutePath) => {
            const relative = toRelativeWorkspacePath(root, absolutePath);
            const safeRead = await readFileWithinRoot({
                rootDir: root,
                relativePath: relative,
            });
            return safeRead.buffer;
        },
        writeFile: async (absolutePath, content) => {
            const relative = toRelativeWorkspacePath(root, absolutePath);
            await writeFileWithinRoot({
                rootDir: root,
                relativePath: relative,
                data: content,
                mkdir: true,
            });
        },
        access: async (absolutePath) => {
            let relative;
            try {
                relative = toRelativeWorkspacePath(root, absolutePath);
            }
            catch {
                // Path escapes workspace root.  Don't throw here – the upstream
                // library replaces any `access` error with a misleading "File not
                // found" message.  By returning silently the subsequent `readFile`
                // call will throw the same "Path escapes workspace root" error
                // through a code-path that propagates the original message.
                return;
            }
            try {
                const opened = await openFileWithinRoot({
                    rootDir: root,
                    relativePath: relative,
                });
                await opened.handle.close().catch(() => { });
            }
            catch (error) {
                if (error instanceof SafeOpenError && error.code === "not-found") {
                    throw createFsAccessError("ENOENT", absolutePath);
                }
                if (error instanceof SafeOpenError && error.code === "outside-workspace") {
                    // Don't throw here – see the comment above about the upstream
                    // library swallowing access errors as "File not found".
                    return;
                }
                throw error;
            }
        },
    };
}
function createFsAccessError(code, filePath) {
    const error = new Error(`Sandbox FS error (${code}): ${filePath}`);
    error.code = code;
    return error;
}
