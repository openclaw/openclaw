/**
 * Adapter that wraps the SDK runner to produce results compatible with
 * the Pi Agent embedded runner result type.
 *
 * This allows the SDK runner to be used as a drop-in replacement in the
 * main agent dispatch path without changing the downstream reply pipeline.
 */

import type { ClawdbrainConfig } from "../../config/config.js";
import { logDebug, logInfo, logWarn } from "../../logger.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import {
  enrichProvidersWithAuthProfiles,
  resolveDefaultSdkProvider,
  type SdkProviderEntry,
} from "./sdk-runner.config.js";
import { runSdkAgent } from "./sdk-runner.js";
import { appendSdkTurnPairToSessionTranscript } from "./sdk-session-transcript.js";
import type { SdkConversationTurn, SdkRunnerResult } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// Async OAuth token resolution
// ---------------------------------------------------------------------------

/** Mapping of SDK provider keys to auth profile ids for async OAuth. */
const PROVIDER_AUTH_PROFILES: Record<string, string> = {
  zai: "zai:default",
  anthropic: "anthropic:default",
};

/**
 * Try to resolve an API key via async OAuth when sync enrichment didn't
 * produce a key. This handles OAuth token refresh flows that require
 * async operations (e.g., browser-based OAuth).
 */
async function tryAsyncOAuthResolution(
  entry: SdkProviderEntry,
  params: { config?: ClawdbrainConfig; agentDir?: string },
): Promise<SdkProviderEntry> {
  // Only attempt if we still don't have an auth token.
  if (entry.config.env?.ANTHROPIC_AUTH_TOKEN) return entry;

  const profileId = PROVIDER_AUTH_PROFILES[entry.key];
  if (!profileId) return entry;

  let store;
  try {
    store = ensureAuthProfileStore(params.agentDir);
  } catch {
    return entry;
  }

  try {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.config,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) {
      logDebug(`[sdk-runner-adapter] Resolved API key via async OAuth for ${entry.key}`);
      return {
        ...entry,
        config: {
          ...entry.config,
          env: {
            ...entry.config.env,
            ANTHROPIC_AUTH_TOKEN: resolved.apiKey,
          },
        },
      };
    }
  } catch (err) {
    logWarn(`[sdk-runner-adapter] Async OAuth resolution failed for ${entry.key}: ${String(err)}`);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// SDK result → Pi result adapter
// ---------------------------------------------------------------------------

/**
 * Convert an `SdkRunnerResult` into an `EmbeddedPiRunResult` so the
 * downstream reply pipeline can consume it without changes.
 */
function adaptSdkResultToPiResult(params: {
  result: SdkRunnerResult;
  sessionId: string;
}): EmbeddedPiRunResult {
  const result = params.result;
  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.meta.durationMs,
      aborted: result.meta.aborted,
      agentMeta: {
        sessionId: params.sessionId,
        provider: result.meta.provider ?? "sdk",
        model: result.meta.model ?? "default",
      },
      // SDK runner errors are rendered as text payloads with isError=true.
      // Avoid mapping to Pi-specific error kinds (context/compaction) because
      // downstream recovery logic would treat them incorrectly.
      error: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Main adapter entry point
// ---------------------------------------------------------------------------

export type RunSdkAgentAdaptedParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbrainConfig;
  prompt: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  conversationHistory?: SdkConversationTurn[];
  hooksEnabled?: boolean;
  sdkOptions?: Record<string, unknown>;

  // Tools are lazily built to avoid import cycles.
  tools: AnyAgentTool[];

  // Callbacks (subset matching Pi Agent runner).
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
};

/**
 * Run the SDK agent and return a Pi-compatible result.
 *
 * This is the function called from `agent-runner-execution.ts` when the
 * SDK runtime is selected.
 */
export async function runSdkAgentAdapted(
  params: RunSdkAgentAdaptedParams,
): Promise<EmbeddedPiRunResult> {
  // Resolve the SDK provider from config + auth profiles.
  let authStore;
  try {
    authStore = ensureAuthProfileStore(params.agentDir);
  } catch {
    logDebug("[sdk-runner-adapter] Could not load auth profile store");
  }

  let providerEntry = resolveDefaultSdkProvider({
    config: params.config,
  });

  // Enrich with auth profile keys.
  if (providerEntry && authStore) {
    const enriched = enrichProvidersWithAuthProfiles({
      providers: [providerEntry],
      store: authStore,
    });
    providerEntry = enriched[0] ?? providerEntry;
  }

  // Fall back to async OAuth resolution if sync enrichment didn't produce a key.
  if (providerEntry && !providerEntry.config.env?.ANTHROPIC_AUTH_TOKEN) {
    providerEntry = await tryAsyncOAuthResolution(providerEntry, {
      config: params.config,
      agentDir: params.agentDir,
    });
  }

  logInfo(
    `[sdk-runner-adapter] Running SDK agent` +
      (providerEntry ? ` with provider "${providerEntry.config.name}"` : " (default provider)"),
  );

  const sdkResult = await runSdkAgent({
    runId: params.runId,
    sessionId: params.sessionId,
    prompt: params.prompt,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config,
    tools: params.tools,
    provider: providerEntry?.config,
    systemPrompt: params.extraSystemPrompt,
    timeoutMs: params.timeoutMs,
    abortSignal: params.abortSignal,
    conversationHistory: params.conversationHistory,
    hooksEnabled: params.hooksEnabled,
    sdkOptions: params.sdkOptions,
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onToolResult: params.onToolResult,
    onAgentEvent: params.onAgentEvent,
  });

  // Persist a minimal user/assistant turn pair so SDK main-agent mode has multi-turn continuity.
  // This intentionally records only text, not tool call structures.
  appendSdkTurnPairToSessionTranscript({
    sessionFile: params.sessionFile,
    prompt: params.prompt,
    assistantText: sdkResult.payloads.find(
      (p) => !p.isError && typeof p.text === "string" && p.text.trim(),
    )?.text,
  });

  return adaptSdkResultToPiResult({ result: sdkResult, sessionId: params.sessionId });
}
