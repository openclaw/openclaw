/**
 * Adapter that wraps the SDK runner to produce results compatible with
 * the Pi Agent embedded runner result type.
 *
 * This allows the SDK runner to be used as a drop-in replacement in the
 * main agent dispatch path without changing the downstream reply pipeline.
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { logDebug, logInfo } from "../../logger.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import { enrichProvidersWithAuthProfiles, resolveDefaultSdkProvider } from "./sdk-runner.config.js";
import { runSdkAgent } from "./sdk-runner.js";
import type { SdkConversationTurn, SdkRunnerResult } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// SDK result → Pi result adapter
// ---------------------------------------------------------------------------

/**
 * Convert an `SdkRunnerResult` into an `EmbeddedPiRunResult` so the
 * downstream reply pipeline can consume it without changes.
 */
function adaptSdkResultToPiResult(result: SdkRunnerResult): EmbeddedPiRunResult {
  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.meta.durationMs,
      aborted: result.meta.aborted,
      error: result.meta.error
        ? { kind: "compaction_failure" as const, message: result.meta.error.message }
        : undefined,
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
  config?: ClawdbotConfig;
  prompt: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  conversationHistory?: SdkConversationTurn[];

  // Tools are lazily built to avoid import cycles.
  tools: AnyAgentTool[];

  // Callbacks (subset matching Pi Agent runner).
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
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
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onToolResult: params.onToolResult,
    onAgentEvent: params.onAgentEvent,
  });

  return adaptSdkResultToPiResult(sdkResult);
}
