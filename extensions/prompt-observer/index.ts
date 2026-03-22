import {
  definePluginEntry,
  redactSensitiveText,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";

type PromptObserverMode = "summary" | "full";

type PromptObserverConfig = {
  mode?: PromptObserverMode;
  includeSystemPrompt?: boolean;
  includePrompt?: boolean;
  includeHistoryMessages?: boolean;
  includeLlmOutput?: boolean;
  includeToolResults?: boolean;
  includeBootstrapFiles?: boolean;
  redactSensitive?: boolean;
  maxCharsPerField?: number;
  maxHistoryMessages?: number;
  toolNames?: string[];
};

type ResolvedPromptObserverConfig = {
  mode: PromptObserverMode;
  includeSystemPrompt: boolean;
  includePrompt: boolean;
  includeHistoryMessages: boolean;
  includeLlmOutput: boolean;
  includeToolResults: boolean;
  includeBootstrapFiles: boolean;
  redactSensitive: boolean;
  maxCharsPerField: number;
  maxHistoryMessages: number;
  toolNames: Set<string>;
};

type BootstrapCacheEntry = {
  files: string[];
  updatedAt: number;
};

type ObserverLogger = Pick<OpenClawPluginApi["logger"], "info">;

const DEFAULT_TOOL_NAMES = ["memory_search", "memory_get", "web_search", "web_fetch"] as const;
const DEFAULT_MODE: PromptObserverMode = "summary";
const DEFAULT_MAX_CHARS_PER_FIELD = 8_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 12;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_KEYS = 50;
const DEFAULT_MAX_DEPTH = 6;
const MAX_BOOTSTRAP_CACHE_ENTRIES = 200;
const MAX_BOOTSTRAP_CACHE_AGE_MS = 60 * 60 * 1000;

const bootstrapFilesBySession = new Map<string, BootstrapCacheEntry>();

function resolveMode(value: unknown): PromptObserverMode {
  return value === "full" ? "full" : DEFAULT_MODE;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeToolNames(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set(DEFAULT_TOOL_NAMES);
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return new Set(normalized.length > 0 ? normalized : DEFAULT_TOOL_NAMES);
}

function resolvePromptObserverConfig(raw: unknown): ResolvedPromptObserverConfig {
  const config = raw && typeof raw === "object" ? (raw as PromptObserverConfig) : {};
  const mode = resolveMode(config.mode);
  return {
    mode,
    includeSystemPrompt:
      typeof config.includeSystemPrompt === "boolean"
        ? config.includeSystemPrompt
        : mode === "full",
    includePrompt:
      typeof config.includePrompt === "boolean" ? config.includePrompt : mode === "full",
    includeHistoryMessages:
      typeof config.includeHistoryMessages === "boolean"
        ? config.includeHistoryMessages
        : mode === "full",
    includeLlmOutput:
      typeof config.includeLlmOutput === "boolean" ? config.includeLlmOutput : false,
    includeToolResults:
      typeof config.includeToolResults === "boolean" ? config.includeToolResults : mode === "full",
    includeBootstrapFiles:
      typeof config.includeBootstrapFiles === "boolean" ? config.includeBootstrapFiles : true,
    redactSensitive: typeof config.redactSensitive === "boolean" ? config.redactSensitive : true,
    maxCharsPerField: clampInteger(
      config.maxCharsPerField,
      DEFAULT_MAX_CHARS_PER_FIELD,
      200,
      100_000,
    ),
    maxHistoryMessages: clampInteger(
      config.maxHistoryMessages,
      DEFAULT_MAX_HISTORY_MESSAGES,
      1,
      100,
    ),
    toolNames: normalizeToolNames(config.toolNames),
  };
}

function sanitizeTextForLog(
  text: string,
  config: Pick<ResolvedPromptObserverConfig, "maxCharsPerField" | "redactSensitive">,
): string {
  const redacted = config.redactSensitive ? redactSensitiveText(text) : text;
  if (redacted.length <= config.maxCharsPerField) {
    return redacted;
  }
  const hiddenChars = redacted.length - config.maxCharsPerField;
  return `${redacted.slice(0, config.maxCharsPerField)}… [truncated ${hiddenChars} chars]`;
}

function sanitizePrimitive(
  value: unknown,
  config: Pick<ResolvedPromptObserverConfig, "maxCharsPerField" | "redactSensitive">,
): unknown {
  if (typeof value === "string") {
    return sanitizeTextForLog(value, config);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  return undefined;
}

function sanitizeValueForLog(
  value: unknown,
  config: Pick<ResolvedPromptObserverConfig, "maxCharsPerField" | "redactSensitive">,
  state: {
    depth: number;
    seen: WeakSet<object>;
  } = { depth: 0, seen: new WeakSet<object>() },
): unknown {
  const primitive = sanitizePrimitive(value, config);
  if (primitive !== undefined) {
    return primitive;
  }
  if (Array.isArray(value)) {
    const next = value.slice(0, DEFAULT_MAX_ARRAY_ITEMS).map((entry) =>
      sanitizeValueForLog(entry, config, {
        depth: state.depth + 1,
        seen: state.seen,
      }),
    );
    if (value.length > DEFAULT_MAX_ARRAY_ITEMS) {
      next.push(`[truncated ${value.length - DEFAULT_MAX_ARRAY_ITEMS} items]`);
    }
    return next;
  }
  if (!value || typeof value !== "object") {
    return String(value);
  }
  if (state.seen.has(value)) {
    return "[circular]";
  }
  if (state.depth >= DEFAULT_MAX_DEPTH) {
    return "[max-depth]";
  }
  state.seen.add(value);
  const result: Record<string, unknown> = {};
  const objectEntries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of objectEntries.slice(0, DEFAULT_MAX_OBJECT_KEYS)) {
    result[key] = sanitizeValueForLog(entry, config, {
      depth: state.depth + 1,
      seen: state.seen,
    });
  }
  if (objectEntries.length > DEFAULT_MAX_OBJECT_KEYS) {
    result.__truncatedKeys = objectEntries.length - DEFAULT_MAX_OBJECT_KEYS;
  }
  return result;
}

function summarizeHistoryMessages(messages: unknown[]): {
  count: number;
  roleCounts: Record<string, number>;
  serializedChars: number;
} {
  const roleCounts: Record<string, number> = {};
  let serializedChars = 0;
  for (const entry of messages) {
    if (entry && typeof entry === "object") {
      const role = (entry as { role?: unknown }).role;
      if (typeof role === "string" && role.trim()) {
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      }
    }
    try {
      serializedChars += JSON.stringify(entry).length;
    } catch {
      serializedChars += String(entry).length;
    }
  }
  return { count: messages.length, roleCounts, serializedChars };
}

function sanitizeHistoryMessages(
  messages: unknown[],
  config: Pick<
    ResolvedPromptObserverConfig,
    "maxCharsPerField" | "maxHistoryMessages" | "redactSensitive"
  >,
): unknown[] {
  return messages.slice(-config.maxHistoryMessages).map((entry) =>
    sanitizeValueForLog(entry, {
      maxCharsPerField: config.maxCharsPerField,
      redactSensitive: config.redactSensitive,
    }),
  );
}

function shouldObserveTool(
  toolName: string,
  config: Pick<ResolvedPromptObserverConfig, "toolNames">,
): boolean {
  return config.toolNames.has(toolName);
}

function collectSessionKeys(params: { sessionId?: string; sessionKey?: string }): string[] {
  return [params.sessionId, params.sessionKey].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function pruneBootstrapCache(now: number): void {
  for (const [key, entry] of bootstrapFilesBySession) {
    if (now - entry.updatedAt > MAX_BOOTSTRAP_CACHE_AGE_MS) {
      bootstrapFilesBySession.delete(key);
    }
  }
  while (bootstrapFilesBySession.size > MAX_BOOTSTRAP_CACHE_ENTRIES) {
    const oldestKey = bootstrapFilesBySession.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    bootstrapFilesBySession.delete(oldestKey);
  }
}

function storeBootstrapFiles(params: {
  sessionId?: string;
  sessionKey?: string;
  files: string[];
}): void {
  const now = Date.now();
  pruneBootstrapCache(now);
  for (const key of collectSessionKeys(params)) {
    bootstrapFilesBySession.set(key, {
      files: [...params.files],
      updatedAt: now,
    });
  }
}

function resolveBootstrapFiles(params: {
  sessionId?: string;
  sessionKey?: string;
}): string[] | undefined {
  for (const key of collectSessionKeys(params)) {
    const entry = bootstrapFilesBySession.get(key);
    if (entry) {
      return [...entry.files];
    }
  }
  return undefined;
}

function emitObserverEvent(logger: ObserverLogger, payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function isAgentBootstrapEvent(event: {
  type?: unknown;
  action?: unknown;
  context?: unknown;
}): event is {
  type: "agent";
  action: "bootstrap";
  context: {
    bootstrapFiles: Array<{ path?: unknown }>;
    workspaceDir?: unknown;
    sessionKey?: unknown;
    sessionId?: unknown;
    agentId?: unknown;
  };
} {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return false;
  }
  const context = event.context;
  if (!context || typeof context !== "object") {
    return false;
  }
  return Array.isArray((context as { bootstrapFiles?: unknown }).bootstrapFiles);
}

export default definePluginEntry({
  id: "prompt-observer",
  name: "Prompt Observer",
  description: "Structured prompt, context, and tool observability for production debugging.",
  register(api: OpenClawPluginApi) {
    const config = resolvePromptObserverConfig(api.pluginConfig);

    if (config.includeBootstrapFiles) {
      api.registerHook(
        "agent:bootstrap",
        (event) => {
          if (!isAgentBootstrapEvent(event)) {
            return;
          }
          const bootstrapFiles = event.context.bootstrapFiles
            .map((file) => (typeof file?.path === "string" ? file.path.trim() : ""))
            .filter(Boolean);
          storeBootstrapFiles({
            sessionId:
              typeof event.context.sessionId === "string" ? event.context.sessionId : undefined,
            sessionKey:
              typeof event.context.sessionKey === "string" ? event.context.sessionKey : undefined,
            files: bootstrapFiles,
          });
          emitObserverEvent(api.logger, {
            event: "prompt_observer.bootstrap_files",
            pluginId: api.id,
            sessionId:
              typeof event.context.sessionId === "string" ? event.context.sessionId : undefined,
            sessionKey:
              typeof event.context.sessionKey === "string" ? event.context.sessionKey : undefined,
            agentId: typeof event.context.agentId === "string" ? event.context.agentId : undefined,
            workspaceDir:
              typeof event.context.workspaceDir === "string"
                ? event.context.workspaceDir
                : undefined,
            bootstrapFiles,
          });
        },
        {
          name: "prompt-observer-bootstrap-files",
          description: "Logs which bootstrap files were selected for the agent run.",
        },
      );
    }

    api.on("llm_input", (event, ctx) => {
      const payload: Record<string, unknown> = {
        event: "prompt_observer.llm_input",
        pluginId: api.id,
        mode: config.mode,
        runId: event.runId,
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        trigger: ctx.trigger,
        channelId: ctx.channelId,
        provider: event.provider,
        model: event.model,
        imagesCount: event.imagesCount,
        systemPromptChars: event.systemPrompt?.length ?? 0,
        promptChars: event.prompt.length,
        history: summarizeHistoryMessages(event.historyMessages),
      };

      const bootstrapFiles = resolveBootstrapFiles({
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
      });
      if (bootstrapFiles && bootstrapFiles.length > 0) {
        payload.bootstrapFiles = bootstrapFiles;
      }
      if (config.includeSystemPrompt && typeof event.systemPrompt === "string") {
        payload.systemPrompt = sanitizeTextForLog(event.systemPrompt, config);
      }
      if (config.includePrompt) {
        payload.prompt = sanitizeTextForLog(event.prompt, config);
      }
      if (config.includeHistoryMessages) {
        payload.historyMessages = sanitizeHistoryMessages(event.historyMessages, config);
      }

      emitObserverEvent(api.logger, payload);
    });

    api.on("before_tool_call", (event, ctx) => {
      if (!shouldObserveTool(event.toolName, config)) {
        return;
      }
      emitObserverEvent(api.logger, {
        event: "prompt_observer.before_tool_call",
        pluginId: api.id,
        toolName: event.toolName,
        runId: event.runId ?? ctx.runId,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        params: sanitizeValueForLog(event.params, config),
      });
    });

    api.on("after_tool_call", (event, ctx) => {
      if (!shouldObserveTool(event.toolName, config)) {
        return;
      }
      const payload: Record<string, unknown> = {
        event: "prompt_observer.after_tool_call",
        pluginId: api.id,
        toolName: event.toolName,
        runId: event.runId ?? ctx.runId,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        durationMs: event.durationMs,
        params: sanitizeValueForLog(event.params, config),
      };
      if (typeof event.error === "string" && event.error.trim()) {
        payload.error = sanitizeTextForLog(event.error, config);
      }
      if (config.includeToolResults && event.result !== undefined) {
        payload.result = sanitizeValueForLog(event.result, config);
      }
      emitObserverEvent(api.logger, payload);
    });

    if (config.includeLlmOutput) {
      api.on("llm_output", (event, ctx) => {
        emitObserverEvent(api.logger, {
          event: "prompt_observer.llm_output",
          pluginId: api.id,
          runId: event.runId,
          sessionId: event.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          provider: event.provider,
          model: event.model,
          usage: event.usage,
          assistantTexts: sanitizeValueForLog(event.assistantTexts, config),
          ...(event.lastAssistant !== undefined
            ? { lastAssistant: sanitizeValueForLog(event.lastAssistant, config) }
            : {}),
        });
      });
    }
  },
});
