import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { getQueuedFileWriter } from "./queued-file-writer.js";
const writers = new Map();
const log = createSubsystemLogger("agent/anthropic-payload");
function resolvePayloadLogConfig(env) {
    const enabled = parseBooleanValue(env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG) ?? false;
    const fileOverride = env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
    const filePath = fileOverride
        ? resolveUserPath(fileOverride)
        : path.join(resolveStateDir(env), "logs", "anthropic-payload.jsonl");
    return { enabled, filePath };
}
function getWriter(filePath) {
    return getQueuedFileWriter(writers, filePath);
}
function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
        return String(error);
    }
    if (error && typeof error === "object") {
        return safeJsonStringify(error) ?? "unknown error";
    }
    return undefined;
}
function digest(value) {
    const serialized = safeJsonStringify(value);
    if (!serialized) {
        return undefined;
    }
    return crypto.createHash("sha256").update(serialized).digest("hex");
}
function isAnthropicModel(model) {
    return model?.api === "anthropic-messages";
}
function findLastAssistantUsage(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
            return msg.usage;
        }
    }
    return null;
}
export function createAnthropicPayloadLogger(params) {
    const env = params.env ?? process.env;
    const cfg = resolvePayloadLogConfig(env);
    if (!cfg.enabled) {
        return null;
    }
    const writer = getWriter(cfg.filePath);
    const base = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        workspaceDir: params.workspaceDir,
    };
    const record = (event) => {
        const line = safeJsonStringify(event);
        if (!line) {
            return;
        }
        writer.write(`${line}\n`);
    };
    const wrapStreamFn = (streamFn) => {
        const wrapped = (model, context, options) => {
            if (!isAnthropicModel(model)) {
                return streamFn(model, context, options);
            }
            const nextOnPayload = (payload) => {
                record({
                    ...base,
                    ts: new Date().toISOString(),
                    stage: "request",
                    payload,
                    payloadDigest: digest(payload),
                });
                options?.onPayload?.(payload);
            };
            return streamFn(model, context, {
                ...options,
                onPayload: nextOnPayload,
            });
        };
        return wrapped;
    };
    const recordUsage = (messages, error) => {
        const usage = findLastAssistantUsage(messages);
        const errorMessage = formatError(error);
        if (!usage) {
            if (errorMessage) {
                record({
                    ...base,
                    ts: new Date().toISOString(),
                    stage: "usage",
                    error: errorMessage,
                });
            }
            return;
        }
        record({
            ...base,
            ts: new Date().toISOString(),
            stage: "usage",
            usage,
            error: errorMessage,
        });
        log.info("anthropic usage", {
            runId: params.runId,
            sessionId: params.sessionId,
            usage,
        });
    };
    log.info("anthropic payload logger enabled", { filePath: writer.filePath });
    return { enabled: true, wrapStreamFn, recordUsage };
}
