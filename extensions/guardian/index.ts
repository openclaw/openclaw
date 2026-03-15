import { getModels as piGetModels } from "@mariozechner/pi-ai";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { callGuardian } from "./guardian-client.js";
import {
  getAllTurns,
  getAgentSystemPrompt,
  getLastSummarizedTurnCount,
  getRecentTurns,
  getSummary,
  getTotalTurns,
  hasSession,
  isSystemTrigger as isSystemTriggerForSession,
  isSummaryInProgress,
  markSummaryComplete,
  markSummaryInProgress,
  setAgentSystemPrompt,
  setLastSummarizedTurnCount,
  updateCache,
  updateSummary,
} from "./message-cache.js";
import { buildGuardianSystemPrompt, buildGuardianUserPrompt } from "./prompt.js";
import { generateSummary, shouldUpdateSummary } from "./summary.js";
import type { ConversationTurn, GuardianConfig, ResolvedGuardianModel } from "./types.js";
import { parseModelRef, resolveConfig, resolveGuardianModelRef } from "./types.js";

/**
 * OpenClaw Guardian Plugin
 *
 * Intercepts tool calls via the `before_tool_call` hook and sends them to an
 * external LLM for intent-alignment review. Blocks calls that the user never
 * requested — the primary defense against prompt injection attacks that trick
 * the agent into calling tools on behalf of injected instructions.
 *
 * The guardian model is configured the same way as the main agent model:
 *   model: "provider/model"  (e.g. "kimi/moonshot-v1-8k", "ollama/llama3.1:8b")
 * If omitted, falls back to the main agent model.
 *
 * Architecture (dual-hook design):
 * 1. `llm_input` hook  — caches recent user messages by sessionKey
 * 2. `before_tool_call` — reads cache, calls guardian LLM, returns ALLOW/BLOCK
 */
const guardianPlugin = {
  id: "guardian",
  name: "Guardian",
  description:
    "LLM-based intent-alignment review for tool calls — blocks actions the user never requested",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------
    // 1. Resolve configuration
    // -----------------------------------------------------------------
    const config = resolveConfig(api.pluginConfig);
    const openclawConfig = api.config;
    const runtime = api.runtime;

    // Resolve which model to use
    const modelRef = resolveGuardianModelRef(config, openclawConfig);
    if (!modelRef) {
      api.logger.warn(
        "Guardian plugin disabled: no model configured. " +
          "Set 'model' in plugin config (e.g. 'kimi/moonshot-v1-8k') " +
          "or configure a main agent model in agents.defaults.model.primary.",
      );
      return;
    }

    const parsed = parseModelRef(modelRef);
    if (!parsed) {
      api.logger.warn(
        `Guardian plugin disabled: invalid model reference '${modelRef}'. ` +
          "Expected format: 'provider/model' (e.g. 'kimi/moonshot-v1-8k').",
      );
      return;
    }

    // Resolve the model through OpenClaw's model resolution pipeline.
    // This may return a partial model (no baseUrl) if the provider is not
    // explicitly configured — the SDK will resolve it lazily.
    const resolvedModel = resolveModelFromConfig(parsed.provider, parsed.modelId, openclawConfig);

    api.logger.info(
      `Guardian plugin enabled: mode=${config.mode}, model=${modelRef}, ` +
        `api=${resolvedModel.api}, baseUrl=${resolvedModel.baseUrl ?? "(pending SDK resolution)"}, ` +
        `watched_tools=[${config.watched_tools.join(", ")}], ` +
        `fallback=${config.fallback_on_error}, timeout=${config.timeout_ms}ms`,
    );

    // Build the watched tools set for O(1) lookup
    const watchedTools = new Set(config.watched_tools.map((t) => t.toLowerCase()));

    // Pre-build the static system prompt
    const systemPrompt = buildGuardianSystemPrompt();

    // -----------------------------------------------------------------
    // Lazy resolution — resolves provider info (baseUrl, api type) and
    // API key from OpenClaw's auth pipeline on first tool call.
    // Plugin register() is synchronous so we defer the async calls.
    // -----------------------------------------------------------------
    let resolutionAttempted = false;

    async function ensureProviderResolved(): Promise<boolean> {
      if (resolutionAttempted) return !!resolvedModel.baseUrl;
      resolutionAttempted = true;

      // --- Resolve provider info (baseUrl, api type) from config ---
      if (!resolvedModel.baseUrl) {
        api.logger.warn(
          `[guardian] Provider not fully resolved: provider=${resolvedModel.provider} ` +
            `has no baseUrl. Configure models.providers.${resolvedModel.provider}.baseUrl ` +
            `in openclaw.json. Guardian will not function.`,
        );
        return false;
      }

      // --- Resolve API key via SDK ---
      if (!resolvedModel.apiKey) {
        try {
          const auth = await runtime.modelAuth.resolveApiKeyForProvider({
            provider: resolvedModel.provider,
            cfg: openclawConfig,
          });
          if (auth.apiKey) {
            resolvedModel.apiKey = auth.apiKey;
          }
          api.logger.info(
            `[guardian] Auth resolved via SDK: provider=${resolvedModel.provider}, ` +
              `source=${auth.source}, mode=${auth.mode}`,
          );
        } catch (err) {
          api.logger.warn(
            `[guardian] Auth resolution failed for provider=${resolvedModel.provider}: ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `Guardian may fail with auth errors.`,
          );
        }
      } else {
        api.logger.info(
          `[guardian] Using API key from config for provider=${resolvedModel.provider}`,
        );
      }

      return true;
    }

    // Build the context tools set for O(1) lookup
    const contextToolsSet = new Set(config.context_tools.map((t) => t.toLowerCase()));

    // -----------------------------------------------------------------
    // 2. Register llm_input hook — cache messages + trigger async summary
    // -----------------------------------------------------------------
    api.on("llm_input", (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      // Store live reference (lazy extraction happens at before_tool_call time)
      const totalTurns = updateCache(
        sessionKey,
        event.historyMessages,
        event.prompt,
        config.max_recent_turns,
        contextToolsSet,
      );

      // Trigger async summary update if needed (fire-and-forget).
      // Skip for system triggers (heartbeat, cron) — they don't contain
      // meaningful user requests and would pollute the summary.
      if (
        !isSystemTriggerForSession(sessionKey) &&
        shouldUpdateSummary(
          totalTurns,
          config.max_recent_turns,
          isSummaryInProgress(sessionKey),
          getLastSummarizedTurnCount(sessionKey),
        )
      ) {
        // Get all turns for summary input (older turns beyond the recent window)
        const allTurns = getAllTurns(sessionKey);
        const turnsForSummary = allTurns.slice(0, -config.max_recent_turns);

        if (turnsForSummary.length > 0) {
          markSummaryInProgress(sessionKey);

          const existingSummary = getSummary(sessionKey);

          // Ensure provider + API key are resolved before calling LLM.
          // ensureProviderResolved() is idempotent and cached after first call.
          ensureProviderResolved()
            .then((resolved) => {
              if (!resolved) {
                api.logger.warn("[guardian] Summary skipped: provider not resolved");
                return undefined;
              }
              return generateSummary({
                model: resolvedModel,
                existingSummary,
                turns: turnsForSummary,
                timeoutMs: config.timeout_ms,
                logger: config.log_decisions ? api.logger : undefined,
              });
            })
            .then((newSummary) => {
              // Discard summaries that are just heartbeat noise
              if (newSummary && /^heartbeat_ok$/i.test(newSummary.trim())) {
                if (config.log_decisions) {
                  api.logger.info(
                    `[guardian] Summary discarded (heartbeat noise) for session=${sessionKey}`,
                  );
                }
                return;
              }
              // Only update when we got a genuinely new/changed summary
              if (newSummary && newSummary !== existingSummary) {
                // Check if session was evicted during async summary generation
                if (!hasSession(sessionKey)) {
                  api.logger.warn(
                    `[guardian] Summary discarded: session=${sessionKey} was evicted during generation`,
                  );
                  return;
                }
                updateSummary(sessionKey, newSummary);
                setLastSummarizedTurnCount(sessionKey, totalTurns);
                if (config.log_decisions) {
                  api.logger.info(
                    `[guardian] Summary updated for session=${sessionKey}: "${newSummary.slice(0, 100)}..."`,
                  );
                }
              }
            })
            .catch((err) => {
              api.logger.warn(
                `[guardian] Summary generation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
            .finally(() => {
              // Always reset in-progress flag, even on failure or no-op.
              // Without this, a failed/empty summary locks out future attempts.
              markSummaryComplete(sessionKey);
            });
        }
      }

      // Cache the agent's system prompt (once per session, on first llm_input)
      const agentSystemPrompt = (event as Record<string, unknown>).systemPrompt;
      if (typeof agentSystemPrompt === "string" && agentSystemPrompt.length > 0) {
        setAgentSystemPrompt(sessionKey, agentSystemPrompt);
      }
    });

    // -----------------------------------------------------------------
    // 3. Register before_tool_call hook — review tool calls
    // -----------------------------------------------------------------
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        // Lazily resolve provider info + API key on first invocation
        const resolved = await ensureProviderResolved();
        if (!resolved) {
          // Provider could not be resolved — use fallback policy
          return config.fallback_on_error === "block"
            ? { block: true, blockReason: "Guardian provider not resolved" }
            : undefined;
        }

        return reviewToolCall(
          config,
          resolvedModel,
          watchedTools,
          systemPrompt,
          event,
          ctx,
          api.logger,
        );
      },
      { priority: 100 },
    );
  },
};

// ---------------------------------------------------------------------------
// Model resolution — extracts baseUrl/apiKey/api from OpenClaw config
// ---------------------------------------------------------------------------

/**
 * Resolve a provider/model pair into initial connection details using
 * OpenClaw's inline models configuration.
 *
 * This checks `config.models.providers[provider]` for baseUrl, apiKey,
 * and API type. If no explicit config exists, returns a partial model
 * that will be completed lazily via `ensureProviderResolved()` on the
 * first tool call (using the SDK's `resolveProviderInfo`).
 *
 * This design avoids hardcoding a list of well-known providers —
 * the SDK reads from the authoritative models.json written by OpenClaw's
 * startup pipeline, which includes all built-in and implicit providers.
 */

/** Extract only plain-string header values, skipping SecretRef objects. */
function extractStringHeaders(
  ...sources: (Record<string, unknown> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasAny = false;
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (typeof value === "string") {
        merged[key] = value;
        hasAny = true;
      }
    }
  }
  return hasAny ? merged : undefined;
}

function resolveModelFromConfig(
  provider: string,
  modelId: string,
  config?: OpenClawConfig,
): ResolvedGuardianModel {
  const providers = config?.models?.providers ?? {};
  const providerConfig = providers[provider];

  if (providerConfig?.baseUrl) {
    // Found an explicit provider configuration with baseUrl
    const modelDef = providerConfig.models?.find((m) => m.id === modelId);

    return {
      provider,
      modelId,
      baseUrl: providerConfig.baseUrl,
      apiKey: typeof providerConfig.apiKey === "string" ? providerConfig.apiKey : undefined,
      api: modelDef?.api || providerConfig.api || "openai-completions",
      headers: extractStringHeaders(providerConfig.headers, modelDef?.headers),
    };
  }

  // No explicit provider config — try pi-ai's built-in model database.
  // This covers well-known providers (anthropic, openai, google, etc.)
  // that don't need explicit baseUrl config.
  try {
    const knownModels = piGetModels(provider as Parameters<typeof piGetModels>[0]);
    if (knownModels.length > 0) {
      const match = knownModels.find((m) => m.id === modelId) ?? knownModels[0];
      return {
        provider,
        modelId,
        baseUrl: match.baseUrl,
        api: match.api,
        headers: extractStringHeaders(providerConfig?.headers, match.headers),
      };
    }
  } catch {
    // Provider not in pi-ai's database — fall through
  }

  return {
    provider,
    modelId,
    api: providerConfig?.api || "openai-completions",
    headers: extractStringHeaders(providerConfig?.headers),
  };
}

// ---------------------------------------------------------------------------
// Decision cache — deduplicates guardian calls within the same LLM turn
// ---------------------------------------------------------------------------
const DECISION_CACHE_TTL_MS = 5_000;

type CachedDecision = {
  action: "allow" | "block";
  reason?: string;
  cachedAt: number;
};

const decisionCache = new Map<string, CachedDecision>();
const MAX_DECISION_CACHE_SIZE = 256;

function getCachedDecision(key: string): CachedDecision | undefined {
  const entry = decisionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > DECISION_CACHE_TTL_MS) {
    decisionCache.delete(key);
    return undefined;
  }
  return entry;
}

function setCachedDecision(key: string, action: "allow" | "block", reason?: string): void {
  decisionCache.set(key, { action, reason, cachedAt: Date.now() });

  // Evict oldest entries using FIFO (insertion order) when cache exceeds max size.
  // Not true LRU — Map iterates in insertion order, not access order.
  // Acceptable since the 5s TTL + 256 max entries bounds memory growth.
  while (decisionCache.size > MAX_DECISION_CACHE_SIZE) {
    const oldest = decisionCache.keys().next().value;
    if (oldest) {
      decisionCache.delete(oldest);
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Core review logic
// ---------------------------------------------------------------------------

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};

type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

async function reviewToolCall(
  config: GuardianConfig,
  model: ResolvedGuardianModel,
  watchedTools: Set<string>,
  systemPrompt: string,
  event: BeforeToolCallEvent,
  ctx: ToolContext,
  logger: Logger,
): Promise<BeforeToolCallResult | void> {
  const toolNameLower = event.toolName.toLowerCase();

  // 1. Skip unwatched tools immediately
  if (!watchedTools.has(toolNameLower)) {
    return undefined; // allow
  }

  const sessionKey = ctx.sessionKey ?? "unknown";

  // 2. Skip system triggers (heartbeat, cron, etc.) — trusted events
  if (isSystemTriggerForSession(sessionKey)) {
    if (config.log_decisions) {
      logger.info(`[guardian] ALLOW (system trigger) tool=${event.toolName} session=${sessionKey}`);
    }
    return undefined;
  }

  // 3. Check decision cache (dedup within same LLM turn)
  const cacheKey = `${sessionKey}:${toolNameLower}`;
  const cached = getCachedDecision(cacheKey);
  if (cached) {
    if (config.log_decisions) {
      if (cached.action === "block") {
        logger.error(
          `[guardian] ██ BLOCKED (cached) ██ tool=${event.toolName} ` +
            `session=${sessionKey}${cached.reason ? ` reason="${cached.reason}"` : ""}`,
        );
      } else {
        logger.info(
          `[guardian] ${cached.action.toUpperCase()} (cached) tool=${event.toolName} ` +
            `session=${sessionKey}${cached.reason ? ` reason="${cached.reason}"` : ""}`,
        );
      }
    }
    if (cached.action === "block" && config.mode === "enforce") {
      return { block: true, blockReason: `Guardian: ${cached.reason || "blocked (cached)"}` };
    }
    return undefined;
  }

  // 4. Retrieve cached conversation context
  const turns = getRecentTurns(sessionKey);
  const summary = getSummary(sessionKey);
  const agentSystemPrompt = getAgentSystemPrompt(sessionKey);

  if (turns.length === 0 && !summary && sessionKey === "unknown") {
    if (config.log_decisions) {
      logger.info(
        `[guardian] ${config.fallback_on_error.toUpperCase()} (no session context) ` +
          `tool=${event.toolName}`,
      );
    }
    if (config.fallback_on_error === "block" && config.mode === "enforce") {
      return { block: true, blockReason: "Guardian: no session context available" };
    }
    return undefined;
  }

  // 5. Build the guardian prompt
  const userPrompt = buildGuardianUserPrompt(
    agentSystemPrompt,
    summary,
    turns,
    event.toolName,
    event.params,
    config.max_arg_length,
  );

  if (config.log_decisions) {
    logger.info(
      `[guardian] Reviewing tool=${event.toolName} session=${sessionKey} ` +
        `turns=${turns.length}${summary ? ` summary="${summary.slice(0, 100)}..."` : ""} ` +
        `params=${JSON.stringify(event.params).slice(0, 200)}`,
    );
  }

  // 6. Call the guardian LLM (pass logger for detailed debug output)
  const decision = await callGuardian({
    model,
    systemPrompt,
    userPrompt,
    timeoutMs: config.timeout_ms,
    fallbackOnError: config.fallback_on_error,
    logger: config.log_decisions ? logger : undefined,
  });

  // 7. Cache BLOCK decisions only — ALLOW decisions must not be cached
  // because different arguments to the same tool may have different risk
  // levels (e.g. exec("ls") vs exec("rm -rf /")).
  if (decision.action === "block") {
    setCachedDecision(cacheKey, decision.action, decision.reason);
  }

  // 8. Log the decision
  if (config.log_decisions) {
    if (decision.action === "block") {
      // Log BLOCK prominently with full conversation context
      logBlockDecision(
        logger,
        decision,
        event,
        sessionKey,
        turns,
        summary,
        agentSystemPrompt,
        config.mode,
      );
    } else {
      logger.info(
        `[guardian] ${decision.action.toUpperCase()} tool=${event.toolName} ` +
          `session=${sessionKey}${decision.reason ? ` reason="${decision.reason}"` : ""}`,
      );
    }
  }

  // 9. Return the decision
  if (decision.action === "block") {
    if (config.mode === "enforce") {
      return { block: true, blockReason: `Guardian: ${decision.reason || "blocked"}` };
    }
  }

  return undefined; // allow
}

// ---------------------------------------------------------------------------
// Block decision logging — prominent output with full conversation context
// ---------------------------------------------------------------------------

function logBlockDecision(
  logger: Logger,
  decision: { action: string; reason?: string },
  event: BeforeToolCallEvent,
  sessionKey: string,
  turns: ConversationTurn[],
  summary: string | undefined,
  agentSystemPrompt: string | undefined,
  mode: "enforce" | "audit",
): void {
  const modeLabel = mode === "enforce" ? "BLOCKED" : "AUDIT-ONLY (would block)";

  // Format agent context section (truncated for log readability)
  const contextBlock = agentSystemPrompt
    ? `  ${agentSystemPrompt.slice(0, 500)}${agentSystemPrompt.length > 500 ? "...(truncated in log)" : ""}`
    : "  (none)";

  // Format summary section
  const summaryBlock = summary ? `  ${summary}` : "  (no summary yet)";

  // Format conversation turns
  const turnLines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.assistant) {
      turnLines.push(`  [${i + 1}] Assistant: ${turn.assistant}`);
    }
    turnLines.push(`  [${i + 1}] User: ${turn.user}`);
  }
  const conversationBlock =
    turnLines.length > 0 ? turnLines.join("\n") : "  (no conversation context)";

  // Format tool args
  let argsStr: string;
  try {
    argsStr = JSON.stringify(event.params, null, 2);
  } catch {
    argsStr = "(unable to serialize)";
  }

  const lines = [
    ``,
    `[guardian] ████████████████████████████████████████████████`,
    `[guardian] ██ ${modeLabel} ██`,
    `[guardian] ████████████████████████████████████████████████`,
    `[guardian]   Tool:    ${event.toolName}`,
    `[guardian]   Session: ${sessionKey}`,
    `[guardian]   Reason:  ${decision.reason || "blocked"}`,
    `[guardian]`,
    `[guardian]   ── Agent context ──`,
    ...contextBlock.split("\n").map((l) => `[guardian] ${l}`),
    `[guardian]`,
    `[guardian]   ── Session summary ──`,
    ...summaryBlock.split("\n").map((l) => `[guardian] ${l}`),
    `[guardian]`,
    `[guardian]   ── Recent conversation turns ──`,
    ...conversationBlock.split("\n").map((l) => `[guardian] ${l}`),
    `[guardian]`,
    `[guardian]   ── Tool arguments ──`,
    ...argsStr.split("\n").map((l) => `[guardian]   ${l}`),
    `[guardian] ████████████████████████████████████████████████`,
    ``,
  ];

  for (const line of lines) {
    logger.error(line);
  }
}

export default guardianPlugin;

// Exported for testing
export const __testing = {
  reviewToolCall,
  resolveModelFromConfig,
  decisionCache,
  getCachedDecision,
  setCachedDecision,
};
