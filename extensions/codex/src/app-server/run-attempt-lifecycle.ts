import fs from "node:fs/promises";
import path from "node:path";
import { emitAgentHarnessAttemptEvent } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  awaitAgentEndSideEffects,
  embeddedAgentLog,
  formatErrorMessage,
  runAgentEndSideEffects,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { codexWorkspaceDirCache } from "./workspace-dir-cache.js";

const CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN = 4;

export function shouldKeepCodexSharedAbortOpen(params: {
  trigger: EmbeddedRunAttemptParams["trigger"];
  result: EmbeddedRunAttemptResult;
  attemptSucceeded: boolean;
  explicitCancellationObserved: boolean;
}): boolean {
  const terminal = attemptTerminal.project(params.result.terminal);
  if (params.explicitCancellationObserved || terminal.aborted || terminal.externalAbort) {
    return false;
  }
  // Memory attempts are preparatory. Failed attempts can still enter runner
  // retries or model fallback. The reply orchestrator owns the shared terminal
  // freeze after those paths settle.
  return params.trigger === "memory" || !params.attemptSucceeded;
}

export function withCodexAppServerFastModeServiceTier(
  appServer: CodexAppServerRuntimeOptions,
  params: EmbeddedRunAttemptParams,
): CodexAppServerRuntimeOptions {
  const fastMode = typeof params.fastMode === "function" ? params.fastMode() : params.fastMode;
  const serviceTier =
    fastMode === undefined ? appServer.serviceTier : fastMode ? "priority" : undefined;
  if (serviceTier === appServer.serviceTier) {
    return appServer;
  }
  if (serviceTier) {
    return { ...appServer, serviceTier };
  }
  return { ...appServer, serviceTier: null };
}

export function estimateCodexAppServerProjectedTurnTokens(params: {
  prompt: string;
  developerInstructions?: string;
}): number {
  const inputChars = params.prompt.length + (params.developerInstructions?.length ?? 0);
  return Math.max(1, Math.ceil(inputChars / CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN));
}

export async function ensureCodexWorkspaceDirOnce(workspaceDir: string): Promise<void> {
  const normalized = path.resolve(workspaceDir);
  // Workspace teardown clears this cache before cleanup; never stat a stable path per turn.
  if (codexWorkspaceDirCache.has(normalized)) {
    return;
  }
  await fs.mkdir(normalized, { recursive: true });
  codexWorkspaceDirCache.add(normalized);
}

export function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): Promise<void> {
  return emitAgentHarnessAttemptEvent(params, event, {
    label: "codex app-server",
    log: embeddedAgentLog,
  });
}

type CodexAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

export async function runCodexAgentEndHook(
  params: EmbeddedRunAttemptParams,
  hookParams: CodexAgentEndHookParams,
): Promise<void> {
  const sideEffectParams = {
    ...hookParams,
    ctx: { ...hookParams.ctx, config: params.config },
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(sideEffectParams);
    return;
  }
  runAgentEndSideEffects(sideEffectParams);
}

export function reportCodexBackgroundCleanupFailure(
  params: EmbeddedRunAttemptParams,
  error: unknown,
): void {
  const message = formatErrorMessage(error);
  embeddedAgentLog.warn("codex native background work remains unsettled", {
    runId: params.runId,
    sessionId: params.sessionId,
    error: message,
  });
  void emitCodexAppServerEvent(params, {
    stream: "codex_app_server.lifecycle",
    data: { phase: "background_cleanup_failed", error: message },
  });
}
