import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { closeActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  cleanupSessionLifecycleArtifacts,
  formatSqliteSessionFileMarker,
  patchSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  applyActiveMemoryRuntimeConfigSnapshot,
  isMissingRegisteredMemoryToolsError,
  requireTransientWorkspaceDir,
  resolveActiveMemoryCleanupConfig,
  resolvePersistentTranscriptBaseDir,
  resolveSafeTranscriptDir,
} from "./config.js";
import { buildRecallPrompt, getModelRef } from "./prompt.js";
import {
  buildPersistedDebugSummary,
  buildPluginStatusLine,
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
  resolveRecallRunChannelContext,
} from "./session.js";
import {
  attachPartialTimeoutData,
  buildSubagentRecallResult,
  buildTimeoutRecallResult,
  fileTranscriptSource,
  readActiveMemorySearchDebugFromRunResult,
  readActiveMemorySessionFileFromRunResult,
  readMergedActiveMemoryTranscriptState,
  readMemoryToolResultEvidence,
  readPartialAssistantTextFromSources,
  readPartialTimeoutData,
  transcriptSourceFromReturnedSessionFile,
  watchTerminalMemorySearchResult,
} from "./transcript.js";
import {
  ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS,
  ACTIVE_MEMORY_RECALL_LANE,
  CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  MAX_LOG_VALUE_CHARS,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type ActiveRecallResult,
  type CachedActiveRecallResult,
  type CircuitBreakerEntry,
  type RecallSubagentResult,
  type ResolvedActiveRecallPluginConfig,
  type TerminalMemorySearchWatch,
} from "./types.js";

let lastActiveRecallCacheSweepAt = 0;
const activeRecallCache = new Map<string, CachedActiveRecallResult>();
const timeoutCircuitBreaker = new Map<string, CircuitBreakerEntry>();

function buildCircuitBreakerKey(agentId: string, provider?: string, model?: string): string {
  return `${agentId}:${provider ?? "unknown"}/${model ?? "unknown"}`;
}

function isCircuitBreakerOpen(key: string, maxTimeouts: number, cooldownMs: number): boolean {
  const entry = timeoutCircuitBreaker.get(key);
  if (!entry || entry.consecutiveTimeouts < maxTimeouts) {
    return false;
  }
  if (Date.now() - entry.lastTimeoutAt >= cooldownMs) {
    // Cooldown expired — reset and allow one attempt through.
    timeoutCircuitBreaker.delete(key);
    return false;
  }
  return true;
}

function recordCircuitBreakerTimeout(key: string): void {
  const entry = timeoutCircuitBreaker.get(key);
  if (entry) {
    entry.consecutiveTimeouts++;
    entry.lastTimeoutAt = Date.now();
  } else {
    timeoutCircuitBreaker.set(key, { consecutiveTimeouts: 1, lastTimeoutAt: Date.now() });
  }
}

function resetCircuitBreaker(key: string): void {
  timeoutCircuitBreaker.delete(key);
}

function scheduleMemorySearchCleanupAfterTimeout(
  api: OpenClawPluginApi,
  logPrefix: string,
  agentId: string,
): void {
  const cfg = resolveActiveMemoryCleanupConfig(api);
  setTimeout(() => {
    void closeActiveMemorySearchManager({ cfg: cfg ?? api.config, agentId })
      .then(() => {
        api.logger.debug?.(`${logPrefix} released memory search managers after timeout`);
      })
      .catch((error: unknown) => {
        const message = toSingleLineLogValue(
          error instanceof Error ? error.message : String(error),
        );
        api.logger.warn?.(
          `${logPrefix} failed to release memory search managers after timeout: ${message}`,
        );
      });
  }, 0);
}

function buildCacheKey(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
}): string {
  const hash = crypto.createHash("sha1").update(params.query).digest("hex");
  return `${params.agentId}:${params.sessionKey ?? params.sessionId ?? "none"}:${hash}`;
}

function getCachedResult(cacheKey: string): ActiveRecallResult | undefined {
  const cached = activeRecallCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  const now = asDateTimestampMs(Date.now());
  if (
    now === undefined ||
    asDateTimestampMs(cached.expiresAt) === undefined ||
    cached.expiresAt <= now
  ) {
    activeRecallCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function setCachedResult(cacheKey: string, result: ActiveRecallResult, ttlMs: number): void {
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  if (
    activeRecallCache.size >= DEFAULT_MAX_CACHE_ENTRIES ||
    (now !== undefined && now - lastActiveRecallCacheSweepAt >= CACHE_SWEEP_INTERVAL_MS)
  ) {
    sweepExpiredCacheEntries(now);
    if (now !== undefined) {
      lastActiveRecallCacheSweepAt = now;
    }
  }
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  if (expiresAt === undefined) {
    activeRecallCache.delete(cacheKey);
    return;
  }
  if (activeRecallCache.has(cacheKey)) {
    activeRecallCache.delete(cacheKey);
  }
  activeRecallCache.set(cacheKey, {
    expiresAt,
    result,
  });
  while (activeRecallCache.size > DEFAULT_MAX_CACHE_ENTRIES) {
    const oldestKey = activeRecallCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    activeRecallCache.delete(oldestKey);
  }
}

function sweepExpiredCacheEntries(now = asDateTimestampMs(Date.now())): void {
  if (now === undefined) {
    activeRecallCache.clear();
    return;
  }
  for (const [cacheKey, cached] of activeRecallCache.entries()) {
    if (asDateTimestampMs(cached.expiresAt) === undefined || cached.expiresAt <= now) {
      activeRecallCache.delete(cacheKey);
    }
  }
}

function toSingleLineLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint" ||
          typeof value === "symbol"
        ? String(value)
        : value == null
          ? ""
          : JSON.stringify(value);
  const singleLine = raw
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > MAX_LOG_VALUE_CHARS
    ? `${truncateUtf16Safe(singleLine, MAX_LOG_VALUE_CHARS)}...`
    : singleLine;
}

function shouldCacheResult(result: ActiveRecallResult): boolean {
  return result.status === "ok" && result.summary.length > 0;
}

function collectActiveMemoryTranscriptSources(params: {
  artifactSessionFile: string;
  runtimeSource: ActiveMemoryTranscriptSource;
  activeSessionFile?: string;
  activeSessionKey: string;
}): ActiveMemoryTranscriptSource[] {
  const sources: ActiveMemoryTranscriptSource[] = [params.runtimeSource];
  sources.push(fileTranscriptSource(params.artifactSessionFile));
  if (params.activeSessionFile && params.activeSessionFile !== params.artifactSessionFile) {
    sources.push(
      transcriptSourceFromReturnedSessionFile({
        sessionFile: params.activeSessionFile,
        sessionKey: params.activeSessionKey,
      }),
    );
  }
  return sources;
}

async function persistActiveMemoryTranscriptArtifact(params: {
  sources: readonly ActiveMemoryTranscriptSource[];
  sessionFile: string;
}): Promise<void> {
  const events: unknown[] = [];
  const seen = new Set<string>();
  for (const source of params.sources) {
    if (source.kind !== "runtime") {
      continue;
    }
    let sourceEvents: readonly unknown[];
    try {
      sourceEvents = await readSessionTranscriptEvents(source.target);
    } catch {
      continue;
    }
    for (const event of sourceEvents) {
      const serialized = JSON.stringify(event);
      if (seen.has(serialized)) {
        continue;
      }
      seen.add(serialized);
      events.push(event);
    }
  }
  if (events.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    params.sessionFile,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

async function cleanupActiveMemoryRecallSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const sessionKeySegmentPrefix =
    parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey;
  let lastError: unknown;
  for (const delayMs of ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      const result = await cleanupSessionLifecycleArtifacts({
        agentId: params.agentId,
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        sessionKeySegmentPrefix,
        storePath: params.storePath,
        transcriptContentMarker: `"runId":"${params.sessionId}"`,
      });
      if (result.removedEntries !== 1) {
        throw new Error(
          `active-memory recall cleanup removed ${String(result.removedEntries)} sessions`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`active-memory recall cleanup failed: ${String(lastError)}`);
}

async function runRecallSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  query: string;
  searchQuery: string;
  currentModelProviderId?: string;
  currentModelId?: string;
  modelRef?: { provider: string; model: string };
  abortSignal?: AbortSignal;
  onTranscriptSources?: (sources: readonly ActiveMemoryTranscriptSource[]) => void;
}): Promise<RecallSubagentResult> {
  const workspaceDir = resolveAgentWorkspaceDir(params.api.config, params.agentId);
  const agentDir = resolveAgentDir(params.api.config, params.agentId);
  const modelRef =
    params.modelRef ??
    getModelRef(params.api, params.agentId, params.config, {
      modelProviderId: params.currentModelProviderId,
      modelId: params.currentModelId,
    });
  if (!modelRef) {
    return { rawReply: "NONE" };
  }
  const subagentSessionId = `active-memory-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const parentSessionKey =
    params.sessionKey ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const subagentScope = parentSessionKey ?? params.sessionId ?? crypto.randomUUID();
  const subagentSuffix = `active-memory:${crypto
    .createHash("sha1")
    .update(`${subagentScope}:${params.query}:${subagentSessionId}`)
    .digest("hex")
    .slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;
  const transientWorkspace = params.config.persistTranscripts
    ? undefined
    : await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-active-memory-",
      });
  const tempDir = transientWorkspace?.dir;
  const persistedDir = params.config.persistTranscripts
    ? resolveSafeTranscriptDir(
        resolvePersistentTranscriptBaseDir(params.api, params.agentId),
        params.config.transcriptDir,
      )
    : undefined;
  const artifactSessionFile =
    persistedDir !== undefined
      ? path.join(persistedDir, `${subagentSessionId}.jsonl`)
      : path.join(requireTransientWorkspaceDir(tempDir), "session.jsonl");
  const storePath = params.api.runtime.agent.session.resolveStorePath(
    params.api.config.session?.store,
    {
      agentId: params.agentId,
    },
  );
  const runtimeSessionFile = formatSqliteSessionFileMarker({
    agentId: params.agentId,
    sessionId: subagentSessionId,
    storePath,
  });
  const runtimeSource: ActiveMemoryTranscriptSource = {
    kind: "runtime",
    target: {
      agentId: params.agentId,
      sessionId: subagentSessionId,
      sessionKey: subagentSessionKey,
      storePath,
    },
  };
  let transcriptSources = collectActiveMemoryTranscriptSources({
    artifactSessionFile,
    runtimeSource,
    activeSessionKey: subagentSessionKey,
  });

  let harnessHasUsableMemoryResult = false;
  let harnessHasUnavailableMemorySearchResult = false;
  let transcriptArtifactPersisted = false;
  let runtimeSessionCreated = false;
  try {
    const runtimeEntry = {
      pluginOwnerId: params.api.id,
      sessionId: subagentSessionId,
      sessionFile: runtimeSessionFile,
      updatedAt: Date.now(),
    };
    const createdEntry = await patchSessionEntry({
      agentId: params.agentId,
      fallbackEntry: runtimeEntry,
      replaceEntry: true,
      sessionKey: subagentSessionKey,
      skipMaintenance: true,
      storePath,
      update: (_entry, context) => (context.existingEntry ? null : runtimeEntry),
    });
    if (createdEntry?.sessionId !== subagentSessionId) {
      throw new Error(`active-memory recall session already exists: ${subagentSessionKey}`);
    }
    runtimeSessionCreated = true;
    params.onTranscriptSources?.(transcriptSources);
    if (persistedDir) {
      await fs.mkdir(persistedDir, { recursive: true, mode: 0o700 });
      await fs.chmod(persistedDir, 0o700).catch(() => undefined);
    }
    const prompt = buildRecallPrompt({
      config: params.config,
      query: params.query,
      searchQuery: params.searchQuery,
    });
    const { messageChannel, messageProvider } = resolveRecallRunChannelContext({
      api: params.api,
      agentId: params.agentId,
      sessionKey: parentSessionKey,
      sessionId: params.sessionId,
      messageProvider: params.messageProvider,
      channelId: params.channelId,
    });
    const embeddedConfig = applyActiveMemoryRuntimeConfigSnapshot(params.api.config, params.config);
    const embeddedTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;
    const result = await params.api.runtime.agent.runEmbeddedAgent({
      sessionId: subagentSessionId,
      sessionKey: subagentSessionKey,
      agentId: params.agentId,
      sessionTarget: {
        agentId: params.agentId,
        sessionId: subagentSessionId,
        sessionKey: subagentSessionKey,
        storePath,
      },
      messageChannel,
      messageProvider,
      sessionFile: runtimeSessionFile,
      workspaceDir,
      agentDir,
      config: embeddedConfig,
      prompt,
      provider: modelRef.provider,
      model: modelRef.model,
      lane: ACTIVE_MEMORY_RECALL_LANE,
      timeoutMs: embeddedTimeoutMs,
      runId: subagentSessionId,
      trigger: "manual",
      toolsAllow: [...params.config.toolsAllow],
      disableMessageTool: true,
      allowGatewaySubagentBinding: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      thinkLevel: params.config.thinking,
      reasoningLevel: "off",
      silentExpected: true,
      authProfileFailurePolicy: "local",
      cleanupBundleMcpOnRunEnd: true,
      abortSignal: params.abortSignal,
      onAgentToolResult: (event) => {
        const evidence = readMemoryToolResultEvidence({
          ...event,
          toolsAllow: params.config.toolsAllow,
        });
        harnessHasUsableMemoryResult ||= evidence.hasUsableMemoryResult;
        harnessHasUnavailableMemorySearchResult ||= evidence.hasUnavailableMemorySearchResult;
      },
    });
    const activeSessionFile =
      readActiveMemorySessionFileFromRunResult(result) ?? runtimeSessionFile;
    transcriptSources = collectActiveMemoryTranscriptSources({
      artifactSessionFile,
      runtimeSource,
      activeSessionFile,
      activeSessionKey: subagentSessionKey,
    });
    params.onTranscriptSources?.(transcriptSources);
    if (params.abortSignal?.aborted) {
      const reason = params.abortSignal.reason;
      if (reason instanceof Error) {
        throw reason;
      }
      const abortErr =
        reason !== undefined
          ? new Error("Operation aborted", { cause: reason })
          : new Error("Operation aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const rawReply = (result.payloads ?? [])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (params.config.persistTranscripts) {
      await persistActiveMemoryTranscriptArtifact({
        sources: transcriptSources,
        sessionFile: artifactSessionFile,
      });
      transcriptArtifactPersisted = true;
    }
    const transcriptState = await readMergedActiveMemoryTranscriptState({
      sources: transcriptSources,
      toolsAllow: params.config.toolsAllow,
    });
    const searchDebug =
      transcriptState.searchDebug ?? readActiveMemorySearchDebugFromRunResult(result);
    return {
      rawReply: rawReply || "NONE",
      transcriptPath: params.config.persistTranscripts ? artifactSessionFile : undefined,
      searchDebug,
      hasUsableMemoryResult: transcriptState.hasUsableMemoryResult || harnessHasUsableMemoryResult,
      hasUnavailableMemorySearchResult:
        transcriptState.hasUnavailableMemorySearchResult || harnessHasUnavailableMemorySearchResult,
    };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      const partialReply = await readPartialAssistantTextFromSources(transcriptSources);
      const transcriptState = await readMergedActiveMemoryTranscriptState({
        sources: transcriptSources,
        toolsAllow: params.config.toolsAllow,
      });
      attachPartialTimeoutData(
        error,
        partialReply,
        transcriptState.searchDebug,
        transcriptState.hasUnavailableMemorySearchResult || harnessHasUnavailableMemorySearchResult,
      );
    }
    if (
      !params.abortSignal?.aborted &&
      isMissingRegisteredMemoryToolsError(error, params.config.toolsAllow)
    ) {
      params.api.logger.debug?.(
        `active-memory: no configured memory tools available; skipping sub-agent`,
      );
      return { rawReply: "NONE", resultStatus: "unavailable" };
    }
    if (!params.abortSignal?.aborted) {
      const message = toSingleLineLogValue(error instanceof Error ? error.message : String(error));
      params.api.logger.warn?.(
        `active-memory: memory sub-agent failed, skipping recall: ${message}`,
      );
      return { rawReply: "NONE", resultStatus: "failed" };
    }
    throw error;
  } finally {
    try {
      if (runtimeSessionCreated) {
        if (params.config.persistTranscripts && !transcriptArtifactPersisted) {
          await persistActiveMemoryTranscriptArtifact({
            sources: transcriptSources,
            sessionFile: artifactSessionFile,
          }).catch((error: unknown) => {
            const message = toSingleLineLogValue(
              error instanceof Error ? error.message : String(error),
            );
            params.api.logger.debug?.(
              `active-memory: failed to persist recall transcript ${artifactSessionFile}: ${message}`,
            );
          });
        }
        await cleanupActiveMemoryRecallSession({
          agentId: params.agentId,
          sessionId: subagentSessionId,
          sessionKey: subagentSessionKey,
          storePath,
        }).catch((error: unknown) => {
          const message = toSingleLineLogValue(
            error instanceof Error ? error.message : String(error),
          );
          params.api.logger.warn?.(
            `active-memory: failed to clean up recall session ${subagentSessionKey}: ${message}`,
          );
          throw error;
        });
      }
    } finally {
      await transientWorkspace?.cleanup();
    }
  }
}

async function maybeResolveActiveRecall(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  query: string;
  searchQuery: string;
  currentModelProviderId?: string;
  currentModelId?: string;
  abortSignal?: AbortSignal;
}): Promise<ActiveRecallResult> {
  params.abortSignal?.throwIfAborted();
  const startedAt = Date.now();
  const cacheKey = buildCacheKey({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    query: params.query,
  });
  const cached = getCachedResult(cacheKey);
  const resolvedModelRef = getModelRef(params.api, params.agentId, params.config, {
    modelProviderId: params.currentModelProviderId,
    modelId: params.currentModelId,
  });
  const logPrefix = [
    `active-memory: agent=${toSingleLineLogValue(params.agentId)}`,
    `session=${toSingleLineLogValue(params.sessionKey ?? params.sessionId ?? "none")}`,
    ...(resolvedModelRef?.provider
      ? [`activeProvider=${toSingleLineLogValue(resolvedModelRef.provider)}`]
      : []),
    ...(resolvedModelRef?.model
      ? [`activeModel=${toSingleLineLogValue(resolvedModelRef.model)}`]
      : []),
  ].join(" ");
  if (cached) {
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: `${buildPluginStatusLine({ result: cached, config: params.config })} cached`,
      debugSummary: buildPersistedDebugSummary(cached),
      searchDebug: cached.searchDebug,
    });
    params.abortSignal?.throwIfAborted();
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} cached status=${cached.status} summaryChars=${String(cached.summary?.length ?? 0)} queryChars=${String(params.query.length)}`,
      );
    }
    return cached;
  }

  // Circuit breaker: skip recall when the same agent/model has timed out
  // too many times in a row (#74054).
  const cbKey = buildCircuitBreakerKey(
    params.agentId,
    resolvedModelRef?.provider,
    resolvedModelRef?.model,
  );
  let timeoutCleanupScheduled = false;
  const scheduleTimeoutCleanup = () => {
    if (timeoutCleanupScheduled) {
      return;
    }
    timeoutCleanupScheduled = true;
    scheduleMemorySearchCleanupAfterTimeout(params.api, logPrefix, params.agentId);
  };
  let circuitBreakerTimeoutRecorded = false;
  const recordRecallTimeout = () => {
    if (!circuitBreakerTimeoutRecorded) {
      circuitBreakerTimeoutRecorded = true;
      recordCircuitBreakerTimeout(cbKey);
    }
    scheduleTimeoutCleanup();
  };
  if (
    isCircuitBreakerOpen(
      cbKey,
      params.config.circuitBreakerMaxTimeouts,
      params.config.circuitBreakerCooldownMs,
    )
  ) {
    const result: ActiveRecallResult = {
      status: "timeout",
      elapsedMs: 0,
      summary: null,
    };
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} skipped (circuit breaker open after consecutive timeouts)`,
      );
    }
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: `${buildPluginStatusLine({ result, config: params.config })} circuit-breaker`,
    });
    return result;
  }

  if (params.config.logging) {
    params.api.logger.info?.(
      `${logPrefix} start timeoutMs=${String(params.config.timeoutMs)} queryChars=${String(
        params.query.length,
      )} searchQueryChars=${String(params.searchQuery.length)}`,
    );
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(params.abortSignal?.reason);
  params.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (params.abortSignal?.aborted) {
    abortFromParent();
  }
  const TIMEOUT_SENTINEL = Symbol("timeout");
  let transcriptSources: readonly ActiveMemoryTranscriptSource[] = [];
  let recallTimedOut = false;
  const watchdogTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;
  const timeoutId = setTimeout(() => {
    if (params.abortSignal?.aborted) {
      return;
    }
    recallTimedOut = true;
    controller.abort(new Error(`active-memory timeout after ${watchdogTimeoutMs}ms`));
  }, watchdogTimeoutMs);
  timeoutId.unref?.();

  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve(TIMEOUT_SENTINEL);
      },
      { once: true },
    );
  });

  let terminalMemorySearchWatch: TerminalMemorySearchWatch | undefined;
  let recallInFlight = false;
  try {
    recallInFlight = true;
    const subagentPromise = runRecallSubagent({
      ...params,
      modelRef: resolvedModelRef,
      abortSignal: controller.signal,
      onTranscriptSources: (sources) => {
        transcriptSources = sources;
      },
    });
    terminalMemorySearchWatch = watchTerminalMemorySearchResult({
      getTranscriptSources: () => transcriptSources,
      abortSignal: controller.signal,
      toolsAllow: params.config.toolsAllow,
    });
    // Silently catch late rejections after timeout so they don't become
    // unhandled promise rejections.
    subagentPromise.catch(() => undefined);

    let raceResult = await Promise.race([
      subagentPromise,
      timeoutPromise,
      terminalMemorySearchWatch.promise,
    ]);
    terminalMemorySearchWatch.stop();
    let fallbackSearchDebug: ActiveMemorySearchDebug | undefined;
    let fallbackHasUsableMemoryResult = false;
    if (
      raceResult !== TIMEOUT_SENTINEL &&
      "status" in raceResult &&
      raceResult.hasUsableMemoryResult
    ) {
      // A later unavailable call must not discard a summary grounded in an
      // earlier successful recall. The existing watchdog remains the deadline.
      fallbackSearchDebug = raceResult.searchDebug;
      fallbackHasUsableMemoryResult = true;
      raceResult = await Promise.race([subagentPromise, timeoutPromise]);
    }
    if (raceResult !== TIMEOUT_SENTINEL) {
      recallInFlight = false;
    }

    if (raceResult === TIMEOUT_SENTINEL) {
      if (recallTimedOut) {
        recordRecallTimeout();
      } else if (params.abortSignal?.aborted && recallInFlight) {
        scheduleTimeoutCleanup();
      }
      const elapsedMs = Date.now() - startedAt;
      const result: ActiveRecallResult = fallbackHasUsableMemoryResult
        ? {
            status: "timeout",
            elapsedMs,
            summary: null,
            searchDebug: fallbackSearchDebug,
          }
        : await buildTimeoutRecallResult({
            elapsedMs,
            maxSummaryChars: params.config.maxSummaryChars,
            transcriptSources,
            subagentPromise,
            toolsAllow: params.config.toolsAllow,
          });
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        debugSummary: buildPersistedDebugSummary(result),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      return result;
    }

    if ("status" in raceResult) {
      controller.abort(new Error("active-memory terminal memory search result"));
      const result: ActiveRecallResult = {
        status: raceResult.status,
        elapsedMs: Date.now() - startedAt,
        summary: null,
        searchDebug: raceResult.searchDebug,
      };
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      resetCircuitBreaker(cbKey);
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      if (shouldCacheResult(result)) {
        setCachedResult(cacheKey, result, params.config.cacheTtlMs);
      }
      return result;
    }

    const { transcriptPath } = raceResult;
    if (params.config.logging && transcriptPath) {
      params.api.logger.info?.(`${logPrefix} transcript=${transcriptPath}`);
    }
    const result = buildSubagentRecallResult({
      subagentResult: raceResult,
      fallbackSearchDebug,
      fallbackHasUsableMemoryResult,
      elapsedMs: Date.now() - startedAt,
      maxSummaryChars: params.config.maxSummaryChars,
    });
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
      );
    }
    resetCircuitBreaker(cbKey);
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
      debugSummary: buildPersistedDebugSummary(result),
      searchDebug: result.searchDebug,
    });
    params.abortSignal?.throwIfAborted();
    if (shouldCacheResult(result)) {
      setCachedResult(cacheKey, result, params.config.cacheTtlMs);
    }
    return result;
  } catch (error) {
    if (params.abortSignal?.aborted) {
      if (recallTimedOut) {
        recordRecallTimeout();
      } else if (recallInFlight) {
        scheduleTimeoutCleanup();
      }
      params.abortSignal.throwIfAborted();
    }
    if (controller.signal.aborted) {
      if (recallTimedOut) {
        recordRecallTimeout();
      }
      const partialTimeoutData = readPartialTimeoutData(error);
      const result = await buildTimeoutRecallResult({
        elapsedMs: Date.now() - startedAt,
        maxSummaryChars: params.config.maxSummaryChars,
        transcriptSources,
        rawReply: partialTimeoutData.rawReply,
        searchDebug: partialTimeoutData.searchDebug,
        hasUnavailableMemorySearchResult: partialTimeoutData.hasUnavailableMemorySearchResult,
        toolsAllow: params.config.toolsAllow,
      });
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} summaryChars=${String(result.summary?.length ?? 0)}`,
        );
      }
      params.abortSignal?.throwIfAborted();
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
        debugSummary: buildPersistedDebugSummary(result),
        searchDebug: result.searchDebug,
      });
      params.abortSignal?.throwIfAborted();
      return result;
    }
    const message = toSingleLineLogValue(error instanceof Error ? error.message : String(error));
    if (params.config.logging) {
      params.api.logger.warn?.(`${logPrefix} failed error=${message}; skipping recall`);
    }
    const result: ActiveRecallResult = {
      status: "failed",
      elapsedMs: Date.now() - startedAt,
      summary: null,
    };
    params.abortSignal?.throwIfAborted();
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
      searchDebug: result.searchDebug,
    });
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", abortFromParent);
    terminalMemorySearchWatch?.stop();
    clearTimeout(timeoutId);
  }
}

function resetActiveRecallStateForTests(): void {
  activeRecallCache.clear();
  timeoutCircuitBreaker.clear();
  lastActiveRecallCacheSweepAt = 0;
}

function getCircuitBreakerEntry(key: string): CircuitBreakerEntry | undefined {
  return timeoutCircuitBreaker.get(key);
}

export {
  buildCacheKey,
  buildCircuitBreakerKey,
  getCachedResult,
  getCircuitBreakerEntry,
  isCircuitBreakerOpen,
  maybeResolveActiveRecall,
  resetActiveRecallStateForTests,
  setCachedResult,
  shouldCacheResult,
  toSingleLineLogValue,
};
