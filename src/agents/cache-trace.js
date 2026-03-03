import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { getQueuedFileWriter } from "./queued-file-writer.js";
const writers = new Map();
function resolveCacheTraceConfig(params) {
    const env = params.env ?? process.env;
    const config = params.cfg?.diagnostics?.cacheTrace;
    const envEnabled = parseBooleanValue(env.OPENCLAW_CACHE_TRACE);
    const enabled = envEnabled ?? config?.enabled ?? false;
    const fileOverride = config?.filePath?.trim() || env.OPENCLAW_CACHE_TRACE_FILE?.trim();
    const filePath = fileOverride
        ? resolveUserPath(fileOverride)
        : path.join(resolveStateDir(env), "logs", "cache-trace.jsonl");
    const includeMessages = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_MESSAGES) ?? config?.includeMessages;
    const includePrompt = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_PROMPT) ?? config?.includePrompt;
    const includeSystem = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_SYSTEM) ?? config?.includeSystem;
    return {
        enabled,
        filePath,
        includeMessages: includeMessages ?? true,
        includePrompt: includePrompt ?? true,
        includeSystem: includeSystem ?? true,
    };
}
function getWriter(filePath) {
    return getQueuedFileWriter(writers, filePath);
}
function stableStringify(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
        return JSON.stringify(String(value));
    }
    if (typeof value === "bigint") {
        return JSON.stringify(value.toString());
    }
    if (typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (value instanceof Error) {
        return stableStringify({
            name: value.name,
            message: value.message,
            stack: value.stack,
        });
    }
    if (value instanceof Uint8Array) {
        return stableStringify({
            type: "Uint8Array",
            data: Buffer.from(value).toString("base64"),
        });
    }
    if (Array.isArray(value)) {
        const serializedEntries = [];
        for (const entry of value) {
            serializedEntries.push(stableStringify(entry));
        }
        return `[${serializedEntries.join(",")}]`;
    }
    const record = value;
    const serializedFields = [];
    for (const key of Object.keys(record).toSorted()) {
        serializedFields.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
    }
    return `{${serializedFields.join(",")}}`;
}
function digest(value) {
    const serialized = stableStringify(value);
    return crypto.createHash("sha256").update(serialized).digest("hex");
}
function summarizeMessages(messages) {
    const messageFingerprints = messages.map((msg) => digest(msg));
    return {
        messageCount: messages.length,
        messageRoles: messages.map((msg) => msg.role),
        messageFingerprints,
        messagesDigest: digest(messageFingerprints.join("|")),
    };
}
export function createCacheTrace(params) {
    const cfg = resolveCacheTraceConfig(params);
    if (!cfg.enabled) {
        return null;
    }
    const writer = params.writer ?? getWriter(cfg.filePath);
    let seq = 0;
    const base = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        workspaceDir: params.workspaceDir,
    };
    const recordStage = (stage, payload = {}) => {
        const event = {
            ...base,
            ts: new Date().toISOString(),
            seq: (seq += 1),
            stage,
        };
        if (payload.prompt !== undefined && cfg.includePrompt) {
            event.prompt = payload.prompt;
        }
        if (payload.system !== undefined && cfg.includeSystem) {
            event.system = payload.system;
            event.systemDigest = digest(payload.system);
        }
        if (payload.options) {
            event.options = payload.options;
        }
        if (payload.model) {
            event.model = payload.model;
        }
        const messages = payload.messages;
        if (Array.isArray(messages)) {
            const summary = summarizeMessages(messages);
            event.messageCount = summary.messageCount;
            event.messageRoles = summary.messageRoles;
            event.messageFingerprints = summary.messageFingerprints;
            event.messagesDigest = summary.messagesDigest;
            if (cfg.includeMessages) {
                event.messages = messages;
            }
        }
        if (payload.note) {
            event.note = payload.note;
        }
        if (payload.error) {
            event.error = payload.error;
        }
        const line = safeJsonStringify(event);
        if (!line) {
            return;
        }
        writer.write(`${line}\n`);
    };
    const wrapStreamFn = (streamFn) => {
        const wrapped = (model, context, options) => {
            recordStage("stream:context", {
                model: {
                    id: model?.id,
                    provider: model?.provider,
                    api: model?.api,
                },
                system: context.system,
                messages: context.messages ?? [],
                options: (options ?? {}),
            });
            return streamFn(model, context, options);
        };
        return wrapped;
    };
    return {
        enabled: true,
        filePath: cfg.filePath,
        recordStage,
        wrapStreamFn,
    };
}
