import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import { appendFileWithinRoot, SafeOpenError, openFileWithinRoot, readFileWithinRoot, writeFileWithinRoot, } from "../infra/fs-safe.js";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { hasEncodedFileUrlSeparator, trySafeFileURLToPath } from "../infra/local-file-access.js";
import { detectMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import { REQUIRED_PARAM_GROUPS, assertRequiredParams, getToolParamsRecord, wrapToolParamValidation, } from "./pi-tools.params.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";
export { REQUIRED_PARAM_GROUPS, assertRequiredParams, getToolParamsRecord, wrapToolParamValidation, } from "./pi-tools.params.js";
const DEFAULT_READ_PAGE_MAX_BYTES = 32 * 1024;
const MAX_ADAPTIVE_READ_MAX_BYTES = 128 * 1024;
const ADAPTIVE_READ_CONTEXT_SHARE = 0.1;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_ADAPTIVE_READ_PAGES = 4;
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
            return Object.assign({}, block, { text });
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
            return Object.assign({}, b, { mimeType: sniffed });
        }
        if (block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string") {
            const b = block;
            return Object.assign({}, b, {
                text: rewriteReadImageHeader(b.text, sniffed),
            });
        }
        return block;
    });
    return { ...result, content: nextContent };
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
        const localFilePath = trySafeFileURLToPath(candidate);
        if (localFilePath) {
            candidate = localFilePath;
        }
        else {
            // Windows rejects posix-style file:///workspace/... in fileURLToPath; map via URL pathname
            // when it clearly refers to the container workdir (same idea as sandbox-paths).
            let parsed;
            try {
                parsed = new URL(candidate);
            }
            catch {
                return params.filePath;
            }
            if (parsed.protocol !== "file:") {
                return params.filePath;
            }
            const host = parsed.hostname.trim().toLowerCase();
            if (host && host !== "localhost") {
                return params.filePath;
            }
            if (hasEncodedFileUrlSeparator(parsed.pathname)) {
                return params.filePath;
            }
            let normalizedPathname;
            try {
                normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
            }
            catch {
                return params.filePath;
            }
            if (normalizedPathname !== normalizedWorkdir &&
                !normalizedPathname.startsWith(`${normalizedWorkdir}/`)) {
                return params.filePath;
            }
            candidate = normalizedPathname;
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
export function resolveToolPathAgainstWorkspaceRoot(params) {
    const mapped = mapContainerPathToWorkspaceRoot(params);
    const candidate = mapped.startsWith("@") ? mapped.slice(1) : mapped;
    if (isWindowsDrivePath(candidate)) {
        return path.win32.normalize(candidate);
    }
    if (path.isAbsolute(candidate)) {
        return path.resolve(candidate);
    }
    return path.resolve(params.root, candidate || ".");
}
async function readOptionalUtf8File(params) {
    try {
        if (params.sandbox) {
            const stat = await params.sandbox.bridge.stat({
                filePath: params.relativePath,
                cwd: params.sandbox.root,
                signal: params.signal,
            });
            if (!stat) {
                return "";
            }
            const buffer = await params.sandbox.bridge.readFile({
                filePath: params.relativePath,
                cwd: params.sandbox.root,
                signal: params.signal,
            });
            return buffer.toString("utf-8");
        }
        return await fs.readFile(params.absolutePath, "utf-8");
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}
async function appendMemoryFlushContent(params) {
    if (!params.sandbox) {
        await appendFileWithinRoot({
            rootDir: params.root,
            relativePath: params.relativePath,
            data: params.content,
            mkdir: true,
            prependNewlineIfNeeded: true,
        });
        return;
    }
    const existing = await readOptionalUtf8File({
        absolutePath: params.absolutePath,
        relativePath: params.relativePath,
        sandbox: params.sandbox,
        signal: params.signal,
    });
    const separator = existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n") ? "\n" : "";
    const next = `${existing}${separator}${params.content}`;
    if (params.sandbox) {
        const parent = path.posix.dirname(params.relativePath);
        if (parent && parent !== ".") {
            await params.sandbox.bridge.mkdirp({
                filePath: parent,
                cwd: params.sandbox.root,
                signal: params.signal,
            });
        }
        await params.sandbox.bridge.writeFile({
            filePath: params.relativePath,
            cwd: params.sandbox.root,
            data: next,
            mkdir: true,
            signal: params.signal,
        });
        return;
    }
    await fs.mkdir(path.dirname(params.absolutePath), { recursive: true });
    await fs.writeFile(params.absolutePath, next, "utf-8");
}
export function wrapToolMemoryFlushAppendOnlyWrite(tool, options) {
    const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
    return {
        ...tool,
        description: `${tool.description} During memory flush, this tool may only append to ${options.relativePath}.`,
        execute: async (toolCallId, args, signal, onUpdate) => {
            const record = getToolParamsRecord(args);
            assertRequiredParams(record, REQUIRED_PARAM_GROUPS.write, tool.name);
            const filePath = typeof record?.path === "string" && record.path.trim() ? record.path : undefined;
            const content = typeof record?.content === "string" ? record.content : undefined;
            if (!filePath || content === undefined) {
                return tool.execute(toolCallId, args, signal, onUpdate);
            }
            const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
                filePath,
                root: options.root,
                containerWorkdir: options.containerWorkdir,
            });
            if (resolvedPath !== allowedAbsolutePath) {
                throw new Error(`Memory flush writes are restricted to ${options.relativePath}; use that path only.`);
            }
            await appendMemoryFlushContent({
                absolutePath: allowedAbsolutePath,
                root: options.root,
                relativePath: options.relativePath,
                content,
                sandbox: options.sandbox,
                signal,
            });
            return {
                content: [{ type: "text", text: `Appended content to ${options.relativePath}.` }],
                details: {
                    path: options.relativePath,
                    appendOnly: true,
                },
            };
        },
    };
}
export function wrapToolWorkspaceRootGuardWithOptions(tool, root, options) {
    const pathParamKeys = options?.pathParamKeys && options.pathParamKeys.length > 0 ? options.pathParamKeys : ["path"];
    return {
        ...tool,
        execute: async (toolCallId, args, signal, onUpdate) => {
            const record = getToolParamsRecord(args);
            let normalizedRecord;
            for (const key of pathParamKeys) {
                const filePath = record?.[key];
                if (typeof filePath !== "string" || !filePath.trim()) {
                    continue;
                }
                const sandboxPath = mapContainerPathToWorkspaceRoot({
                    filePath,
                    root,
                    containerWorkdir: options?.containerWorkdir,
                });
                const sandboxResult = await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
                if (options?.normalizeGuardedPathParams && record) {
                    normalizedRecord ??= { ...record };
                    normalizedRecord[key] = sandboxResult.resolved;
                }
            }
            return tool.execute(toolCallId, normalizedRecord ?? args, signal, onUpdate);
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
    return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}
export function createSandboxedEditTool(params) {
    const base = createEditTool(params.root, {
        operations: createSandboxEditOperations(params),
    });
    const withRecovery = wrapEditToolWithRecovery(base, {
        root: params.root,
        readFile: async (absolutePath) => (await params.bridge.readFile({ filePath: absolutePath, cwd: params.root })).toString("utf8"),
    });
    return wrapToolParamValidation(withRecovery, REQUIRED_PARAM_GROUPS.edit);
}
export function createHostWorkspaceWriteTool(root, options) {
    const base = createWriteTool(root, {
        operations: createHostWriteOperations(root, options),
    });
    return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}
export function createHostWorkspaceEditTool(root, options) {
    const base = createEditTool(root, {
        operations: createHostEditOperations(root, options),
    });
    const withRecovery = wrapEditToolWithRecovery(base, {
        root,
        readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
    });
    return wrapToolParamValidation(withRecovery, REQUIRED_PARAM_GROUPS.edit);
}
export function createOpenClawReadTool(base, options) {
    return {
        ...base,
        execute: async (toolCallId, params, signal) => {
            const record = getToolParamsRecord(params);
            assertRequiredParams(record, REQUIRED_PARAM_GROUPS.read, base.name);
            const result = await executeReadWithAdaptivePaging({
                base,
                toolCallId,
                args: record ?? {},
                signal,
                maxBytes: resolveAdaptiveReadMaxBytes(options),
            });
            const filePath = typeof record?.path === "string" ? record.path : "<unknown>";
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
function expandTildeToOsHome(filePath) {
    const home = resolveOsHomeDir();
    return home ? expandHomePrefix(filePath, { home }) : filePath;
}
async function writeHostFile(absolutePath, content) {
    const resolved = path.resolve(expandTildeToOsHome(absolutePath));
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
}
function createHostWriteOperations(root, options) {
    const workspaceOnly = options?.workspaceOnly ?? false;
    if (!workspaceOnly) {
        // When workspaceOnly is false, allow writes anywhere on the host
        return {
            mkdir: async (dir) => {
                const resolved = path.resolve(expandTildeToOsHome(dir));
                await fs.mkdir(resolved, { recursive: true });
            },
            writeFile: writeHostFile,
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
                const resolved = path.resolve(expandTildeToOsHome(absolutePath));
                return await fs.readFile(resolved);
            },
            writeFile: writeHostFile,
            access: async (absolutePath) => {
                const resolved = path.resolve(expandTildeToOsHome(absolutePath));
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
