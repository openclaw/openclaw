import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import type { AgentMessage, StreamFn } from "./agent-core-contract.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import type { Api, Model } from "./pi-ai-contract.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { getStateDiagnosticWriter } from "./state-diagnostic-writer.js";

type PayloadLogStage = "request" | "usage";

type PayloadLogEvent = {
  ts: string;
  stage: PayloadLogStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  payload?: unknown;
  usage?: Record<string, unknown>;
  error?: string;
  payloadDigest?: string;
};

type PayloadLogConfig = {
  enabled: boolean;
  filePath: string;
  fileOverride: boolean;
};

type PayloadLogWriter = QueuedFileWriter;

const writers = new Map<string, PayloadLogWriter>();
const stateWriters = new Map<string, PayloadLogWriter>();
const log = createSubsystemLogger("agent/anthropic-payload");
const ANTHROPIC_PAYLOAD_SQLITE_LABEL = "sqlite://state/diagnostics/anthropic-payload";
const ANTHROPIC_PAYLOAD_SQLITE_SCOPE = "diagnostics.anthropic_payload";

function resolvePayloadLogConfig(env: NodeJS.ProcessEnv): PayloadLogConfig {
  const enabled = parseBooleanValue(env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG) ?? false;
  const fileOverride = env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
  const filePath = fileOverride ? resolveUserPath(fileOverride) : ANTHROPIC_PAYLOAD_SQLITE_LABEL;
  return { enabled, filePath, fileOverride: Boolean(fileOverride) };
}

function getWriter(cfg: PayloadLogConfig, env: NodeJS.ProcessEnv): PayloadLogWriter {
  if (cfg.fileOverride) {
    return getQueuedFileWriter(writers, cfg.filePath);
  }
  return getStateDiagnosticWriter(stateWriters, {
    env,
    label: cfg.filePath,
    scope: ANTHROPIC_PAYLOAD_SQLITE_SCOPE,
  });
}

function formatError(error: unknown): string | undefined {
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

function digest(value: unknown): string | undefined {
  const serialized = safeJsonStringify(value);
  if (!serialized) {
    return undefined;
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function isAnthropicModel(model: Model<Api> | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "anthropic-messages";
}

function findLastAssistantUsage(messages: AgentMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: unknown; usage?: unknown };
    if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
      return msg.usage as Record<string, unknown>;
    }
  }
  return null;
}

type AnthropicPayloadLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};

export function createAnthropicPayloadLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: PayloadLogWriter;
}): AnthropicPayloadLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolvePayloadLogConfig(env);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg, env);
  const base: Omit<PayloadLogEvent, "ts" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const record = (event: PayloadLogEvent) => {
    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: AnthropicPayloadLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      if (!isAnthropicModel(model)) {
        return streamFn(model, context, options);
      }
      const nextOnPayload = (payload: unknown) => {
        const redactedPayload = sanitizeDiagnosticPayload(payload);
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "request",
          payload: redactedPayload,
          payloadDigest: digest(redactedPayload),
        });
        return options?.onPayload?.(payload, model);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  const recordUsage: AnthropicPayloadLogger["recordUsage"] = (messages, error) => {
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
