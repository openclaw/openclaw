import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { AUTO_TOPIC_LABEL_REFINE_PROMPT } from "./auto-topic-label-config.js";
import { resolveAgentDir } from "./bot-message-dispatch.agent.runtime.js";
import { generateTopicLabel } from "./bot-message-dispatch.runtime.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  appendTopicNameCacheAccountScope,
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
  /** Label this bot generated for the first turn. */
  label: string;
  /** User task messages observed after the label was generated. */
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

/** Records that this bot generated the initial label; arms the refinement counter. */
export async function armTopicLabelRefinement(params: {
  botId: number | string | undefined;
  accountId: string;
  chatId: number | string;
  threadId: number;
  label: string;
}): Promise<void> {
  try {
    const store = await loadRefinementStore();
    // Once-per-topic: a completed refinement for this topic survives re-arming
    // after /reset or a new session in the same DM topic.
    const existing = await store.lookup(refinementKey(params));
    if (existing?.done) {
      return;
    }
    await store.register(refinementKey(params), {
      label: params.label,
      count: 0,
      excerpts: [],
      done: false,
    });
  } catch (err) {
    console.warn(`auto-topic-label: refinement arming failed: ${String(err)}`);
  }
}

/**
 * Attaches the generated first-turn label to the already-armed entry
 * (arm-before-async-label ordering). Without an armed entry this is a no-op,
 * matching the previous arm-after-label behavior.
 */
export async function attachTopicLabelRefinementLabel(params: {
  botId: number | string | undefined;
  accountId: string;
  chatId: number | string;
  threadId: number;
  label: string;
}): Promise<void> {
  try {
    const store = await loadRefinementStore();
    const key = refinementKey(params);
    const existing = await store.lookup(key);
    if (!existing || existing.done) {
      return;
    }
    await store.register(key, { ...existing, label: params.label });
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
  return appendTopicNameCacheAccountScope(
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
    const key = refinementKey(params);
    const store = await loadRefinementStore();
    const entry = await store.lookup(key);
    if (!entry || entry.done) {
      return;
    }
    const next: TopicLabelRefinementEntry = { ...entry, count: entry.count + 1 };
    if (next.count < params.afterMessages) {
      const excerpt = truncateUtf16Safe(params.userMessage, REFINEMENT_SOURCE_MAX_CHARS);
      if (!excerpt.trim()) {
        return;
      }
      // Retain intermediate turns below the threshold so the refinement prompt
      // carries the full task context, not only the final message
      // (Codex 4300799475).
      await store.register(key, {
        ...next,
        excerpts: [...(entry.excerpts ?? []), excerpt].slice(
          -Math.max(1, params.afterMessages - 1),
        ),
      });
      return;
    }
    // Manual-rename guard: refine only while the topic still carries our label.
    // Both guard and cache update use the account-scoped cache scope so that
    // multi-account deployments with colliding chat/topic IDs never read
    // another account's cached name (4300095326).
    const cacheScope = resolveTopicNameCacheScope({ cfg: params.cfg, accountId: params.accountId });
    const currentName = await getTopicName(params.chatId, params.threadId, cacheScope);
    if (currentName && currentName !== entry.label) {
      await store.register(key, { ...next, done: true, outcome: "failed" });
      params.logVerbose("auto-topic-label: refinement skipped (topic renamed manually)");
      return;
    }
    // A pending first-turn label (armed before the async label lands) carries no
    // name yet: claiming now would spend the single attempt on a title we never
    // actually set, racing the attaching label generation (Codex 4302875130).
    if (!entry.label.trim()) {
      params.logVerbose("auto-topic-label: refinement deferred (initial label still pending)");
      return;
    }
    // Service authority BEFORE consuming the attempt: a stopped/reloaded
    // account must not have its single refinement spent on a turn that can
    // never reach the Bot API (Codex 4300799472).
    params.assertServiceCurrent();
    const excerpt = truncateUtf16Safe(params.userMessage, REFINEMENT_SOURCE_MAX_CHARS);
    if (!excerpt.trim()) {
      return;
    }
    const excerpts = [...(entry.excerpts ?? []), excerpt].slice(
      -Math.max(1, params.afterMessages - 1),
    );
    // Durable attempt claim BEFORE any external effect: a crash after the Bot
    // API edit (or a rejected edit) must never re-run the LLM and re-rename on
    // a later turn. Outcome is recorded best-effort afterwards.
    // Exactly-once vs bounded eviction: evict-oldest may drop the done marker
    // only after 2_048 newer entries; a dropped marker without armed state is
    // inert (this function no-ops without an entry), and re-arming happens only
    // from this bot's own first-turn label generation, which restarts the count
    // at zero rather than resurrecting a consumed attempt mid-count
    // (Codex 4300868455).
    await store.register(key, { ...next, excerpts, done: true, outcome: "failed" });
    params.assertServiceCurrent();
    let label: string | null;
    try {
      label = await generateTopicLabel({
        userMessage: [entry.label, ...(entry.excerpts ?? []), excerpt]
          .filter(Boolean)
          .join("\n---\n"),
        prompt: AUTO_TOPIC_LABEL_REFINE_PROMPT,
        maxLength: 128,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
      });
    } catch (err) {
      // The attempt was already consumed above; failure only logs.
      params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
      return;
    }
    if (!label) {
      params.logVerbose("auto-topic-label: refinement produced empty label");
      return;
    }
    if (label === entry.label) {
      await store.register(key, { ...next, done: true, outcome: "renamed" });
      return;
    }
    // Re-check the manual-rename guard after the awaited inference: a human
    // may have renamed the topic while the LLM call was in flight, and the
    // refinement must never overwrite that name (Codex 4303083920).
    const postInferenceName = await getTopicName(params.chatId, params.threadId, cacheScope);
    if (postInferenceName && postInferenceName !== entry.label) {
      await store.register(key, { ...next, excerpts, done: true, outcome: "failed" });
      params.logVerbose("auto-topic-label: refinement skipped after inference (renamed manually)");
      return;
    }
    // The cache read also awaits: the account may stop or reload while it is
    // pending, so check this service's authority at the actual API effect.
    params.assertServiceCurrent();
    await params.bot.api.editForumTopic(params.chatId, params.threadId, { name: label });
    await updateTopicName(params.chatId, params.threadId, { name: label }, cacheScope);
    await store.register(key, { ...next, label, done: true, outcome: "renamed" });
    params.logVerbose(
      `auto-topic-label: refined topic ${params.chatId}/${params.threadId} (len=${label.length})`,
    );
  } catch (err) {
    params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
  }
}
