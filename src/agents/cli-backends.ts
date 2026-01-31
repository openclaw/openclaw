import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { normalizeProviderId } from "./model-selection.js";

export type ResolvedCliBackend = {
  id: string;
  config: CliBackendConfig;
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
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

const CURSOR_MODEL_ALIASES: Record<string, string> = {
  auto: "auto",
  opus: "opus-4.5",
  "opus-4.5": "opus-4.5",
  "opus-thinking": "opus-4.5-thinking",
  "opus-4.5-thinking": "opus-4.5-thinking",
  sonnet: "sonnet-4",
  "sonnet-4": "sonnet-4",
  "sonnet-thinking": "sonnet-4-thinking",
  "sonnet-4-thinking": "sonnet-4-thinking",
  gpt5: "gpt-5.2",
  "gpt-5": "gpt-5.2",
  "gpt-5.2": "gpt-5.2",
  codex: "gpt-5.2-codex",
  "gpt-5.2-codex": "gpt-5.2-codex",
  gemini: "gemini-3-pro",
  "gemini-3": "gemini-3-pro",
  "gemini-3-pro": "gemini-3-pro",
};

const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
  resumeArgs: [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--resume",
    "{sessionId}",
  ],
  output: "json",
  input: "arg",
  modelArg: "--model",
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: "--session-id",
  sessionMode: "always",
  sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "first",
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
  serialize: true,
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
};

const DEFAULT_CURSOR_BACKEND: CliBackendConfig = {
  command: "cursor",
  args: ["agent", "--print", "--output-format", "stream-json"],
  resumeArgs: ["agent", "--print", "--output-format", "stream-json", "--resume", "{sessionId}"],
  output: "jsonl",
  resumeOutput: "jsonl",
  input: "arg",
  modelArg: "--model",
  modelAliases: CURSOR_MODEL_ALIASES,
  sessionIdFields: ["chatId", "chat_id", "sessionId", "session_id"],
  sessionMode: "existing",
  serialize: true,
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
  };
}

export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
  const ids = new Set<string>([
    normalizeBackendKey("claude-cli"),
    normalizeBackendKey("codex-cli"),
    normalizeBackendKey("cursor-cli"),
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
  if (normalized === "cursor-cli") {
    const merged = mergeBackendConfig(DEFAULT_CURSOR_BACKEND, override);
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
