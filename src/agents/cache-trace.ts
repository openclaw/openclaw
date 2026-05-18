import crypto from "node:crypto";
import path from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { stableStringify } from "./stable-stringify.js";
import { buildAgentTraceBase } from "./trace-base.js";

type CacheTraceStage =
  | "cache:result"
  | "cache:state"
  | "session:loaded"
  | "session:raw-model-run"
  | "session:sanitized"
  | "session:limited"
  | "prompt:before"
  | "prompt:images"
  | "stream:context"
  | "session:after";

type CacheTraceEvent = {
  ts: string;
  seq: number;
  stage: CacheTraceStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  prompt?: string;
  system?: unknown;
  options?: Record<string, unknown>;
  model?: Record<string, unknown>;
  messages?: AgentMessage[];
  messageCount?: number;
  messageRoles?: Array<string | undefined>;
  messageFingerprints?: string[];
  messagesDigest?: string;
  systemDigest?: string;
  note?: string;
  error?: string;
};

type CacheTrace = {
  enabled: true;
  filePath: string;
  recordStage: (stage: CacheTraceStage, payload?: Partial<CacheTraceEvent>) => void;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

type CacheTraceInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: CacheTraceWriter;
};

type CacheTraceConfig = {
  enabled: boolean;
  filePath: string;
  includeMessages: boolean;
  includePrompt: boolean;
  includeSystem: boolean;
  maxFileBytes: number;
  maxFiles: number;
  maxQueuedBytes: number | undefined;
};

type CacheTraceWriter = QueuedFileWriter;

const writers = new Map<string, CacheTraceWriter>();

// Default cap: cache tracing is a debugging diagnostic; bound the file so a long
// session does not silently fill the disk. 0 disables the cap explicitly.
const DEFAULT_CACHE_TRACE_MAX_FILE_BYTES = 50 * 1024 * 1024;

// Default archive depth: keep the active file plus two numeric-suffix backups
// (~150 MiB total at the default size). Set maxFiles to 0 to revert to the
// drop-on-cap behavior, or 1 to keep only the active file.
const DEFAULT_CACHE_TRACE_MAX_FILES = 3;

function parseNonNegativeIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function resolveCacheTraceConfig(params: CacheTraceInit): CacheTraceConfig {
  const env = params.env ?? process.env;
  const config = params.cfg?.diagnostics?.cacheTrace;
  const envEnabled = parseBooleanValue(env.OPENCLAW_CACHE_TRACE);
  const enabled = envEnabled ?? config?.enabled ?? false;
  const fileOverride = config?.filePath?.trim() || env.OPENCLAW_CACHE_TRACE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "cache-trace.jsonl");

  const includeMessages =
    parseBooleanValue(env.OPENCLAW_CACHE_TRACE_MESSAGES) ?? config?.includeMessages;
  const includePrompt = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_PROMPT) ?? config?.includePrompt;
  const includeSystem = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_SYSTEM) ?? config?.includeSystem;

  const maxFileBytesEnv = parseNonNegativeIntEnv(env.OPENCLAW_CACHE_TRACE_MAX_BYTES);
  const maxFileBytesConfig =
    typeof config?.maxFileBytes === "number" && Number.isFinite(config.maxFileBytes)
      ? Math.max(0, Math.floor(config.maxFileBytes))
      : undefined;
  const maxFileBytes = maxFileBytesEnv ?? maxFileBytesConfig ?? DEFAULT_CACHE_TRACE_MAX_FILE_BYTES;

  const maxFilesEnv = parseNonNegativeIntEnv(env.OPENCLAW_CACHE_TRACE_MAX_FILES);
  const maxFilesConfig =
    typeof config?.maxFiles === "number" && Number.isFinite(config.maxFiles)
      ? Math.max(0, Math.floor(config.maxFiles))
      : undefined;
  const maxFiles = maxFilesEnv ?? maxFilesConfig ?? DEFAULT_CACHE_TRACE_MAX_FILES;

  const maxQueuedBytesEnv = parseNonNegativeIntEnv(env.OPENCLAW_CACHE_TRACE_MAX_QUEUED_BYTES);
  const maxQueuedBytesConfig =
    typeof config?.maxQueuedBytes === "number" && Number.isFinite(config.maxQueuedBytes)
      ? Math.max(0, Math.floor(config.maxQueuedBytes))
      : undefined;
  const maxQueuedBytes = maxQueuedBytesEnv ?? maxQueuedBytesConfig;

  return {
    enabled,
    filePath,
    includeMessages: includeMessages ?? true,
    includePrompt: includePrompt ?? true,
    includeSystem: includeSystem ?? true,
    maxFileBytes,
    maxFiles,
    maxQueuedBytes,
  };
}

function getWriter(
  filePath: string,
  options: { maxFileBytes?: number; maxFiles?: number; maxQueuedBytes?: number } = {},
): CacheTraceWriter {
  // 0 means "no cap" in our public surface; translate to undefined so the
  // underlying writer skips the size check entirely.
  const maxFileBytes =
    options.maxFileBytes !== undefined && options.maxFileBytes > 0
      ? options.maxFileBytes
      : undefined;
  // 0 means "do not rotate, drop on cap" (legacy behavior). Anything >= 1 turns
  // on numeric-suffix archive rotation in the queued writer.
  const maxFiles =
    options.maxFiles !== undefined && options.maxFiles > 0 ? options.maxFiles : undefined;
  return getQueuedFileWriter(writers, filePath, {
    maxFileBytes,
    maxFiles,
    maxQueuedBytes: options.maxQueuedBytes,
  });
}

function digest(value: unknown): string {
  const serialized = stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function summarizeMessages(messages: AgentMessage[]): {
  messageCount: number;
  messageRoles: Array<string | undefined>;
  messageFingerprints: string[];
  messagesDigest: string;
} {
  const messageFingerprints = messages.map((msg) => digest(msg));
  return {
    messageCount: messages.length,
    messageRoles: messages.map((msg) => (msg as { role?: string }).role),
    messageFingerprints,
    messagesDigest: digest(messageFingerprints.join("|")),
  };
}

export function createCacheTrace(params: CacheTraceInit): CacheTrace | null {
  const cfg = resolveCacheTraceConfig(params);
  if (!cfg.enabled) {
    return null;
  }

  const writer =
    params.writer ??
    getWriter(cfg.filePath, {
      maxFileBytes: cfg.maxFileBytes,
      maxFiles: cfg.maxFiles,
      maxQueuedBytes: cfg.maxQueuedBytes,
    });
  let seq = 0;

  const base: Omit<CacheTraceEvent, "ts" | "seq" | "stage"> = buildAgentTraceBase(params);

  const recordStage: CacheTrace["recordStage"] = (stage, payload = {}) => {
    const event: CacheTraceEvent = {
      ...base,
      ts: new Date().toISOString(),
      seq: (seq += 1),
      stage,
    };

    if (payload.prompt !== undefined && cfg.includePrompt) {
      event.prompt = payload.prompt;
    }
    if (payload.system !== undefined && cfg.includeSystem) {
      event.system = sanitizeDiagnosticPayload(payload.system);
      event.systemDigest = digest(payload.system);
    }
    if (payload.options) {
      event.options = sanitizeDiagnosticPayload(payload.options) as Record<string, unknown>;
    }
    if (payload.model) {
      event.model = sanitizeDiagnosticPayload(payload.model) as Record<string, unknown>;
    }

    const messages = payload.messages;
    if (Array.isArray(messages)) {
      const summary = summarizeMessages(messages);
      event.messageCount = summary.messageCount;
      event.messageRoles = summary.messageRoles;
      event.messageFingerprints = summary.messageFingerprints;
      event.messagesDigest = summary.messagesDigest;
      if (cfg.includeMessages) {
        event.messages = sanitizeDiagnosticPayload(messages) as AgentMessage[];
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

  const wrapStreamFn: CacheTrace["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const traceContext = context as {
        messages?: AgentMessage[];
        system?: unknown;
        systemPrompt?: unknown;
      };
      recordStage("stream:context", {
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
        system: traceContext.systemPrompt ?? traceContext.system,
        messages: traceContext.messages ?? [],
        options: (options ?? {}) as Record<string, unknown>,
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
