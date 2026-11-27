import { randomUUID } from "node:crypto";
import {
  isOpenAIResponsesApi,
  resolveOpenAIResponsesPromptCacheLifetimeMs,
} from "@openclaw/ai/transports";
import { getRuntimeConfig } from "../config/config.js";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { readPromptCacheRecoveryKeysInWorker } from "../config/sessions/session-prompt-cache-recovery.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { resolveAllAgentSessionStoreTargetsAsync } from "../config/sessions/targets-runtime.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isMemoryPressureHigh } from "../infra/host-memory.js";
import type { AssistantHistoryMessage } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { resolveExtraParams } from "./embedded-agent-runner/extra-params.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { parseCacheRetention } from "./embedded-agent-runner/prompt-cache-retention.js";
import {
  MAX_WARM_TTL_MS,
  nextPromptCacheKeepWarmDueAtMs as nextDueAtMs,
  promptCacheKeepWarmCandidateKey as candidateKey,
  promptCacheKeepWarmState as state,
  resolvePromptCacheKeepWarmLeadMs,
  type PromptCacheKeepWarmCandidate as Candidate,
} from "./prompt-cache-keep-warm-candidates.js";
import {
  prepareSessionFork,
  readSessionForkTurn,
  resolveSessionForkModel,
  runSessionFork,
} from "./session-fork-run.js";
import {
  SessionManager,
  type SessionEntry as TranscriptEntry,
} from "./sessions/session-manager.js";

/**
 * Keep-warm for idle interactive sessions: shortly before the provider's known prompt-cache
 * lifetime ends, send one read-only prewarm of the session's own request (a tool-free session
 * fork with `cachePrewarm`), so the user's next turn reads the cache instead of rewriting it.
 *
 * Every decision comes from stored facts read when a ping is due: the session row (its
 * `promptCacheKeepWarm` record of the last prewarm) and the transcript's last provider
 * response (its request time, route, prompt size and cache-write tier). Cron maintenance owns
 * the wake; this module keeps only due times, so a Gateway restart resumes a series where the
 * stored record left it.
 */

const log = createSubsystemLogger("agents/prompt-cache-keep-warm");

/** Smaller prompts gain too little per return to spend requests on. */
const MIN_PROMPT_TOKENS = 50_000;
/** Return probability keeps falling with idle time; stop an abandoned session's pings. */
const MAX_SERIES_MS = 12 * 60 * 60_000;
const MAX_PINGS = 24;
const UNPRICED_PINGS = 3;
/** A failed ping (often a rate limit) pauses the whole provider. */
const PROVIDER_BACKOFF_MS = 15 * 60_000;
/** The request must reach the provider this long before expiry. */
const EGRESS_MARGIN_MS = 10_000;
const PING_TIMEOUT_MS = 60_000;
/** The prewarm's trailing item; it is never cached or answered. */
const PREWARM_PROMPT = ".";

type Route = { provider: string; model: string };

/** One idle stretch on one prefix, as read from the row and transcript at a wake. */
type Series = {
  anchorEntryId: string;
  route: Route;
  ttlMs: number;
  maxPings: number;
  pings: number;
  /** The last human interaction; the series ends 12 hours after it. */
  interactionAt: number;
  promptTokens: number;
};

// Omit tool result bodies: the plan reads usage and timestamps only.
const TRANSCRIPT_LIMITS = {
  maxBytes: 8_388_608,
  maxEvents: 20_000,
  toolResultOverflow: "omit",
} as const;

/**
 * Ski-rental bound: pings stop before they cost more than half of one rewrite, which saves
 * `write − read` per prompt token when the user returns warm. Prices per token of one tier.
 */
export function resolvePromptCacheKeepWarmMaxPings(
  cost: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined,
  ttlMs: number,
): number {
  const input = cost?.input ?? 0;
  const read = cost?.cacheRead ?? 0;
  if (!(input > 0 && read > 0)) {
    return UNPRICED_PINGS;
  }
  // The 1h write tier costs 2x input, as usage pricing charges it.
  const write = ttlMs >= MAX_WARM_TTL_MS ? 2 * input : (cost?.cacheWrite ?? input);
  // The epsilon keeps decimal prices such as 4.8 / 0.4 from flooring to 11.
  const pings = Math.floor((write - read) / (2 * read) + 1e-9);
  return Math.min(MAX_PINGS, Math.max(1, pings));
}

/**
 * The cache-write tier the session's latest responses on this route proved: the newest write
 * wins (both tiers in one response: the shorter); a pure read keeps the earlier tier. The walk
 * stops at a compaction, reset or model change, which start another prefix.
 */
export function readObservedPromptCacheTtlMs(
  entries: readonly TranscriptEntry[],
  route: Route,
): number | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type === "compaction" || entry.type === "reset" || entry.type === "model_change") {
      return undefined;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const message = entry.message;
    if (message.provider !== route.provider || message.model !== route.model) {
      return undefined;
    }
    if ((message.usage?.cacheWrite5m ?? 0) > 0) {
      return 5 * 60_000;
    }
    if ((message.usage?.cacheWrite1h ?? 0) > 0) {
      return 60 * 60_000;
    }
  }
  return undefined;
}

/** After a start, sessions active within the longest warmable lifetime may still be warm. */
async function recoverCandidates(cfg: OpenClawConfig, now: number): Promise<void> {
  const targets = await resolveAllAgentSessionStoreTargetsAsync(cfg);
  for (const target of targets) {
    const keys = await readPromptCacheRecoveryKeysInWorker(target, now - MAX_WARM_TTL_MS);
    for (const sessionKey of keys) {
      const key = candidateKey(target.agentId, sessionKey);
      if (!state.candidates.has(key)) {
        state.candidates.set(key, {
          agentId: target.agentId,
          sessionKey,
          storePath: target.storePath,
          dueAtMs: now,
        });
      }
    }
  }
}

type Plan = { series: Series; touchAt: number; source: TranscriptEntryAnchor | undefined };

/**
 * What the row's prewarm record still says about this transcript. Its count stands until a
 * human turn after the last prewarm (an automation turn re-anchors the same idle stretch; a
 * reset or new transcript starts with a human turn); its time is a cache touch only for the
 * tail reply and route it warmed.
 */
export function readStoredPromptCacheKeepWarm(
  entry: Pick<SessionEntry, "lastInteractionAt" | "promptCacheKeepWarm">,
  anchorEntryId: string,
  route: Route,
): { pings: number; pingedAt: number } {
  const stored = entry.promptCacheKeepWarm;
  if (!stored) {
    return { pings: 0, pingedAt: 0 };
  }
  return {
    pings: (entry.lastInteractionAt ?? 0) <= stored.lastPingAt ? stored.pings : 0,
    pingedAt:
      stored.anchorEntryId === anchorEntryId &&
      stored.provider === route.provider &&
      stored.model === route.model
        ? stored.lastPingAt
        : 0,
  };
}

/** Reads the stored facts and returns the session's plan, or why it gets no ping. */
async function readPlan(
  cfg: OpenClawConfig,
  candidate: Candidate,
  entry: SessionEntry,
  signal: AbortSignal,
): Promise<Plan | string> {
  if (entry.archivedAt !== undefined || entry.pendingFinalDelivery) {
    return "archived or delivering";
  }
  const scope = {
    agentId: candidate.agentId,
    sessionId: entry.sessionId,
    sessionKey: candidate.sessionKey,
    storePath: candidate.storePath,
  };
  const manager = await SessionManager.openModelContextAsync(scope, {
    signal,
    limits: TRANSCRIPT_LIMITS,
  });
  const branch = manager.getBranch();
  const lastMessageIndex = branch.findLastIndex((item) => item.type === "message");
  const last = branch[lastMessageIndex];
  if (
    !last ||
    last.type !== "message" ||
    last.message.role !== "assistant" ||
    last.message.stopReason !== "stop" ||
    branch
      .slice(lastMessageIndex + 1)
      .some(
        (item) =>
          item.type === "compaction" || item.type === "reset" || item.type === "model_change",
      )
  ) {
    return "no settled reply";
  }
  const reply: AssistantHistoryMessage = last.message;
  const route = { provider: reply.provider, model: reply.model };
  const usage = reply.usage;
  const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  if (promptTokens < MIN_PROMPT_TOKENS) {
    return "small prompt";
  }
  const { model } = resolveSessionForkModel({ cfg, agentId: candidate.agentId, entry });
  if (model?.provider !== route.provider || model.model !== route.model) {
    return "route changed";
  }
  const resolved = await resolveModelAsync(
    route.provider,
    route.model,
    resolveAgentDir(cfg, candidate.agentId),
    cfg,
    { agentId: candidate.agentId },
  );
  if (!resolved.model) {
    return "model unavailable";
  }
  const api = resolved.model.api;
  let ttlMs: number | undefined;
  if (api === "anthropic-messages") {
    ttlMs = readObservedPromptCacheTtlMs(branch, route);
  } else if (isOpenAIResponsesApi(api) && api !== "openai-chatgpt-responses") {
    // ChatGPT sign-in documents no cache lifetime, so it gets no pings (#204219).
    const extraParams = resolveExtraParams({
      cfg,
      provider: route.provider,
      modelId: route.model,
      agentId: candidate.agentId,
    });
    // Responses routes take retention from config alone; unset means the transport's "short".
    const retention = parseCacheRetention(extraParams?.cacheRetention) ?? "short";
    ttlMs = resolveOpenAIResponsesPromptCacheLifetimeMs(
      resolved.model,
      retention,
      extraParams?.promptCacheTtl === "12h" || extraParams?.promptCacheTtl === "30m"
        ? extraParams.promptCacheTtl
        : undefined,
    );
  }
  if (ttlMs === undefined || ttlMs > MAX_WARM_TTL_MS) {
    return "no known warmable lifetime";
  }
  const anchorAt = reply.timestamp;
  // A person started the turn that made the last request: the row records an interaction at
  // (chat) or after (agent command) that turn's input. Automation and event turns record none.
  const turnInput = branch
    .slice(0, lastMessageIndex)
    .findLast((item) => item.type === "message" && item.message.role === "user");
  const inputAt = turnInput?.type === "message" ? turnInput.message.timestamp : undefined;
  const turnStartedAt = typeof inputAt === "number" ? inputAt : anchorAt;
  if (!((entry.lastInteractionAt ?? 0) >= turnStartedAt - 60_000)) {
    return "not interactive";
  }
  const { pings, pingedAt } = readStoredPromptCacheKeepWarm(entry, last.id, route);
  const series: Series = {
    anchorEntryId: last.id,
    route,
    ttlMs,
    maxPings: resolvePromptCacheKeepWarmMaxPings(resolved.model.cost, ttlMs),
    pings,
    interactionAt: entry.lastInteractionAt ?? anchorAt,
    promptTokens,
  };
  const source = await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: last.id }, signal);
  return { series, touchAt: Math.max(anchorAt, pingedAt), source };
}

/** One candidate at its due time: plan, wait, lapse, or ping. Returns its next wake. */
async function processCandidate(
  cfg: OpenClawConfig,
  candidate: Candidate,
  signal: AbortSignal,
): Promise<number | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId: candidate.agentId,
    sessionKey: candidate.sessionKey,
    storePath: candidate.storePath,
    projection: "list",
  });
  if (!entry?.sessionId) {
    return undefined;
  }
  const plan = await readPlan(cfg, candidate, entry, signal);
  if (typeof plan === "string") {
    log.debug(`No keep-warm for ${candidate.sessionKey}: ${plan}`);
    return undefined;
  }
  const { series, touchAt, source } = plan;
  const now = Date.now();
  const leadMs = resolvePromptCacheKeepWarmLeadMs(series.ttlMs);
  const dueAt = touchAt + series.ttlMs - leadMs;
  const expiresAt = touchAt + series.ttlMs;
  if (now < dueAt) {
    return dueAt;
  }
  if (now > dueAt + leadMs / 2) {
    log.debug(`Keep-warm lapsed for ${candidate.sessionKey}: the cache may already be cold`);
    return undefined;
  }
  if (series.pings >= series.maxPings || now - series.interactionAt > MAX_SERIES_MS) {
    return undefined;
  }
  if ((state.providerBackoffUntil.get(series.route.provider) ?? 0) > now) {
    return undefined;
  }
  if (!source) {
    return undefined;
  }
  const turn = await readSessionForkTurn(source, signal);
  const { model } = resolveSessionForkModel({
    cfg,
    agentId: candidate.agentId,
    entry,
    turnModel: turn?.model,
  });
  if (model?.provider !== series.route.provider || model.model !== series.route.model) {
    return undefined;
  }
  // A prewarm has no caller and runs no tools, so it never holds owner authority.
  const requester = { ...turn?.requester, senderIsOwner: false };
  const prepared = await prepareSessionFork({
    config: cfg,
    source,
    tools: [],
    model,
    workspaceDir: resolveAgentWorkspaceDir(cfg, candidate.agentId),
    requester,
  });
  if (!prepared) {
    return undefined;
  }
  const startedAt = Date.now();
  const result = await runSessionFork(
    {
      config: cfg,
      source,
      prompt: PREWARM_PROMPT,
      tools: [],
      runId: `prompt-cache-keep-warm-${randomUUID()}`,
      owner: "core:prompt-cache-keep-warm",
      model,
      workspaceDir: prepared.workspaceDir,
      requester,
      timeoutMs: PING_TIMEOUT_MS,
      cachePrewarm: true,
      abortSignal: signal,
      // A late wake must not pay to write a cache that already expired.
      assertCallerCurrent: () => {
        if (Date.now() > expiresAt - EGRESS_MARGIN_MS) {
          throw new Error("Prompt cache keep-warm reached the cache expiry before sending.");
        }
      },
    },
    async (outcome) => outcome,
  );
  if (!result.ok) {
    if (!result.cancelled) {
      state.providerBackoffUntil.set(series.route.provider, Date.now() + PROVIDER_BACKOFF_MS);
      log.warn(
        `Prompt cache keep-warm failed for ${candidate.sessionKey}: ${formatErrorMessage(result.error)}`,
      );
    }
    return undefined;
  }
  const usage =
    result.result.meta?.agentMeta?.lastCallUsage ?? result.result.meta?.agentMeta?.usage;
  const read = usage?.cacheRead ?? 0;
  const written = usage?.cacheWrite ?? 0;
  log.info("Prompt cache keep-warm ping", {
    sessionKey: candidate.sessionKey,
    provider: series.route.provider,
    model: series.route.model,
    ping: series.pings + 1,
    maxPings: series.maxPings,
    cacheRead: read,
    cacheWrite: written,
    output: usage?.output ?? 0,
  });
  // A miss means the cache was already gone or the request no longer matches it: the ping
  // just paid a write, and the next one would too.
  if (read === 0 || written > read || read < series.promptTokens / 2) {
    return undefined;
  }
  const pings = series.pings + 1;
  await applySessionEntryOperation(
    {
      agentId: candidate.agentId,
      sessionKey: candidate.sessionKey,
      storePath: candidate.storePath,
    },
    {
      kind: "fields",
      patch: {
        promptCacheKeepWarm: {
          anchorEntryId: series.anchorEntryId,
          provider: series.route.provider,
          model: series.route.model,
          lastPingAt: startedAt,
          pings,
        },
      },
    },
    // Bookkeeping: the session's activity order and maintenance stay as they were.
    { preserveActivity: true, skipMaintenance: true, result: "none" },
  );
  return pings < series.maxPings ? startedAt + series.ttlMs - leadMs : undefined;
}

/**
 * Cron maintenance's keep-warm pass: recovers candidates once after start, then handles the
 * due ones one at a time. Returns the next wake time.
 */
export async function runPromptCacheKeepWarm(signal: AbortSignal): Promise<number> {
  const cfg = getRuntimeConfig();
  if (cfg.agents?.defaults?.promptCacheKeepWarm === false) {
    state.candidates.clear();
    return Infinity;
  }
  if (isMemoryPressureHigh()) {
    return Date.now() + 60_000;
  }
  if (!state.recovered) {
    state.recovered = true;
    await runWithGatewayIndependentRootWorkAdmission(
      () => recoverCandidates(cfg, Date.now()),
      "prompt-cache-keep-warm",
      signal,
    ).catch((error: unknown) => {
      log.warn(`Prompt cache keep-warm recovery failed: ${formatErrorMessage(error)}`);
    });
  }
  // Map iteration tolerates the deletes below and visits candidates noted during a ping.
  for (const [key, candidate] of state.candidates) {
    if (signal.aborted) {
      break;
    }
    if (candidate.dueAtMs > Date.now()) {
      continue;
    }
    let next: number | undefined;
    try {
      next = await runWithGatewayIndependentRootWorkAdmission(
        () => processCandidate(cfg, candidate, signal),
        "prompt-cache-keep-warm",
        signal,
      );
    } catch (error) {
      if (!signal.aborted) {
        log.debug(
          `Prompt cache keep-warm skipped ${candidate.sessionKey}: ${formatErrorMessage(error)}`,
        );
      }
    }
    // A transcript change during the pass replaced this candidate; keep the newer one.
    if (state.candidates.get(key) !== candidate) {
      continue;
    }
    if (next === undefined) {
      state.candidates.delete(key);
    } else {
      candidate.dueAtMs = next;
    }
  }
  return nextDueAtMs();
}
