import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { generateConversationLabel as generateTopicLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import {
  AUTO_TOPIC_LABEL_REFINE_PROMPT,
  normalizeGeneratedTopicLabel,
} from "./auto-topic-label-config.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  resolveTelegramDirectTopicNameCacheScope,
  getTopicName,
  updateTopicName,
} from "./topic-name-cache.js";

/**
 * Durable, bounded state for the opt-in one-time DM topic label refinement.
 * Keyed by `<botTokenHash>:<accountId>:<chatId>:<threadId>` so multi-account
 * deployments with colliding chat/topic IDs never share state and a repointed
 * `accountId` (bot-token rotation, monitor.ts `bot-id-changed`) never lets the
 * previous bot's entry drive the replacement bot's `editForumTopic`; the entry
 * only exists for labels this bot generated, which doubles as the
 * manual-rename guard (user-renamed topics are detected by comparing the live
 * cached name with the label).
 */
type TopicLabelRefinementEntry = {
  lifecycleRevision?: string;
  /** Label this bot generated for the first turn. */
  label: string;
  /** Durable intent until the initial edit and cache update have completed. */
  pendingInitialLabel?: string;
  /** Initial inference is still pending; the prior label retains ownership only. */
  awaitingInitialLabel?: boolean;
  /** Later user task messages, including those received during initial generation. */
  count: number;
  /** Intermediate user excerpts retained for the refinement source. */
  excerpts?: string[];
  /** True once the single attempt has been claimed (see claim semantics). */
  done: boolean;
  /** Outcome of a claimed attempt, recorded best-effort after the effect. */
  outcome?: "renamed" | "failed";
};

const REFINEMENT_STORE_NAMESPACE = "telegram.topic-label-refinement";
const REFINEMENT_STORE_MAX_ENTRIES = 2_048;
const REFINEMENT_SOURCE_MAX_CHARS = 500;
/** Fixed excerpt budget, independent of refineAfterMessages (Codex 4304532547). */
const MAX_TOPIC_REFINEMENT_EXCERPTS = 8;
const MAX_TOPIC_REFINEMENT_EXCERPT_CHARS = 4_000;

/**
 * Bot identity for the refinement key: the bot user id from the startup getMe
 * probe. Namespace-scoping the durable key by bot identity keeps an unfinished
 * prior-bot entry from renaming a colliding topic under a replacement bot
 * after token rotation (Codex 4301074602).
 */
function refinementKey(params: {
  botId: number | string | undefined;
  accountId: string;
  chatId: number | string;
  threadId: number;
}): string {
  return `${params.botId ?? "unknown-bot"}:${params.accountId}:${params.chatId}:${params.threadId}`;
}

async function loadRefinementStore() {
  return getTelegramRuntime().state.openKeyedStore<TopicLabelRefinementEntry>({
    namespace: REFINEMENT_STORE_NAMESPACE,
    maxEntries: REFINEMENT_STORE_MAX_ENTRIES,
  });
}

type MaybeRefineTopicLabelParams = Parameters<typeof maybeRefineTopicLabel>[0];

/**
 * Per-topic serialization for the refinement's read-modify-write sequences:
 * the durable counter increment and the one-attempt claim each read the entry,
 * decide, and write back, and the store serialises individual writes but not
 * the lookups between them (Codex 4304709772).
 */
const refinementLocks = new Map<string, Promise<unknown>>();

async function withRefinementLock(key: string, run: () => Promise<void>): Promise<void> {
  const prior = refinementLocks.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(run);
  refinementLocks.set(key, next);
  try {
    await next;
  } finally {
    if (refinementLocks.get(key) === next) {
      refinementLocks.delete(key);
    }
  }
}

/**
 * Persist the initial label intent before its external effect. Serialize the
 * edit, cache update and attachment with later turns; initial inference stays
 * outside this lock so follow-ups during generation are still counted.
 */
export async function finishInitialTopicLabel(
  params: Omit<MaybeRefineTopicLabelParams, "userMessage"> & {
    label: string;
    applyInitialLabel: () => Promise<void>;
  },
): Promise<void> {
  try {
    await withRefinementLock(refinementKey(params), async () => {
      const key = refinementKey(params);
      const store = await loadRefinementStore();
      const entry = await store.lookup(key);
      if (
        params.lifecycleRevision !== undefined &&
        entry?.lifecycleRevision !== params.lifecycleRevision
      ) {
        return;
      }
      if (entry && !entry.done) {
        await store.register(key, { ...entry, pendingInitialLabel: params.label });
      }
      await params.applyInitialLabel();
      await runRefinementTurn(params, { label: params.label });
    });
  } catch (err) {
    console.warn(`auto-topic-label: refinement label attach failed: ${String(err)}`);
  }
}

/**
 * Counts one later user turn toward the threshold and, exactly once, refines
 * the auto label. Never touches topics whose names the bot did not generate,
 * and never renames a topic that was manually renamed after generation.
 */
/**
 * Resolves the same account-scoped topic-name cache scope that
 * bot-message-context uses, so the manual-rename guard and post-refinement
 * cache update hit the account's own store instead of the default scope.
 */
function resolveTopicNameCacheScope(params: {
  cfg: Parameters<typeof resolveAgentDir>[0];
  accountId: string;
}): string {
  return resolveTelegramDirectTopicNameCacheScope(
    resolveStorePath(params.cfg.session?.store, {
      agentId: resolveTelegramAccountOwnerAgentId({
        cfg: params.cfg,
        accountId: params.accountId,
      }),
    }),
    params.accountId,
  );
}

export async function maybeRefineTopicLabel(params: {
  botId: number | string | undefined;
  accountId: string;
  bot: {
    api: {
      editForumTopic: (
        chatId: number | string,
        threadId: number,
        opts: { name: string },
      ) => Promise<unknown>;
    };
  };
  /** Fails when the owning account/service was stopped or replaced. */
  assertServiceCurrent: () => void;
  assertLifecycleCurrent?: () => Promise<void>;
  lifecycleRevision?: string;
  cfg: Parameters<typeof resolveAgentDir>[0];
  agentId: string;
  chatId: number | string;
  threadId: number;
  userMessage: string;
  afterMessages: number;
  logVerbose: (message: string) => void;
}): Promise<void> {
  try {
    // Control-only turns are not task messages and must not spend the one
    // refinement attempt when text commands use the ordinary dispatch path.
    if (isControlCommandMessage(params.userMessage, params.cfg)) {
      return;
    }
    // Serialize the lookup-modify-write sequence per topic: the store
    // serialises individual writes but not the reads between them, so
    // overlapping dispatch turns would lose a counter increment below the
    // threshold or spend the single refinement attempt twice at it
    // (Codex 4304709772).
    await withRefinementLock(refinementKey(params), () =>
      runRefinementTurn(params, { userMessage: params.userMessage }),
    );
  } catch (err) {
    params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
  }
}

/**
 * One refinement turn for a single topic, serialized per refinement key by
 * withRefinementLock (Codex 4304709772).
 */
async function runRefinementTurn(
  params: Omit<MaybeRefineTopicLabelParams, "userMessage">,
  event: { userMessage: string } | { label: string },
): Promise<void> {
  try {
    const key = refinementKey(params);
    const store = await loadRefinementStore();
    const entry = await store.lookup(key);
    if (
      !entry ||
      entry.done ||
      (params.lifecycleRevision !== undefined &&
        entry.lifecycleRevision !== params.lifecycleRevision)
    ) {
      return;
    }
    const next: TopicLabelRefinementEntry = { ...entry };
    if ("label" in event) {
      next.label = event.label;
      delete next.awaitingInitialLabel;
      delete next.pendingInitialLabel;
    } else {
      const excerpt = truncateUtf16Safe(event.userMessage, REFINEMENT_SOURCE_MAX_CHARS);
      if (!excerpt.trim()) {
        return;
      }
      next.count += 1;
      // Keep a bounded task window even when the threshold is reached before
      // initial inference finishes. Attaching its label resumes the same owner
      // without requiring or counting an additional user turn.
      const retained = [...(entry.excerpts ?? []), excerpt];
      let kept: string[] = retained.slice(-MAX_TOPIC_REFINEMENT_EXCERPTS);
      while (kept.join("").length > MAX_TOPIC_REFINEMENT_EXCERPT_CHARS && kept.length > 1) {
        kept = kept.slice(1);
      }
      next.excerpts = kept;
    }
    const cacheScope = resolveTopicNameCacheScope({ cfg: params.cfg, accountId: params.accountId });
    if (next.pendingInitialLabel) {
      const landedName = await getTopicName(params.chatId, params.threadId, cacheScope);
      if (landedName === undefined) {
        await store.register(key, next);
        params.logVerbose("auto-topic-label: initial label recovery waiting for cached topic name");
        return;
      }
      if (landedName !== next.pendingInitialLabel) {
        await store.register(key, {
          ...next,
          pendingInitialLabel: undefined,
          excerpts: [],
          done: true,
          outcome: "failed",
        });
        return;
      }
      next.label = next.pendingInitialLabel;
      delete next.awaitingInitialLabel;
      delete next.pendingInitialLabel;
    }
    await store.register(key, next);
    if (next.awaitingInitialLabel || next.count < params.afterMessages || !next.label.trim()) {
      return;
    }
    // Manual-rename guard: refine only while the topic still carries our label.
    // Both guard and cache update use the account-scoped cache scope so that
    // multi-account deployments with colliding chat/topic IDs never read
    // another account's cached name (4300095326).
    const currentName = await getTopicName(params.chatId, params.threadId, cacheScope);
    if (currentName === undefined) {
      // The topic's cached name is unavailable (evicted by unrelated topic
      // churn or a failed cache write): its current name is unknown, so
      // refinement must not assume it still carries our label — a manual
      // rename would be overwritten. Fail closed without consuming the
      // attempt (Codex 4304532550).
      params.logVerbose("auto-topic-label: refinement skipped (cached topic name unavailable)");
      return;
    }
    if (currentName !== next.label) {
      await store.register(key, { ...next, excerpts: [], done: true, outcome: "failed" });
      params.logVerbose("auto-topic-label: refinement skipped (topic renamed manually)");
      return;
    }
    // Service authority BEFORE consuming the attempt: a stopped/reloaded
    // account must not have its single refinement spent on a turn that can
    // never reach the Bot API (Codex 4300799472).
    await params.assertLifecycleCurrent?.();
    params.assertServiceCurrent();
    // Durable attempt claim BEFORE any external effect: a crash after the Bot
    // API edit (or a rejected edit) must never re-run the LLM and re-rename on
    // a later turn. Outcome is recorded best-effort afterwards. The claim does
    // not retain the excerpt array: the refinement prompt already carries it
    // and the done record must not pin ~4k chars indefinitely (Codex 4304532547).
    // Exactly-once vs bounded eviction: evict-oldest may drop the done marker
    // only after 2_048 newer entries; a dropped marker without armed state is
    // inert (this function no-ops without an entry), and re-arming happens only
    // from this bot's own first-turn label generation, which restarts the count
    // at zero rather than resurrecting a consumed attempt mid-count
    // (Codex 4300868455).
    await store.register(key, { ...next, excerpts: [], done: true, outcome: "failed" });
    params.assertServiceCurrent();
    let label: string | null;
    try {
      label = normalizeGeneratedTopicLabel(
        await generateTopicLabel({
          userMessage: [next.label, ...(next.excerpts ?? [])].filter(Boolean).join("\n---\n"),
          prompt: AUTO_TOPIC_LABEL_REFINE_PROMPT,
          maxLength: 128,
          cfg: params.cfg,
          agentId: params.agentId,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
        }),
      );
    } catch (err) {
      // The attempt was already consumed above; failure only logs.
      params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
      return;
    }
    if (!label) {
      params.logVerbose("auto-topic-label: refinement produced empty label");
      return;
    }
    if (label === next.label) {
      await store.register(key, { ...next, excerpts: [], done: true, outcome: "renamed" });
      return;
    }
    // Re-check the manual-rename guard after the awaited inference: a human
    // may have renamed the topic while the LLM call was in flight, and the
    // refinement must never overwrite that name (Codex 4303083920).
    const postInferenceName = await getTopicName(params.chatId, params.threadId, cacheScope);
    if (postInferenceName !== next.label) {
      await store.register(key, { ...next, excerpts: [], done: true, outcome: "failed" });
      params.logVerbose(
        "auto-topic-label: refinement skipped after inference (topic name changed or unavailable)",
      );
      return;
    }
    // The cache read also awaits: the account may stop or reload while it is
    // pending, so check this service's authority at the actual API effect.
    await params.assertLifecycleCurrent?.();
    params.assertServiceCurrent();
    await params.bot.api.editForumTopic(params.chatId, params.threadId, { name: label });
    await updateTopicName(params.chatId, params.threadId, { name: label }, cacheScope);
    await store.register(key, { ...next, excerpts: [], label, done: true, outcome: "renamed" });
    params.logVerbose(
      `auto-topic-label: refined topic ${params.chatId}/${params.threadId} (len=${label.length})`,
    );
  } catch (err) {
    params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
  }
}

/** Admit a substantive turn through the same durable owner used by refinement. */
export async function prepareTopicLabelTurn(params: {
  botId: number | string | undefined;
  accountId: string;
  chatId: number | string;
  threadId: number;
  lifecycleRevision: string;
  currentName: string | undefined;
  isNameImplicit?: boolean;
}): Promise<"initial" | "refine" | "skip"> {
  let decision: "initial" | "refine" | "skip" = "skip";
  await withRefinementLock(refinementKey(params), async () => {
    const store = await loadRefinementStore();
    const key = refinementKey(params);
    const entry = await store.lookup(key);
    if (entry?.lifecycleRevision === params.lifecycleRevision) {
      decision = "refine";
      return;
    }
    // No provenance means an existing name may be manual. Missing cache also
    // cannot prove ownership of a previously generated name after reset.
    if (
      entry
        ? !entry.label || params.currentName !== entry.label
        : params.currentName !== undefined && !params.isNameImplicit
    ) {
      return;
    }
    await store.register(key, {
      label: entry?.label ?? "",
      awaitingInitialLabel: true,
      count: 0,
      excerpts: [],
      done: false,
      lifecycleRevision: params.lifecycleRevision,
    });
    decision = "initial";
  });
  return decision;
}
