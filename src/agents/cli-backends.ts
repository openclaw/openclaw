import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { normalizeProviderId } from "./model-selection.js";

export type ResolvedCliBackend = {
  id: string;
  config: CliBackendConfig;
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.6": "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.5": "sonnet",
  "sonnet-4.1": "sonnet",
  "sonnet-4.0": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: ["-p", "--output-format", "stream-json", "--dangerously-skip-permissions", "--verbose"],
  resumeArgs: [
    "-p",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--verbose",
    "--resume",
    "{sessionId}",
  ],
  output: "jsonl",
  input: "arg",
  modelArg: "--model",
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: "--session-id",
  sessionMode: "always",
  sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
  systemPromptArg: "--system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "always",
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
  serialize: true,
  usageFields: {
    input: ["input_tokens", "inputTokens"],
    output: ["output_tokens", "outputTokens"],
    cacheRead: ["cache_read_input_tokens", "cached_input_tokens", "cacheRead"],
    cacheWrite: ["cache_creation_input_tokens", "cache_write_input_tokens", "cacheWrite"],
    total: ["total_tokens", "total"],
  },
  streaming: true,
  streamingEventTypes: ["tool_use", "tool_result", "text", "result"],
  streamingFormat: {
    text: {
      eventTypes: ["assistant"],
      contentPath: "message.content",
      matchType: "text",
      textField: "text",
    },
    toolUse: {
      eventTypes: ["assistant"],
      contentPath: "message.content",
      matchType: "tool_use",
      idField: "id",
      nameField: "name",
      inputField: "input",
    },
    toolResult: {
      eventTypes: ["user"],
      contentPath: "message.content",
      matchType: "tool_result",
      idField: "tool_use_id",
      outputField: "content",
      isErrorField: "is_error",
    },
  },
};

const DEFAULT_CODEX_BACKEND: CliBackendConfig = {
  command: "codex",
  args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  resumeArgs: [
    "exec",
    "resume",
    "{sessionId}",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
  ],
  output: "jsonl",
  resumeOutput: "text",
  input: "arg",
  modelArg: "--model",
  sessionIdFields: ["thread_id"],
  sessionMode: "existing",
  imageArg: "--image",
  imageMode: "repeat",
  serialize: true,
  usageFields: {
    input: ["prompt_tokens", "input_tokens"],
    output: ["completion_tokens", "output_tokens"],
    total: ["total_tokens"],
  },
  streaming: true,
  streamingEventTypes: ["item", "turn.completed"],
  streamingFormat: {
    text: {
      eventTypes: ["item.completed"],
      contentPath: "item",
      matchType: "message",
      textField: "text",
    },
    toolUse: {
      eventTypes: ["item.created", "item.started"],
      contentPath: "item",
      matchType: "function_call",
      idField: "id",
      nameField: "name",
      inputField: "arguments",
    },
    toolResult: {
      eventTypes: ["item.completed"],
      contentPath: "item",
      matchType: "function_call_output",
      idField: "call_id",
      outputField: "output",
    },
  },
};

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    streaming: override.streaming ?? base.streaming,
    streamingEventTypes: override.streamingEventTypes ?? base.streamingEventTypes,
    streamingFormat: override.streamingFormat
      ? {
          text: { ...base.streamingFormat?.text, ...override.streamingFormat.text },
          toolUse: { ...base.streamingFormat?.toolUse, ...override.streamingFormat.toolUse },
          toolResult: {
            ...base.streamingFormat?.toolResult,
            ...override.streamingFormat.toolResult,
          },
        }
      : base.streamingFormat,
  };
}

export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
  const ids = new Set<string>([
    normalizeBackendKey("claude-cli"),
    normalizeBackendKey("codex-cli"),
  ]);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(configured)) {
    ids.add(normalizeBackendKey(key));
  }
  return ids;
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);

  if (normalized === "claude-cli") {
    const merged = mergeBackendConfig(DEFAULT_CLAUDE_BACKEND, override);
    const command = merged.command?.trim();
    if (!command) {
      return null;
    }
    return { id: normalized, config: { ...merged, command } };
  }
  if (normalized === "codex-cli") {
    const merged = mergeBackendConfig(DEFAULT_CODEX_BACKEND, override);
    const command = merged.command?.trim();
    if (!command) {
      return null;
    }
    return { id: normalized, config: { ...merged, command } };
  }

  if (!override) {
    return null;
  }
  const command = override.command?.trim();
  if (!command) {
    return null;
  }
  return { id: normalized, config: { ...override, command } };
}
