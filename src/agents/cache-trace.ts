import crypto from "node:crypto";
import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
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
  tools?: unknown;
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
  includeTools: boolean;
  stages: string;
};

type CacheTraceWriter = QueuedFileWriter;

const writers = new Map<string, CacheTraceWriter>();

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
  const includeTools = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_TOOLS) ?? config?.includeTools;
  const stages = env.OPENCLAW_CACHE_TRACE_STAGES?.trim() ?? config?.stages;

  return {
    enabled,
    filePath,
    includeMessages: includeMessages ?? true,
    includePrompt: includePrompt ?? true,
    includeSystem: includeSystem ?? true,
    includeTools: includeTools ?? false,
    stages: stages ?? "",
  };
}

function getWriter(filePath: string): CacheTraceWriter {
  return getQueuedFileWriter(writers, filePath);
}

function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
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
  if (seen.has(value)) {
    return JSON.stringify("[Circular]");
  }
  seen.add(value);
  if (value instanceof Error) {
    return stableStringify(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      seen,
    );
  }
  if (value instanceof Uint8Array) {
    return stableStringify(
      {
        type: "Uint8Array",
        data: Buffer.from(value).toString("base64"),
      },
      seen,
    );
  }
  if (Array.isArray(value)) {
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stableStringify(entry, seen));
    }
    return `[${serializedEntries.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const serializedFields: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    serializedFields.push(`${JSON.stringify(key)}:${stableStringify(record[key], seen)}`);
  }
  return `{${serializedFields.join(",")}}`;
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

  const writer = params.writer ?? getWriter(cfg.filePath);
  let seq = 0;

  let stageFilter: RegExp | null = null;
  if (cfg.stages) {
    try {
      stageFilter = new RegExp(cfg.stages);
    } catch {
      stageFilter = null;
    }
  }

  const base: Omit<CacheTraceEvent, "ts" | "seq" | "stage"> = buildAgentTraceBase(params);

  const recordStage: CacheTrace["recordStage"] = (stage, payload = {}) => {
    if (stageFilter && !stageFilter.test(stage)) {
      return;
    }
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
    if (payload.tools !== undefined && cfg.includeTools) {
      event.tools = sanitizeDiagnosticPayload(payload.tools);
    }
    if (payload.options) {
      const options = sanitizeDiagnosticPayload(payload.options);
      if (options && typeof options === "object" && !Array.isArray(options)) {
        event.options = options as Record<string, unknown>;
      }
    }
    if (payload.model) {
      const modelInfo = sanitizeDiagnosticPayload(payload.model);
      if (modelInfo && typeof modelInfo === "object" && !Array.isArray(modelInfo)) {
        event.model = modelInfo as Record<string, unknown>;
      }
    }

    const messages = payload.messages;
    if (Array.isArray(messages)) {
      const summary = summarizeMessages(messages);
      event.messageCount = summary.messageCount;
      event.messageRoles = summary.messageRoles;
      event.messageFingerprints = summary.messageFingerprints;
      event.messagesDigest = summary.messagesDigest;
      if (cfg.includeMessages) {
        const tracedMessages = sanitizeDiagnosticPayload(messages);
        if (Array.isArray(tracedMessages)) {
          event.messages = tracedMessages as AgentMessage[];
        }
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
        tools?: unknown;
      };
      recordStage("stream:context", {
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
        system: traceContext.systemPrompt ?? traceContext.system,
        messages: traceContext.messages ?? [],
        tools: traceContext.tools,
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
