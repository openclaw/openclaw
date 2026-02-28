import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClaudeSdkConfigSchema,
  type ClaudeSdkConfig,
} from "../../config/zod-schema.agent-runtime.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import type { ResolvedProviderAuth } from "../model-auth.js";
import { log } from "../pi-embedded-runner/logger.js";
import type { EmbeddedRunAttemptParams } from "../pi-embedded-runner/run/types.js";
import { resolveClaudeConfigDir } from "./config.js";
import { createClaudeSdkSession } from "./create-session.js";
import type { ClaudeSdkCompatibleTool, ClaudeSdkSession } from "./types.js";

const CLAUDE_SDK_RESUME_SESSION_KEY = "openclaw:claude-sdk-session-id";

type ClaudeSessionManagerLike = {
  appendCustomEntry?: (key: string, value: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appendMessage?: (message: any) => string;
};

/** @internal Exported for testing only. */
export function resolveClaudeSdkConfig(
  params: EmbeddedRunAttemptParams,
  agentId: string,
): ClaudeSdkConfig | undefined {
  const agentEntry = params.config?.agents?.list?.find((a) => a.id === agentId);
  if (agentEntry?.claudeSdk === false) {
    return undefined;
  }
  const defaultsCfg = params.config?.agents?.defaults?.claudeSdk;
  const agentCfg =
    agentEntry?.claudeSdk && typeof agentEntry.claudeSdk === "object"
      ? agentEntry.claudeSdk
      : undefined;
  const merged =
    agentCfg && defaultsCfg && typeof defaultsCfg === "object"
      ? { ...defaultsCfg, ...agentCfg }
      : (agentCfg ?? defaultsCfg);
  if (!merged || typeof merged !== "object") {
    return undefined;
  }
  // Validate merged config. On failure fall back to Pi runtime rather than
  // running with a corrupted config.
  const parseResult = ClaudeSdkConfigSchema.safeParse(merged);
  if (!parseResult.success || !parseResult.data) {
    log.warn(
      `claudeSdk config validation failed after merge: ${parseResult.success ? "empty result" : parseResult.error.message}`,
    );
    return undefined;
  }
  return parseResult.data;
}

/**
 * Resolve the path to the claude.json config file that the spawned Claude CLI
 * subprocess will read. Mirrors the CLI's own resolution logic:
 *   1. $CLAUDE_CONFIG_DIR/<profile>.json (or .claude.json)
 *   2. ~/.claude.json (default)
 */
function resolveSubprocessClaudeJsonPath(
  claudeSdkConfig?: Pick<ClaudeSdkConfig, "configDir">,
): string {
  const configDir = resolveClaudeConfigDir({ claudeSdkConfig });
  const base = configDir ?? os.homedir();
  // The CLI looks for .config.json first, then .claude.json. We check both in
  // the same order so our pre-flight matches what the subprocess actually reads.
  const dotConfig = path.join(base, ".config.json");
  if (fs.existsSync(dotConfig)) {
    return dotConfig;
  }
  return path.join(base, ".claude.json");
}

/**
 * Fail-fast guard: the Claude SDK subprocess manages its own context via
 * server-side sessions. If the user's claude.json has autoCompactEnabled=false,
 * the subprocess will never compact and context will grow until overflow. At
 * that point OpenClaw's Pi-based compaction cannot help (no API key for OAuth
 * providers, and local compaction doesn't affect the server-side history).
 *
 * Throws a descriptive error so the caller can fail over or surface a clear
 * message instead of silently burning tokens until the session dies.
 */
export function assertAutoCompactEnabled(
  claudeSdkConfig?: Pick<ClaudeSdkConfig, "configDir">,
): void {
  // Check 1: DISABLE_AUTO_COMPACT env var (CLI honors this independently of config).
  const disableEnv = process.env.DISABLE_AUTO_COMPACT?.trim().toLowerCase();
  if (disableEnv === "1" || disableEnv === "true" || disableEnv === "yes") {
    throw new Error(
      `Claude SDK runtime requires auto-compaction but the DISABLE_AUTO_COMPACT ` +
        `environment variable is set to "${process.env.DISABLE_AUTO_COMPACT}". ` +
        `The SDK subprocess manages its own server-side context and cannot operate ` +
        `without auto-compact. Unset DISABLE_AUTO_COMPACT to use the Claude SDK runtime.`,
    );
  }

  // Check 2: autoCompactEnabled in the claude.json the subprocess will read.
  const configPath = resolveSubprocessClaudeJsonPath(claudeSdkConfig);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist or unreadable — the CLI defaults to
    // autoCompactEnabled: true, so nothing to guard against.
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed JSON — let the CLI deal with it; not our guard to enforce.
    return;
  }
  if (parsed.autoCompactEnabled === false) {
    throw new Error(
      `Claude SDK runtime requires auto-compaction but the Claude CLI config ` +
        `at "${configPath}" has "autoCompactEnabled": false. The SDK subprocess ` +
        `manages its own server-side context and cannot operate without auto-compact. ` +
        `Set "autoCompactEnabled": true in "${configPath}" or remove the setting ` +
        `to use the default (enabled).`,
    );
  }
}

/**
 * Validates credentials and creates a ClaudeSdk session from attempt params.
 * Encapsulates all claude-sdk-specific session setup so attempt.ts stays clean.
 */
export async function prepareClaudeSdkSession(
  params: EmbeddedRunAttemptParams,
  claudeSdkConfig: ClaudeSdkConfig,
  resolvedProviderAuth: ResolvedProviderAuth | undefined,
  sessionManager: ClaudeSessionManagerLike,
  resolvedWorkspace: string,
  agentDir: string | undefined,
  systemPromptText: string,
  builtInTools: ClaudeSdkCompatibleTool[],
  allCustomTools: ClaudeSdkCompatibleTool[],
  forceFreshClaudeSession = false,
): Promise<ClaudeSdkSession> {
  // 0. Fail-fast: auto-compact must be enabled for SDK sessions.
  assertAutoCompactEnabled(claudeSdkConfig);

  // 1. Validate model ID — must use full Anthropic name (claude-* prefix).
  // The full ID (e.g. "claude-opus-4-6") is passed directly to the subprocess.
  if (!params.modelId.startsWith("claude-")) {
    throw new Error(
      `claude-sdk runtime requires a full Anthropic model ID (must start with "claude-"). ` +
        `Got: "${params.modelId}". Use the full model name, e.g. "claude-sonnet-4-5".`,
    );
  }

  // 2. Load resume session ID from SessionManager.
  // SessionManager.getCustomEntry() does not exist in pi-coding-agent; read via
  // getEntries() and search for the latest matching custom entry instead.
  // The entry's data field holds the session ID string (not `value`).
  const allEntries = sessionManager.getEntries?.() ?? [];
  const claudeSdkEntry = [...allEntries]
    .toReversed()
    .find((e) => e.type === "custom" && e.customType === CLAUDE_SDK_RESUME_SESSION_KEY);
  let claudeSdkResumeSessionId =
    typeof claudeSdkEntry?.data === "string" ? claudeSdkEntry.data : undefined;
  if (forceFreshClaudeSession && claudeSdkResumeSessionId) {
    try {
      sessionManager.appendCustomEntry?.(CLAUDE_SDK_RESUME_SESSION_KEY, null);
      sessionManager.appendCustomEntry?.("openclaw:claude-sdk-stale-resume-recovered", {
        timestamp: Date.now(),
        staleSessionId: claudeSdkResumeSessionId,
        runId: params.runId,
        sessionId: params.sessionId,
      });
    } catch {
      // Non-fatal — stale marker clear failures are handled by caller-level retries.
    }
    claudeSdkResumeSessionId = undefined;
  }

  // 3. Create and return the session
  return createClaudeSdkSession({
    workspaceDir: resolvedWorkspace,
    agentDir,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    runId: params.runId,
    attemptNumber: params.attemptNumber,
    diagnosticsEnabled: isDiagnosticsEnabled(params.config),
    modelId: params.modelId,
    provider: params.provider,
    tools: builtInTools,
    customTools: allCustomTools,
    systemPrompt: systemPromptText,
    modelCost: params.model.cost,
    // Explicit user directive (anything other than the "off" default) takes precedence
    // over the config-level thinkingDefault. If no directive was given, the config acts
    // as the agent-level default, falling back to the runtime "off" if unset.
    // TODO: explicit user "off" is indistinguishable from the default "off", so
    // thinkingDefault can override an explicit user choice. Proper fix requires
    // threading `thinkLevelExplicit` from message parsing.
    thinkLevel:
      params.thinkLevel !== "off"
        ? params.thinkLevel
        : (claudeSdkConfig.thinkingDefault ?? params.thinkLevel),
    extraParams: params.streamParams as Record<string, unknown> | undefined,
    sessionManager,
    claudeSdkResumeSessionId,
    claudeSdkConfig,
    resolvedProviderAuth,
  });
}
