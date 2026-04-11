import path from "node:path";
import { shouldLogVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { requestHeartbeatNow as requestHeartbeatNowImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  prependBootstrapPromptWarning,
} from "../bootstrap-budget.js";
import { makeBootstrapWarn } from "../bootstrap-files.js";
import { createCliJsonlStreamingParser, parseCliOutput, type CliOutput } from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  buildBootstrapContextFiles,
  classifyFailoverReason,
  getBootstrapProfileConfig,
  isContextOverflowError,
} from "../pi-embedded-helpers.js";
import { ENABLE_SEMANTIC_PROMPT_LOADER } from "./flags.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  buildSystemPrompt,
  resolveCliRunQueueKey,
  enqueueCliRun,
  loadPromptRefImages,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import {
  resolveClaudeSystemPromptFilePath,
  writeClaudeSystemPromptFile,
  buildClaudeSystemPromptCompletionPrompt,
  buildClaudeSystemPromptLoaderPrompt,
  type ClaudeSystemPromptChunk,
  PromptFileReadRequiredError,
  resolveReadToolRequest,
  estimatePromptTokens,
  ESTIMATED_TOKENS_PER_IMAGE,
} from "./prepare.js";
import {
  type SemanticPromptFiles,
  writeSemanticSessionFile,
  buildSemanticLoaderPrompt,
  buildSemanticCompletionPrompt,
  isExpectedSemanticPromptFile,
  resolveSemanticExpectedFiles,
} from "./semantic-prompt.js";
import type { PreparedCliRunContext } from "./types.js";

const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  enqueueSystemEvent: enqueueSystemEventImpl,
  requestHeartbeatNow: requestHeartbeatNowImpl,
};

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}

// ---------------------------------------------------------------------------
// Session prompt file state (Layer 1)
// ---------------------------------------------------------------------------

export type CliSessionBindingResult = {
  sessionId: string;
  systemPromptFile?: string;
  systemPromptHash?: string;
  systemPromptCompactionCount?: number;
  // Semantic prompt loader fields (coexist with legacy chunk-based fields)
  semanticContextFiles?: string[];
  semanticSessionFile?: string;
  semanticSessionHash?: string;
  semanticCompactionCount?: number;
};

export type CliPromptLoadResult = {
  sessionPromptFile?: string;
  currentSessionPromptFile?: string;
  sessionPromptFiles?: string[];
  loaderMode: "normal" | "strict" | "disabled";
  verifiedRead: boolean;
  chunkCount?: number;
  verifiedChunkCount?: number;
  fallbackReason?:
    | "write_failed"
    | "verification_retry"
    | "direct_injection_fallback"
    | "direct_fallback_disabled";
};

const ENABLE_DIRECT_SYSTEM_PROMPT_FALLBACK = false;
const MAX_COMPLETION_PROMPT_RETRIES = 5;

function formatCliLogValue(value: string | undefined, maxChars = 240): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "<empty>";
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function looksLikePartialReadToolResult(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return /\[(?:Read output capped at .*?Use offset=\d+ to continue\.|Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/i.test(
    text,
  );
}

function isCompletePromptFileRead(params: {
  partialReadRequest: boolean;
  eofMarker: string;
  startLine?: number;
  numLines?: number;
  totalLines?: number;
  text?: string;
}): boolean {
  if (params.partialReadRequest) {
    return false;
  }
  if (params.text?.includes(params.eofMarker)) {
    return true;
  }
  if (
    typeof params.startLine === "number" &&
    typeof params.numLines === "number" &&
    typeof params.totalLines === "number"
  ) {
    return params.startLine === 1 && params.numLines === params.totalLines;
  }
  return !looksLikePartialReadToolResult(params.text);
}

function resolveChunkIndexByPath(
  chunks: ClaudeSystemPromptChunk[],
  filePath: string | undefined,
): number | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalized = path.resolve(filePath);
  const chunk = chunks.find((entry) => path.resolve(entry.filePath) === normalized);
  return chunk?.index;
}

/**
 * Throws an AbortError when the given signal has already fired, so the
 * CLI runner's JS orchestration exits promptly on user /stop instead of
 * spawning another subprocess through the retry/recovery paths.
 *
 * Mirrors the embedded runner's `throwIfAborted` helper: preserves an
 * Error reason directly; otherwise constructs a new Error with
 * name = "AbortError" so downstream code recognises the abort uniformly.
 */
export function checkAbortSignal(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const err =
    reason !== undefined
      ? new Error("CLI runner aborted", { cause: reason })
      : new Error("CLI runner aborted");
  err.name = "AbortError";
  throw err;
}

/**
 * Wraps executePreparedCliRun with:
 *  - Layer 1: Session prompt file writing + loader prompt + read verification
 *  - Layer 2: Context overflow detection + /compact recovery + profile downgrade
 *
 * This is the function that cli-runner.ts should call instead of raw executePreparedCliRun.
 */
export async function executeWithOverflowProtection(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<{
  output: CliOutput;
  cliSessionBinding?: CliSessionBindingResult;
  cliPromptLoad?: CliPromptLoadResult;
  compactionsThisRun: number;
  systemPromptReport: typeof context.systemPromptReport;
}> {
  const params = context.params;
  let {
    systemPrompt,
    activeProfile,
    activeContextFiles: _activeContextFiles,
    systemPromptReport,
  } = context;
  let compactionsThisRun = 0;
  let latestCliSessionBinding: CliSessionBindingResult | undefined;
  let latestCliPromptLoad: CliPromptLoadResult | undefined;
  let latestPromptChunks: ClaudeSystemPromptChunk[] = [];
  const verifiedPromptChunkCounts = new Map<string, number>();
  let latestSemanticFiles: SemanticPromptFiles | undefined;
  const verifiedPromptFileSets = new Map<string, Set<string>>();
  const buildCliPromptLoadState = (params: {
    sessionPromptFile?: string;
    currentSessionPromptFile?: string;
    loaderMode: "normal" | "strict" | "disabled";
    verifiedRead: boolean;
    fallbackReason?:
      | "write_failed"
      | "verification_retry"
      | "direct_injection_fallback"
      | "direct_fallback_disabled";
    verifiedChunkCount?: number;
  }): CliPromptLoadResult => ({
    ...(params.sessionPromptFile ? { sessionPromptFile: params.sessionPromptFile } : {}),
    ...(params.currentSessionPromptFile
      ? { currentSessionPromptFile: params.currentSessionPromptFile }
      : {}),
    ...(latestPromptChunks.length > 0
      ? { sessionPromptFiles: latestPromptChunks.map((chunk) => chunk.filePath) }
      : {}),
    loaderMode: params.loaderMode,
    verifiedRead: params.verifiedRead,
    ...(latestPromptChunks.length > 0 ? { chunkCount: latestPromptChunks.length } : {}),
    ...(latestPromptChunks.length > 0
      ? {
          verifiedChunkCount: Math.min(
            params.verifiedChunkCount ?? (params.verifiedRead ? latestPromptChunks.length : 0),
            latestPromptChunks.length,
          ),
        }
      : {}),
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
  });
  const resolveCurrentPromptFileForSession = (sessionId?: string): string | undefined => {
    const normalizedSessionId = sessionId?.trim();
    const chunkIndex = normalizedSessionId
      ? (verifiedPromptChunkCounts.get(normalizedSessionId) ?? 0)
      : 0;
    return latestPromptChunks[chunkIndex]?.filePath ?? latestPromptChunks[0]?.filePath;
  };

  // Inner function: execute with a given session and loader mode, handling
  // prompt file writing and read verification for Claude CLI.
  const executeCliWithSession = async (
    sessionId: string | undefined,
    promptOverride: string | undefined,
    isSystemCall: boolean,
    forceReloadSystemPromptFile: boolean,
    loaderPromptMode: "normal" | "strict" | "disabled",
  ): Promise<CliOutput> => {
    // Single choke point for every subprocess spawn in this module (main run,
    // loader retries, strict/disabled fallbacks, overflow-recovery /compact,
    // profile downgrade retry). Checking abort here stops the JS orchestration
    // from issuing a fresh spawn after the supervisor killed the previous
    // subprocess via /stop → abortSessionExecutions → cancelSession.
    checkAbortSignal(params.abortSignal);
    const backend = context.preparedBackend.backend;
    const currentCompactionCount =
      Math.max(0, params.sessionCompactionCount ?? 0) + compactionsThisRun;
    const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
      backend,
      cliSessionId: sessionId,
    });
    const useResume = Boolean(
      sessionId && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );
    let verifiedPromptChunkCount = resolvedSessionId
      ? (verifiedPromptChunkCounts.get(resolvedSessionId) ?? 0)
      : 0;

    let systemPromptToSend: string | undefined = systemPrompt;
    let cliSystemPromptFile:
      | { filePath: string; hash: string; chunks: ClaudeSystemPromptChunk[] }
      | undefined;
    let loaderFallbackReason:
      | "write_failed"
      | "verification_retry"
      | "direct_injection_fallback"
      | "direct_fallback_disabled"
      | undefined;
    let promptFileTrustedFromBinding = false;
    let promptFileReadAttempted = false;
    let promptFileReadAttemptedPartially = false;
    let promptFileReadErrored = false;
    const promptFileReadRequests = new Map<
      string,
      {
        filePath: string;
        partialReadRequest: boolean;
        chunkIndex: number;
      }
    >();
    const emittedToolStarts = new Set<string>();
    const cliDebugEnabled = cliBackendLog.isEnabled("debug");

    const matchingCliSessionBinding =
      params.cliSessionBinding &&
      params.cliSessionBinding.sessionId?.trim() &&
      params.cliSessionBinding.sessionId.trim() === sessionId?.trim()
        ? params.cliSessionBinding
        : undefined;

    // Layer 1: Write session prompt file and build loader prompt (Claude CLI only)
    if (context.isClaude && !isSystemCall && ENABLE_SEMANTIC_PROMPT_LOADER) {
      // Semantic prompt loader path: write one session file + reference workspace context files directly
      try {
        const semanticContextPaths = _activeContextFiles.map((f) => f.path);
        const semanticSessionResult = await writeSemanticSessionFile({
          sessionFile: params.sessionFile,
          sessionPromptContent: systemPrompt,
        });
        latestSemanticFiles = {
          contextFiles: semanticContextPaths,
          sessionFile: semanticSessionResult.filePath,
          sessionHash: semanticSessionResult.hash,
        };
        const reloadReason = (() => {
          if (!resolvedSessionId) {
            return undefined;
          }
          if (!useResume || !matchingCliSessionBinding?.sessionId?.trim()) {
            return "new-session" as const;
          }
          if (forceReloadSystemPromptFile) {
            return "compaction" as const;
          }
          const contextMatch =
            JSON.stringify(matchingCliSessionBinding.semanticContextFiles ?? []) ===
            JSON.stringify(latestSemanticFiles.contextFiles);
          if (!contextMatch) {
            return "prompt-changed" as const;
          }
          if (
            matchingCliSessionBinding.semanticSessionHash?.trim() !==
            latestSemanticFiles.sessionHash
          ) {
            return "prompt-changed" as const;
          }
          if ((matchingCliSessionBinding.semanticCompactionCount ?? 0) < currentCompactionCount) {
            return "compaction" as const;
          }
          return undefined;
        })();
        if (cliDebugEnabled) {
          cliBackendLog.debug("cli semantic prompt file prepared", {
            sessionId: resolvedSessionId ?? sessionId ?? null,
            useResume,
            loaderPromptMode,
            currentCompactionCount,
            forceReloadSystemPromptFile,
            sessionFile: latestSemanticFiles.sessionFile,
            sessionHash: latestSemanticFiles.sessionHash,
            contextFileCount: latestSemanticFiles.contextFiles.length,
            reloadReason: reloadReason ?? null,
          });
        }
        systemPromptToSend =
          loaderPromptMode === "disabled"
            ? systemPrompt
            : reloadReason
              ? buildSemanticLoaderPrompt({
                  files: latestSemanticFiles,
                  reason: reloadReason,
                  strict: loaderPromptMode === "strict",
                })
              : undefined;
        promptFileTrustedFromBinding = Boolean(
          !reloadReason &&
          matchingCliSessionBinding?.semanticSessionFile?.trim() ===
            latestSemanticFiles.sessionFile &&
          matchingCliSessionBinding?.semanticSessionHash?.trim() ===
            latestSemanticFiles.sessionHash,
        );
      } catch (error) {
        cliBackendLog.warn(
          `failed to write semantic session prompt file; falling back to direct prompt: ${String(error)}`,
        );
        systemPromptToSend = systemPrompt;
        latestSemanticFiles = undefined;
        loaderFallbackReason = "write_failed";
      }
    } else if (context.isClaude && !isSystemCall) {
      try {
        cliSystemPromptFile = await writeClaudeSystemPromptFile({
          sessionFile: params.sessionFile,
          systemPrompt,
        });
        latestPromptChunks = cliSystemPromptFile.chunks;
        const reloadReason = (() => {
          if (!resolvedSessionId || !cliSystemPromptFile) {
            return undefined;
          }
          if (!useResume || !matchingCliSessionBinding?.sessionId?.trim()) {
            return "new-session" as const;
          }
          if (forceReloadSystemPromptFile) {
            return "compaction" as const;
          }
          if (matchingCliSessionBinding.systemPromptFile?.trim() !== cliSystemPromptFile.filePath) {
            return "prompt-changed" as const;
          }
          if (matchingCliSessionBinding.systemPromptHash?.trim() !== cliSystemPromptFile.hash) {
            return "prompt-changed" as const;
          }
          if (
            (matchingCliSessionBinding.systemPromptCompactionCount ?? 0) < currentCompactionCount
          ) {
            return "compaction" as const;
          }
          return undefined;
        })();
        if (cliDebugEnabled) {
          cliBackendLog.debug("cli prompt file prepared", {
            sessionId: resolvedSessionId ?? sessionId ?? null,
            useResume,
            isSystemCall,
            loaderPromptMode,
            currentCompactionCount,
            forceReloadSystemPromptFile,
            promptFile: cliSystemPromptFile.filePath,
            promptHash: cliSystemPromptFile.hash,
            promptChars: systemPrompt.length,
            reloadReason: reloadReason ?? null,
            bindingSessionId: matchingCliSessionBinding?.sessionId ?? null,
            bindingPromptFile: matchingCliSessionBinding?.systemPromptFile ?? null,
            bindingPromptHash: matchingCliSessionBinding?.systemPromptHash ?? null,
            bindingCompactionCount: matchingCliSessionBinding?.systemPromptCompactionCount ?? null,
          });
        }
        systemPromptToSend =
          loaderPromptMode === "disabled"
            ? systemPrompt
            : reloadReason && cliSystemPromptFile
              ? buildClaudeSystemPromptLoaderPrompt({
                  chunks: cliSystemPromptFile.chunks,
                  reason: reloadReason,
                  strict: loaderPromptMode === "strict",
                })
              : undefined;
        promptFileTrustedFromBinding = Boolean(
          !reloadReason &&
          cliSystemPromptFile &&
          matchingCliSessionBinding?.systemPromptFile?.trim() === cliSystemPromptFile.filePath &&
          matchingCliSessionBinding?.systemPromptHash?.trim() === cliSystemPromptFile.hash,
        );
        if (cliDebugEnabled) {
          cliBackendLog.debug("cli loader prompt decision", {
            sessionId: resolvedSessionId ?? sessionId ?? null,
            loaderPromptMode,
            promptFile: cliSystemPromptFile.filePath,
            reloadReason: reloadReason ?? null,
            trustedFromBinding: promptFileTrustedFromBinding,
            systemPromptToSendChars: systemPromptToSend?.length ?? 0,
            directPromptInjection: loaderPromptMode === "disabled",
          });
        }
      } catch (error) {
        cliBackendLog.warn(
          `failed to write claude session prompt file (${resolveClaudeSystemPromptFilePath(params.sessionFile)}); falling back to direct prompt: ${String(error)}`,
        );
        systemPromptToSend = systemPrompt;
        cliSystemPromptFile = undefined;
        loaderFallbackReason = "write_failed";
      }
    }

    // Resolve the system prompt arg based on loader mode
    const systemPromptArg =
      context.isClaude && !isSystemCall
        ? systemPromptToSend?.trim() || null
        : resolveSystemPromptUsage({
            backend,
            isNewSession: isNew,
            systemPrompt: systemPromptToSend,
          });
    const mustVerifyPromptFileRead = Boolean(
      context.isClaude &&
      !isSystemCall &&
      (cliSystemPromptFile || (ENABLE_SEMANTIC_PROMPT_LOADER && latestSemanticFiles)) &&
      systemPromptToSend &&
      loaderPromptMode !== "disabled",
    );
    let promptFileReadVerified = false;
    if (cliDebugEnabled && context.isClaude && !isSystemCall) {
      cliBackendLog.debug("cli prompt verification state", {
        sessionId: resolvedSessionId ?? sessionId ?? null,
        loaderPromptMode,
        systemPromptArgMode:
          systemPromptArg === null
            ? "null"
            : typeof systemPromptArg === "string"
              ? "string"
              : "other",
        systemPromptArgChars: typeof systemPromptArg === "string" ? systemPromptArg.length : 0,
        mustVerifyPromptFileRead,
        promptFile: cliSystemPromptFile?.filePath ?? null,
        promptFileTrustedFromBinding,
      });
    }

    // Build images and prompt
    let imagePaths: string[] | undefined;
    let cleanupImages: (() => Promise<void>) | undefined;
    let prompt =
      promptOverride ??
      prependBootstrapPromptWarning(params.prompt, context.bootstrapPromptWarningLines, {
        preserveExactPrompt: context.heartbeatPrompt,
      });
    // On resume, Claude CLI does not accept --append-system-prompt, so
    // buildCliArgs will drop systemPromptToSend. When a reload is required
    // (compaction, prompt-changed), prepend the loader instruction to the
    // user message so the agent sees the "re-read files" directive on the
    // first call instead of only after a verification-retry round-trip.
    if (
      !promptOverride &&
      context.isClaude &&
      !isSystemCall &&
      useResume &&
      systemPromptToSend &&
      systemPromptToSend !== systemPrompt
    ) {
      prompt = `${systemPromptToSend}\n\n---\n\n${prompt}`;
    }
    const resolvedImages =
      !promptOverride && params.images && params.images.length > 0
        ? params.images
        : !promptOverride
          ? await loadPromptRefImages({ prompt, workspaceDir: context.workspaceDir })
          : [];
    if (resolvedImages.length > 0) {
      const imagePayload = await writeCliImages(resolvedImages);
      imagePaths = imagePayload.paths;
      cleanupImages = imagePayload.cleanup;
      if (!backend.imageArg) {
        prompt = appendImagePathsToPrompt(prompt, imagePaths);
      }
    }

    const { argsPrompt, stdin } = resolvePromptInput({ backend, prompt });
    const stdinPayload = stdin ?? "";
    const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
    const resolvedArgs = useResume
      ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
      : baseArgs;
    const args = buildCliArgs({
      backend,
      baseArgs: resolvedArgs,
      modelId: context.normalizedModel,
      sessionId: resolvedSessionId,
      systemPrompt: systemPromptArg,
      imagePaths,
      promptArg: argsPrompt,
      useResume,
    });

    const queueKey = resolveCliRunQueueKey({
      backendId: context.backendResolved.id,
      serialize: backend.serialize,
      runId: params.runId,
      workspaceDir: context.workspaceDir,
      cliSessionId: useResume ? resolvedSessionId : undefined,
    });

    try {
      const output = await enqueueCliRun(queueKey, async () => {
        cliBackendLog.debug("cli exec start", {
          provider: params.provider,
          model: context.normalizedModel,
          promptChars: params.prompt.length,
          useResume,
          sessionId: resolvedSessionId ?? sessionId ?? null,
          loaderPromptMode,
          promptFile: cliSystemPromptFile?.filePath ?? null,
          mustVerifyPromptFileRead,
        });
        const logOutputText =
          isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
          isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
        const logStreamingOutput = logOutputText || cliDebugEnabled;
        if (logOutputText) {
          const logArgs = buildCliLogArgs({
            args,
            systemPromptArg: backend.systemPromptArg,
            sessionArg: backend.sessionArg,
            modelArg: backend.modelArg,
            imageArg: backend.imageArg,
            argsPrompt,
          });
          cliBackendLog.debug("cli argv", {
            command: backend.command,
            argv: logArgs,
            sessionId: resolvedSessionId ?? sessionId ?? null,
          });
        } else if (cliDebugEnabled) {
          const logArgs = buildCliLogArgs({
            args,
            systemPromptArg: backend.systemPromptArg,
            sessionArg: backend.sessionArg,
            modelArg: backend.modelArg,
            imageArg: backend.imageArg,
            argsPrompt,
          });
          cliBackendLog.debug("cli argv prepared", {
            command: backend.command,
            argv: logArgs,
            useResume,
            resolvedSessionId: resolvedSessionId ?? null,
            cwd: context.workspaceDir,
            stdinChars: stdinPayload.length,
            promptArgChars: argsPrompt?.length ?? 0,
            imageCount: imagePaths?.length ?? 0,
            loaderPromptMode,
            promptFile: cliSystemPromptFile?.filePath ?? null,
            mustVerifyPromptFileRead,
          });
        }

        const env = (() => {
          const next = sanitizeHostExecEnv({
            baseEnv: process.env,
            blockPathOverrides: true,
          });
          for (const key of backend.clearEnv ?? []) {
            delete next[key];
          }
          if (backend.env && Object.keys(backend.env).length > 0) {
            Object.assign(
              next,
              sanitizeHostExecEnv({
                baseEnv: {},
                overrides: backend.env,
                blockPathOverrides: true,
              }),
            );
          }
          Object.assign(next, context.preparedBackend.env);
          // Defense in depth: when both ANTHROPIC_AUTH_TOKEN and
          // ANTHROPIC_API_KEY end up in the claude-cli child env (for example
          // a stale provider auto-inject colliding with an explicit
          // cliBackends auth token override), claude CLI would forward both
          // credentials as Authorization + x-api-key headers at once. Relays
          // may then pick the wrong one and surface opaque upstream failures.
          // The more specific AUTH_TOKEN wins; drop the duplicate API_KEY.
          if (
            context.backendResolved.id === "claude-cli" &&
            next.ANTHROPIC_AUTH_TOKEN &&
            next.ANTHROPIC_API_KEY
          ) {
            delete next.ANTHROPIC_API_KEY;
          }
          return next;
        })();
        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
        });
        const streamingParser =
          backend.output === "jsonl"
            ? createCliJsonlStreamingParser({
                backend,
                providerId: context.backendResolved.id,
                onSystemInit: ({ subtype, sessionId: initSessionId }) => {
                  params.onSystemInit?.({ subtype, sessionId: initSessionId });
                },
                onAssistantDelta: ({ text, delta }) => {
                  params.onAssistantTurn?.(delta);
                  if (cliDebugEnabled) {
                    cliBackendLog.debug("cli assistant delta", {
                      sessionId: resolvedSessionId ?? sessionId ?? null,
                      deltaChars: delta.length,
                      totalChars: text.length,
                      delta,
                    });
                  }
                },
                onThinkingDelta: ({ text, delta }) => {
                  params.onThinkingTurn?.({ text, delta });
                  if (cliDebugEnabled) {
                    cliBackendLog.debug("cli thinking delta", {
                      sessionId: resolvedSessionId ?? sessionId ?? null,
                      deltaChars: delta.length,
                      totalChars: text.length,
                      delta,
                    });
                  }
                },
                onToolUse: ({ name, toolUseId, input }) => {
                  const toolStartKey =
                    toolUseId?.trim() || `${name}:${JSON.stringify(input ?? null)}`;
                  if (!emittedToolStarts.has(toolStartKey)) {
                    emittedToolStarts.add(toolStartKey);
                    params.onToolUseEvent?.({ name, toolUseId, input });
                    cliBackendLog.info(
                      `cli tool start: ${name}${toolUseId ? ` (${toolUseId})` : ""}`,
                    );
                  }
                  if (
                    ENABLE_SEMANTIC_PROMPT_LOADER &&
                    mustVerifyPromptFileRead &&
                    latestSemanticFiles
                  ) {
                    // Semantic verifier: match against expected files set
                    if (promptFileReadVerified) {
                      return;
                    }
                    if (name !== "Read" && name !== "read") {
                      return;
                    }
                    const readRequest = resolveReadToolRequest(input);
                    const normalizedFilePath = readRequest.filePath
                      ? path.resolve(readRequest.filePath)
                      : undefined;
                    if (!normalizedFilePath) {
                      return;
                    }
                    const matchedPromptFile = isExpectedSemanticPromptFile(
                      latestSemanticFiles,
                      normalizedFilePath,
                    );
                    const partialReadRequest =
                      matchedPromptFile &&
                      ((typeof readRequest.offset === "number" && readRequest.offset > 1) ||
                        typeof readRequest.limit === "number");
                    if (cliDebugEnabled) {
                      cliBackendLog.debug("cli semantic verifier saw tool use", {
                        sessionId: resolvedSessionId ?? sessionId ?? null,
                        toolName: name,
                        filePath: normalizedFilePath,
                        matchedPromptFile,
                        partialReadRequest,
                        input,
                      });
                    }
                    if (matchedPromptFile && toolUseId?.trim()) {
                      promptFileReadAttempted = true;
                      promptFileReadAttemptedPartially = partialReadRequest;
                      promptFileReadRequests.set(toolUseId.trim(), {
                        filePath: normalizedFilePath,
                        partialReadRequest,
                        chunkIndex: 0, // unused in semantic path but required by type
                      });
                    }
                    return;
                  }
                  if (!(mustVerifyPromptFileRead && cliSystemPromptFile)) {
                    return;
                  }
                  const readRequest = resolveReadToolRequest(input);
                  const normalizedFilePath = readRequest.filePath
                    ? path.resolve(readRequest.filePath)
                    : undefined;
                  const chunkIndex = resolveChunkIndexByPath(
                    cliSystemPromptFile.chunks,
                    normalizedFilePath,
                  );
                  const matchedPromptFile = chunkIndex !== undefined;
                  const expectedPromptFile =
                    chunkIndex !== undefined
                      ? path.resolve(cliSystemPromptFile.chunks[chunkIndex]?.filePath ?? "")
                      : null;
                  const partialReadRequest =
                    matchedPromptFile &&
                    ((typeof readRequest.offset === "number" && readRequest.offset > 1) ||
                      typeof readRequest.limit === "number");
                  if (cliDebugEnabled) {
                    cliBackendLog.debug("cli loader verifier saw tool use", {
                      sessionId: resolvedSessionId ?? sessionId ?? null,
                      toolName: name,
                      filePath: normalizedFilePath ?? null,
                      expectedPromptFile,
                      matchedPromptFile,
                      partialReadRequest,
                      input,
                    });
                  }
                  if (promptFileReadVerified) {
                    return;
                  }
                  if (name !== "Read" && name !== "read") {
                    return;
                  }
                  if (matchedPromptFile) {
                    promptFileReadAttempted = true;
                    promptFileReadAttemptedPartially = partialReadRequest;
                    if (toolUseId?.trim() && chunkIndex !== undefined && expectedPromptFile) {
                      promptFileReadRequests.set(toolUseId.trim(), {
                        filePath: expectedPromptFile,
                        partialReadRequest,
                        chunkIndex,
                      });
                    }
                  }
                },
                onToolResult: ({ toolUseId, text, isError, startLine, numLines, totalLines }) => {
                  params.onToolResult?.({
                    toolUseId,
                    text,
                    isError,
                    startLine,
                    numLines,
                    totalLines,
                  });
                  cliBackendLog.info(
                    `cli tool result${toolUseId ? ` (${toolUseId})` : ""}: ${formatCliLogValue(text)}`,
                  );
                  if (
                    ENABLE_SEMANTIC_PROMPT_LOADER &&
                    mustVerifyPromptFileRead &&
                    latestSemanticFiles &&
                    toolUseId
                  ) {
                    // Semantic verifier: Set-based, no sequential order requirement
                    const request = promptFileReadRequests.get(toolUseId);
                    promptFileReadRequests.delete(toolUseId);
                    if (!request) {
                      return;
                    }
                    const expectedFiles = resolveSemanticExpectedFiles(latestSemanticFiles);
                    if (!expectedFiles.has(request.filePath)) {
                      return;
                    }
                    promptFileReadAttempted = true;
                    if (isError) {
                      // File not found or read error — treat as "confirmed absent"
                      // so we don't retry it endlessly. Add to verified set and move on.
                      let verifiedSet = verifiedPromptFileSets.get(resolvedSessionId ?? "");
                      if (!verifiedSet) {
                        verifiedSet = new Set();
                        if (resolvedSessionId) {
                          verifiedPromptFileSets.set(resolvedSessionId, verifiedSet);
                        }
                      }
                      verifiedSet.add(request.filePath);
                      promptFileReadVerified = verifiedSet.size >= expectedFiles.size;
                      return;
                    }
                    if (request.partialReadRequest) {
                      promptFileReadAttemptedPartially = true;
                      return;
                    }
                    // Guard against tool-side truncation (e.g., large file exceeding
                    // Read output limit) even when the request had no offset/limit.
                    if (looksLikePartialReadToolResult(text)) {
                      promptFileReadAttemptedPartially = true;
                      return;
                    }
                    // No sequential order check — just add to verified set.
                    let verifiedSet = verifiedPromptFileSets.get(resolvedSessionId ?? "");
                    if (!verifiedSet) {
                      verifiedSet = new Set();
                      if (resolvedSessionId) {
                        verifiedPromptFileSets.set(resolvedSessionId, verifiedSet);
                      }
                    }
                    verifiedSet.add(request.filePath);
                    promptFileReadVerified = verifiedSet.size >= expectedFiles.size;
                    return;
                  }
                  if (!(mustVerifyPromptFileRead && cliSystemPromptFile && toolUseId)) {
                    return;
                  }
                  const request = promptFileReadRequests.get(toolUseId);
                  promptFileReadRequests.delete(toolUseId);
                  if (!request) {
                    return;
                  }
                  const chunk = cliSystemPromptFile.chunks[request.chunkIndex];
                  if (!chunk) {
                    return;
                  }
                  const expectedPromptFile = path.resolve(chunk.filePath);
                  if (request.filePath !== expectedPromptFile) {
                    return;
                  }
                  promptFileReadAttempted = true;
                  if (isError) {
                    promptFileReadErrored = true;
                    return;
                  }
                  if (request.chunkIndex !== verifiedPromptChunkCount) {
                    promptFileReadAttemptedPartially = true;
                    return;
                  }
                  if (
                    !isCompletePromptFileRead({
                      partialReadRequest: request.partialReadRequest,
                      eofMarker: chunk.eofMarker,
                      startLine,
                      numLines,
                      totalLines,
                      text,
                    })
                  ) {
                    promptFileReadAttemptedPartially = true;
                    return;
                  }
                  verifiedPromptChunkCount += 1;
                  if (resolvedSessionId) {
                    verifiedPromptChunkCounts.set(resolvedSessionId, verifiedPromptChunkCount);
                  }
                  promptFileReadVerified =
                    verifiedPromptChunkCount >= cliSystemPromptFile.chunks.length;
                },
              })
            : null;
        const supervisor = executeDeps.getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: context.backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const managedRun = await supervisor.spawn({
          sessionId: params.sessionId,
          backendId: context.backendResolved.id,
          scopeKey,
          replaceExistingScope: Boolean(useResume && scopeKey),
          mode: "child",
          argv: [backend.command, ...args],
          timeoutMs: params.timeoutMs,
          noOutputTimeoutMs,
          cwd: context.workspaceDir,
          env,
          input: stdinPayload,
          onStdout: streamingParser
            ? (chunk: string) => {
                if (logStreamingOutput) {
                  cliBackendLog.debug("cli stdout chunk", {
                    sessionId: resolvedSessionId ?? sessionId ?? null,
                    chars: chunk.length,
                    chunk,
                  });
                }
                streamingParser.push(chunk);
              }
            : undefined,
        });
        const result = await managedRun.wait();
        streamingParser?.finish();
        if (cliDebugEnabled && mustVerifyPromptFileRead) {
          cliBackendLog.debug("cli loader verifier completed", {
            sessionId: resolvedSessionId ?? sessionId ?? null,
            loaderPromptMode,
            promptFile: cliSystemPromptFile?.filePath ?? null,
            promptFileReadVerified,
          });
        }

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) {
            cliBackendLog.debug(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            cliBackendLog.debug(`cli stderr:\n${stderr}`);
          }
        }
        if (shouldLogVerbose()) {
          if (stdout) {
            cliBackendLog.debug(`cli stdout:\n${stdout}`);
          } else if (cliDebugEnabled) {
            cliBackendLog.debug("cli stdout was empty", {
              sessionId: resolvedSessionId ?? sessionId ?? null,
            });
          }
          if (stderr) {
            cliBackendLog.debug(`cli stderr:\n${stderr}`);
          } else if (cliDebugEnabled) {
            cliBackendLog.debug("cli stderr was empty", {
              sessionId: resolvedSessionId ?? sessionId ?? null,
            });
          }
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            cliBackendLog.warn(
              `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              executeDeps.requestHeartbeatNow(
                scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
              );
            }
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("timeout"),
            });
          }
          const err = stderr || stdout || "CLI failed.";
          const reason = classifyFailoverReason(err, { provider: params.provider }) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            reason,
            provider: params.provider,
            model: context.modelId,
            status,
          });
        }

        const cliOutput = parseCliOutput({
          raw: stdout,
          backend,
          providerId: context.backendResolved.id,
          outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
          fallbackSessionId: resolvedSessionId,
        });
        cliBackendLog.info(
          `cli exec complete: provider=${params.provider} model=${context.modelId} session=${cliOutput.sessionId ?? resolvedSessionId ?? "new"} chars=${cliOutput.text.length}`,
        );

        // Layer 1: Verify prompt file was read
        if (mustVerifyPromptFileRead && !promptFileReadVerified) {
          if (ENABLE_SEMANTIC_PROMPT_LOADER && latestSemanticFiles) {
            const expectedFiles = resolveSemanticExpectedFiles(latestSemanticFiles);
            const verifiedSet =
              verifiedPromptFileSets.get(resolvedSessionId ?? "") ?? new Set<string>();
            const unverifiedPaths = [...expectedFiles].filter((p) => !verifiedSet.has(p));
            throw new PromptFileReadRequiredError({
              message: `Claude session did not verify a successful complete Read of the session prompt files.`,
              reason: promptFileReadErrored
                ? "read-error"
                : promptFileReadAttempted
                  ? "partial-read"
                  : "not-read",
              sessionId: cliOutput.sessionId ?? resolvedSessionId,
              promptFile: unverifiedPaths[0] ?? latestSemanticFiles.sessionFile,
              unverifiedPaths,
            });
          }
          const nextUnreadChunk =
            cliSystemPromptFile?.chunks[verifiedPromptChunkCount] ?? cliSystemPromptFile?.chunks[0];
          throw new PromptFileReadRequiredError({
            message: `Claude session did not verify a successful complete Read of ${cliSystemPromptFile?.filePath ?? "the session prompt file"}.`,
            reason: promptFileReadErrored
              ? "read-error"
              : promptFileReadAttempted || promptFileReadAttemptedPartially
                ? "partial-read"
                : "not-read",
            sessionId: cliOutput.sessionId ?? resolvedSessionId,
            promptFile: nextUnreadChunk?.filePath ?? cliSystemPromptFile?.filePath,
          });
        }

        // Track session binding metadata
        if (!isSystemCall && ENABLE_SEMANTIC_PROMPT_LOADER && latestSemanticFiles) {
          // Persist semantic binding fields when:
          //   (a) verification just passed, OR
          //   (b) verification was not required because the current binding already
          //       trusts this prompt (trust carry-over — keep the fields across
          //       trusted resumes so the next turn also skips re-reads).
          const persistSemanticMetadata =
            loaderPromptMode !== "disabled" &&
            (promptFileReadVerified ||
              (!mustVerifyPromptFileRead &&
                JSON.stringify(matchingCliSessionBinding?.semanticContextFiles ?? []) ===
                  JSON.stringify(latestSemanticFiles.contextFiles) &&
                matchingCliSessionBinding?.semanticSessionHash?.trim() ===
                  latestSemanticFiles.sessionHash));
          latestCliSessionBinding =
            cliOutput.sessionId || resolvedSessionId
              ? {
                  sessionId: cliOutput.sessionId ?? resolvedSessionId ?? "",
                  ...(persistSemanticMetadata
                    ? {
                        semanticContextFiles: latestSemanticFiles.contextFiles,
                        semanticSessionFile: latestSemanticFiles.sessionFile,
                        semanticSessionHash: latestSemanticFiles.sessionHash,
                        semanticCompactionCount:
                          currentCompactionCount > 0 ? currentCompactionCount : undefined,
                      }
                    : {}),
                }
              : undefined;
          latestCliPromptLoad = context.isClaude
            ? buildCliPromptLoadState({
                sessionPromptFile: latestSemanticFiles.sessionFile,
                currentSessionPromptFile: latestSemanticFiles.sessionFile,
                loaderMode: loaderPromptMode,
                verifiedRead: mustVerifyPromptFileRead
                  ? promptFileReadVerified
                  : promptFileTrustedFromBinding,
                fallbackReason: loaderFallbackReason,
              })
            : undefined;
        } else if (!isSystemCall) {
          const persistPromptFileMetadata =
            loaderPromptMode !== "disabled" &&
            Boolean(cliSystemPromptFile) &&
            (promptFileReadVerified ||
              (!mustVerifyPromptFileRead &&
                matchingCliSessionBinding?.systemPromptFile?.trim() ===
                  cliSystemPromptFile?.filePath &&
                matchingCliSessionBinding?.systemPromptHash?.trim() === cliSystemPromptFile?.hash));
          latestCliSessionBinding =
            cliOutput.sessionId || resolvedSessionId
              ? {
                  sessionId: cliOutput.sessionId ?? resolvedSessionId ?? "",
                  ...(persistPromptFileMetadata && cliSystemPromptFile
                    ? {
                        systemPromptFile: cliSystemPromptFile.filePath,
                        systemPromptHash: cliSystemPromptFile.hash,
                        systemPromptCompactionCount:
                          forceReloadSystemPromptFile || currentCompactionCount > 0
                            ? currentCompactionCount
                            : undefined,
                      }
                    : {}),
                }
              : undefined;
          latestCliPromptLoad = context.isClaude
            ? buildCliPromptLoadState({
                sessionPromptFile: cliSystemPromptFile?.filePath,
                currentSessionPromptFile:
                  verifiedPromptChunkCount < latestPromptChunks.length
                    ? latestPromptChunks[verifiedPromptChunkCount]?.filePath
                    : (latestPromptChunks.at(-1)?.filePath ?? cliSystemPromptFile?.filePath),
                loaderMode: loaderPromptMode,
                verifiedRead: mustVerifyPromptFileRead
                  ? promptFileReadVerified
                  : promptFileTrustedFromBinding,
                fallbackReason: loaderFallbackReason,
                verifiedChunkCount:
                  mustVerifyPromptFileRead && resolvedSessionId
                    ? (verifiedPromptChunkCounts.get(resolvedSessionId) ?? verifiedPromptChunkCount)
                    : promptFileTrustedFromBinding
                      ? latestPromptChunks.length
                      : 0,
              })
            : undefined;
        }

        return cliOutput;
      });
      return output;
    } finally {
      if (cleanupImages) {
        await cleanupImages();
      }
    }
  };

  // Layer 1 fallback chain: normal -> same-session completion retries -> strict -> disabled
  const executeCliWithLoaderFallback = async (runParams: {
    cliSessionId?: string;
    promptOverride?: string;
    isSystemCall?: boolean;
    forceReloadSystemPromptFile?: boolean;
  }) => {
    try {
      return await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "normal",
      );
    } catch (error) {
      if (!(error instanceof PromptFileReadRequiredError)) {
        throw error;
      }
      if (error.sessionId?.trim() && error.promptFile?.trim()) {
        let completionError: PromptFileReadRequiredError = error;
        let completionAttempt = 0;
        while (
          completionAttempt < MAX_COMPLETION_PROMPT_RETRIES &&
          completionError.sessionId?.trim() &&
          completionError.promptFile?.trim()
        ) {
          const completionSessionId = completionError.sessionId.trim();
          completionAttempt += 1;
          cliBackendLog.warn(
            `cli prompt file read is still unverified (${completionError.reason}); retrying in the same session with a completion prompt (${completionAttempt}/${MAX_COMPLETION_PROMPT_RETRIES}) (session_prompt_file=${completionError.promptFile} session=${completionError.sessionId})`,
          );
          latestCliPromptLoad = buildCliPromptLoadState({
            sessionPromptFile: completionError.promptFile,
            currentSessionPromptFile: completionError.promptFile,
            loaderMode: "normal",
            verifiedRead: false,
            fallbackReason: "verification_retry",
            verifiedChunkCount: verifiedPromptChunkCounts.get(completionSessionId) ?? 0,
          });
          try {
            const completionPrompt =
              ENABLE_SEMANTIC_PROMPT_LOADER && latestSemanticFiles
                ? buildSemanticCompletionPrompt({
                    files: latestSemanticFiles,
                    unverifiedPaths: completionError.unverifiedPaths ?? [
                      completionError.promptFile ?? "",
                    ],
                  })
                : buildClaudeSystemPromptCompletionPrompt({
                    chunks: latestPromptChunks,
                    startIndex: verifiedPromptChunkCounts.get(completionSessionId) ?? 0,
                  });
            return await executeCliWithSession(
              completionSessionId,
              completionPrompt,
              runParams.isSystemCall ?? false,
              runParams.forceReloadSystemPromptFile ?? false,
              "strict",
            );
          } catch (nextCompletionError) {
            if (!(nextCompletionError instanceof PromptFileReadRequiredError)) {
              throw nextCompletionError;
            }
            completionError = nextCompletionError;
          }
        }
        cliBackendLog.warn(
          `cli completion prompt did not verify a full prompt-file read after ${completionAttempt} same-session retries; retrying with strict loader prompt (session_prompt_file=${resolveClaudeSystemPromptFilePath(params.sessionFile)}): ${completionError.message}`,
        );
      }
      cliBackendLog.warn(
        `cli loader prompt verification failed; retrying with strict loader prompt (session_prompt_file=${resolveClaudeSystemPromptFilePath(params.sessionFile)}): ${error.message}`,
      );
      latestCliPromptLoad = buildCliPromptLoadState({
        sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
        currentSessionPromptFile:
          resolveCurrentPromptFileForSession(error.sessionId) ??
          resolveClaudeSystemPromptFilePath(params.sessionFile),
        loaderMode: "normal",
        verifiedRead: false,
        fallbackReason: "verification_retry",
      });
    }

    try {
      if (runParams.cliSessionId?.trim()) {
        verifiedPromptChunkCounts.delete(runParams.cliSessionId.trim());
      }
      const output = await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "strict",
      );
      if (latestCliPromptLoad?.loaderMode === "strict") {
        latestCliPromptLoad = {
          ...latestCliPromptLoad,
          fallbackReason: "verification_retry",
        };
      }
      return output;
    } catch (error) {
      if (!(error instanceof PromptFileReadRequiredError)) {
        throw error;
      }
      if (!ENABLE_DIRECT_SYSTEM_PROMPT_FALLBACK) {
        latestCliPromptLoad = buildCliPromptLoadState({
          sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
          currentSessionPromptFile:
            resolveCurrentPromptFileForSession(runParams.cliSessionId) ??
            resolveClaudeSystemPromptFilePath(params.sessionFile),
          loaderMode: "strict",
          verifiedRead: false,
          fallbackReason: "direct_fallback_disabled",
        });
        cliBackendLog.warn(
          `cli loader prompt verification failed again; direct system prompt injection fallback is disabled (session_prompt_file=${resolveClaudeSystemPromptFilePath(params.sessionFile)}): ${error.message}`,
        );
        throw new FailoverError(
          `Claude session failed to verify a successful Read of ${resolveClaudeSystemPromptFilePath(params.sessionFile)} after strict retry; direct system prompt injection fallback is disabled.`,
          {
            reason: "unknown",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("unknown"),
          },
        );
      }
      cliBackendLog.warn(
        `cli loader prompt verification failed again; falling back to direct system prompt injection: ${error.message}`,
      );
      latestCliPromptLoad = buildCliPromptLoadState({
        sessionPromptFile: resolveClaudeSystemPromptFilePath(params.sessionFile),
        currentSessionPromptFile:
          resolveCurrentPromptFileForSession(runParams.cliSessionId) ??
          resolveClaudeSystemPromptFilePath(params.sessionFile),
        loaderMode: "strict",
        verifiedRead: false,
        fallbackReason: "direct_injection_fallback",
      });
      const output = await executeCliWithSession(
        runParams.cliSessionId,
        runParams.promptOverride,
        runParams.isSystemCall ?? false,
        runParams.forceReloadSystemPromptFile ?? false,
        "disabled",
      );
      latestCliPromptLoad = buildCliPromptLoadState({
        sessionPromptFile:
          latestCliPromptLoad?.sessionPromptFile ??
          resolveClaudeSystemPromptFilePath(params.sessionFile),
        currentSessionPromptFile:
          latestCliPromptLoad?.currentSessionPromptFile ??
          resolveCurrentPromptFileForSession(runParams.cliSessionId) ??
          resolveClaudeSystemPromptFilePath(params.sessionFile),
        loaderMode: "disabled",
        verifiedRead: false,
        fallbackReason: "direct_injection_fallback",
        verifiedChunkCount: latestCliPromptLoad?.verifiedChunkCount ?? 0,
      });
      return output;
    }
  };

  // Layer 2: Context overflow recovery
  try {
    const output = await executeCliWithLoaderFallback({ cliSessionId: cliSessionIdToUse });
    return {
      output,
      cliSessionBinding: latestCliSessionBinding,
      cliPromptLoad: latestCliPromptLoad,
      compactionsThisRun,
      systemPromptReport,
    };
  } catch (err) {
    if (err instanceof FailoverError && isContextOverflowError(err.message)) {
      const backend = context.preparedBackend.backend;
      const imageTokenEstimate = backend.imageArg
        ? (params.images?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE
        : 0;

      // Step 2a: Send /compact to the existing session
      const sessionToCompact = cliSessionIdToUse;
      let compactSucceeded = false;
      if (sessionToCompact && context.isClaude) {
        try {
          cliBackendLog.warn(`cli-runner: context overflow detected, sending /compact to session`);
          if (params.sessionKey) {
            executeDeps.enqueueSystemEvent(
              "Context window limit reached. Compacting conversation context, please wait...",
              { sessionKey: params.sessionKey },
            );
          }
          await executeCliWithSession(sessionToCompact, "/compact", true, false, "normal");
          compactSucceeded = true;
          compactionsThisRun += 1;
          cliBackendLog.warn("cli-runner: /compact succeeded, will retry with minimal profile");
        } catch (compactErr) {
          if (compactErr instanceof FailoverError && compactErr.reason === "session_expired") {
            throw compactErr;
          }
          // /stop fired during /compact — don't swallow the abort into a
          // profile-downgrade retry; propagate so the outer catch recognises
          // it as a user abort.
          if (compactErr instanceof Error && compactErr.name === "AbortError") {
            throw compactErr;
          }
          cliBackendLog.warn(
            `cli-runner: /compact failed (${compactErr instanceof Error ? compactErr.message : String(compactErr)}), proceeding with profile downgrade only`,
          );
        }
      }

      // Step 2b: Downgrade bootstrap profile to minimal
      if (activeProfile !== "minimal") {
        const sessionLabel = params.sessionKey ?? params.sessionId;
        const minimalConfig = getBootstrapProfileConfig("minimal");
        const minimalContextFiles = buildBootstrapContextFiles(context.bootstrapFiles, {
          maxChars: minimalConfig.maxCharsPerFile,
          totalMaxChars: minimalConfig.totalMaxChars,
          warn: makeBootstrapWarn({
            sessionLabel,
            warn: (message) => cliBackendLog.warn(message),
          }),
        });
        const minimalWarning = buildBootstrapPromptWarning({
          analysis: analyzeBootstrapBudget({
            files: buildBootstrapInjectionStats({
              bootstrapFiles: context.bootstrapFiles,
              injectedFiles: minimalContextFiles,
            }),
            bootstrapMaxChars: minimalConfig.maxCharsPerFile,
            bootstrapTotalMaxChars: minimalConfig.totalMaxChars,
          }),
          mode: context.bootstrapPromptWarningMode,
          seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
          previousSignature: params.bootstrapPromptWarningSignature,
        });
        systemPrompt = prependBootstrapPromptWarning(
          buildSystemPrompt({
            workspaceDir: context.workspaceDir,
            config: params.config,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: context.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            heartbeatPrompt: context.heartbeatPrompt,
            docsPath: context.docsPath,
            tools: [],
            contextFiles: minimalContextFiles,
            modelDisplay: `${params.provider}/${context.modelId}`,
            agentId: context.sessionAgentId,
          }),
          minimalWarning.lines,
        );
        _activeContextFiles = minimalContextFiles;
        activeProfile = "minimal";
      }

      // Step 2c: Retry
      const sessionForRetry = compactSucceeded ? cliSessionIdToUse : undefined;
      try {
        const output = await executeCliWithLoaderFallback({
          cliSessionId: sessionForRetry,
          forceReloadSystemPromptFile: compactSucceeded,
        });
        return {
          output,
          cliSessionBinding: latestCliSessionBinding,
          cliPromptLoad: latestCliPromptLoad,
          compactionsThisRun,
          systemPromptReport,
        };
      } catch (retryErr) {
        if (retryErr instanceof FailoverError && isContextOverflowError(retryErr.message)) {
          const estimatedTks =
            estimatePromptTokens(systemPrompt) +
            estimatePromptTokens(params.prompt) +
            imageTokenEstimate;
          throw new FailoverError(
            `Current task exceeds context window for this runtime (estimated=${estimatedTks} tokens, profile=minimal, compact=${compactSucceeded}). Consider switching to the pi-embedded runtime or splitting the task.`,
            {
              reason: "unknown",
              provider: params.provider,
              model: context.modelId,
              status: resolveFailoverStatus("unknown"),
            },
          );
        }
        throw retryErr;
      }
    }
    throw err;
  }
}
