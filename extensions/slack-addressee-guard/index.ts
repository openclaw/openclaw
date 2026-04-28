import {
  definePluginEntry,
  fetchWithSsrFGuard,
  ssrfPolicyFromAllowPrivateNetwork,
  type OpenClawPluginApi,
} from "./api.js";

// Default allowlist regex patterns for cron/PM/nudge headers that legitimately
// keep their leading @-mention (for example a sign-off nudge aimed at the
// sign-off owner even when a different human spoke last in the thread).
const DEFAULT_ALLOWLIST_PATTERNS: readonly string[] = [
  String.raw`^\s*(?:⚡\s*)?\[(?:PM-|internal-prest0n|[a-z0-9-]+ VM\])`,
  "Bug Squasher Report|Daily Improvement Report|Fleet Operations Digest",
  "sign-off nudge|reminder #\\d+|nudge #\\d+|every 2h until|every 12h until|awaiting sign-off|awaiting approval",
];

// Default phrases the last human can use to explicitly ask the agent to ping
// the configured targetUserId; when matched, the reply's leading @-mention is
// treated as intentional even if the last human is someone else.
const DEFAULT_ASKED_FOR_TARGET_PHRASES: readonly string[] = [
  "ping",
  "tag",
  "ask",
  "message",
  "let",
  "loop",
  "cc",
  "tell",
];

const DEFAULT_CACHE_TTL_MS = 8_000;
const DEFAULT_MODE: GuardMode = "rewrite";

type GuardMode = "rewrite" | "cancel";

type AddresseeGuardConfig = {
  enabled?: boolean;
  mode?: GuardMode;
  targetUserId?: string;
  botUserId?: string;
  humanNames?: Record<string, string>;
  logPath?: string;
  cacheTtlMs?: number;
  allowlistPatterns?: string[];
  askedForTargetPhrases?: string[];
  // Internal escape hatch for tests; production callers should leave unset.
  slackTokenOverride?: string;
};

type ResolvedConfig = {
  mode: GuardMode;
  targetUserId: string;
  botUserId: string;
  humanNames: Record<string, string>;
  cacheTtlMs: number;
  allowlistRegex: RegExp[];
  askedForTargetPhrases: string[];
  slackToken: string;
};

type AddresseeGuardMessageSendingResult =
  | { cancel: true }
  | { content: string }
  | undefined;

type ParsedTarget = { channelId: string; threadTs: string };

type SlackUserMessage = {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
};

type CachedLastHuman = {
  at: number;
  result: SlackUserMessage | null;
};

const lastHumanCache = new Map<string, CachedLastHuman>();

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveSlackTokenFromEnv(): string {
  return process.env.SLACK_BOT_TOKEN ?? "";
}

function compileRegex(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch {
      // Ignore bad regex from config so a single typo cannot break delivery.
    }
  }
  return compiled;
}

function parseChannelAndThread(
  event: { to?: unknown; threadId?: unknown; replyToId?: unknown; metadata?: Record<string, unknown> | null },
  conversationId: string | undefined,
): ParsedTarget | null {
  const md = (event.metadata ?? {}) as Record<string, unknown>;
  const channelRaw =
    normalizeString(md.channelId) ||
    normalizeString(md.channel_id) ||
    normalizeString(md.channel) ||
    normalizeString(conversationId) ||
    normalizeString(event.to);
  const channelId = channelRaw
    .replace(/^slack:(channel|channels):/i, "")
    .replace(/^channel:/i, "")
    .trim();
  const threadTs =
    normalizeString(md.threadTs) ||
    normalizeString(md.thread_ts) ||
    normalizeString(md.threadId) ||
    normalizeString(md.thread_id) ||
    normalizeString(md.parentTs) ||
    normalizeString(md.parent_ts) ||
    normalizeString(event.replyToId) ||
    normalizeString(event.threadId);
  if (!channelId || !threadTs) {
    return null;
  }
  if (!/^C[A-Z0-9]+$/i.test(channelId)) {
    return null;
  }
  return { channelId, threadTs };
}

function contentMentionsTarget(content: string, targetUserId: string): boolean {
  return content.includes(`<@${targetUserId}>`);
}

function matchesAllowlist(content: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(content)) {
      return true;
    }
  }
  return false;
}

function lastHumanBeforeBot(
  messages: readonly SlackUserMessage[],
  botUserId: string,
): SlackUserMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.user) {
      continue;
    }
    if (msg.bot_id || msg.subtype === "bot_message") {
      continue;
    }
    if (msg.user === botUserId) {
      continue;
    }
    if (!/^U[A-Z0-9]+$/i.test(msg.user)) {
      continue;
    }
    return msg;
  }
  return null;
}

function priorHumanAskedForTarget(
  messageText: string | undefined,
  targetUserId: string,
  askedPhrases: readonly string[],
): boolean {
  const text = normalizeString(messageText);
  if (!text) {
    return false;
  }
  if (text.includes(`<@${targetUserId}>`)) {
    // Last human already referenced the target directly in their message —
    // treat a leading @target address as intentional.
    return true;
  }
  const lower = text.toLowerCase();
  const targetMention = `<@${targetUserId.toLowerCase()}>`;
  if (lower.includes(targetMention)) {
    return true;
  }
  for (const phrase of askedPhrases) {
    if (!phrase) {
      continue;
    }
    if (lower.includes(phrase.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function repairContent(content: string, targetUserId: string, newUserId: string): string {
  const correct = `<@${newUserId}>`;
  const leadingTarget = new RegExp(`^(\\s*)<@${targetUserId}>\\b\\s*`);
  if (leadingTarget.test(content)) {
    return content.replace(leadingTarget, `$1${correct} `);
  }
  return `${correct} ${content}`;
}

function cacheKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function readCachedLastHuman(
  channelId: string,
  threadTs: string,
  cacheTtlMs: number,
): SlackUserMessage | null | undefined {
  const entry = lastHumanCache.get(cacheKey(channelId, threadTs));
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.at > cacheTtlMs) {
    lastHumanCache.delete(cacheKey(channelId, threadTs));
    return undefined;
  }
  return entry.result;
}

function writeCachedLastHuman(
  channelId: string,
  threadTs: string,
  result: SlackUserMessage | null,
): void {
  lastHumanCache.set(cacheKey(channelId, threadTs), { at: Date.now(), result });
}

async function fetchLastHumanFromSlack(
  api: OpenClawPluginApi,
  token: string,
  channelId: string,
  threadTs: string,
  botUserId: string,
): Promise<SlackUserMessage | null> {
  const url = new URL("https://slack.com/api/conversations.replies");
  url.searchParams.set("channel", channelId);
  url.searchParams.set("ts", threadTs);
  url.searchParams.set("limit", "20");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: url.toString(),
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      timeoutMs: 3000,
      policy: ssrfPolicyFromAllowPrivateNetwork(false),
      auditContext: "slack-addressee-guard",
    });
    try {
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as { messages?: SlackUserMessage[] };
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      return lastHumanBeforeBot(messages, botUserId);
    } finally {
      await release();
    }
  } catch (err) {
    api.logger.warn?.(
      `slack-addressee-guard: thread fetch failed; fail-open (${String(
        (err as Error | undefined)?.message ?? err,
      )})`,
    );
    return null;
  }
}

function buildResolvedConfig(raw: AddresseeGuardConfig | undefined): ResolvedConfig | null {
  const cfg = raw ?? {};
  if (cfg.enabled === false) {
    return null;
  }
  const targetUserId = normalizeString(cfg.targetUserId).trim();
  const botUserId = normalizeString(cfg.botUserId).trim();
  if (!targetUserId || !botUserId) {
    return null;
  }
  if (!/^U[A-Z0-9]+$/i.test(targetUserId) || !/^U[A-Z0-9]+$/i.test(botUserId)) {
    return null;
  }
  const token = normalizeString(cfg.slackTokenOverride) || resolveSlackTokenFromEnv();
  if (!token) {
    return null;
  }
  const mode: GuardMode = cfg.mode === "cancel" ? "cancel" : DEFAULT_MODE;
  const cacheTtl =
    typeof cfg.cacheTtlMs === "number" && Number.isFinite(cfg.cacheTtlMs) && cfg.cacheTtlMs >= 0
      ? Math.min(cfg.cacheTtlMs, 600_000)
      : DEFAULT_CACHE_TTL_MS;
  const allowlistInput = Array.isArray(cfg.allowlistPatterns)
    ? [...DEFAULT_ALLOWLIST_PATTERNS, ...cfg.allowlistPatterns]
    : [...DEFAULT_ALLOWLIST_PATTERNS];
  const allowlistRegex = compileRegex(allowlistInput);
  const askedPhrases = Array.isArray(cfg.askedForTargetPhrases)
    ? [...DEFAULT_ASKED_FOR_TARGET_PHRASES, ...cfg.askedForTargetPhrases]
    : [...DEFAULT_ASKED_FOR_TARGET_PHRASES];
  const humanNames: Record<string, string> = {};
  if (cfg.humanNames && typeof cfg.humanNames === "object") {
    for (const [key, value] of Object.entries(cfg.humanNames)) {
      if (typeof value === "string") {
        humanNames[key] = value;
      }
    }
  }
  return {
    mode,
    targetUserId,
    botUserId,
    humanNames,
    cacheTtlMs: cacheTtl,
    allowlistRegex,
    askedForTargetPhrases: askedPhrases,
    slackToken: token,
  };
}

export default definePluginEntry({
  id: "slack-addressee-guard",
  name: "Slack Addressee Guard",
  description:
    "Pre-send guard that rewrites agent replies that lead with an accidental @-mention of the configured target user when a different human spoke last in the thread.",
  register(api) {
    const resolved = buildResolvedConfig(api.pluginConfig as AddresseeGuardConfig | undefined);
    if (!resolved) {
      api.logger.info?.(
        "slack-addressee-guard: disabled (missing targetUserId/botUserId/slack token or config.enabled=false)",
      );
      return;
    }

    api.on(
      "message_sending",
      async (event, ctx): Promise<AddresseeGuardMessageSendingResult> => {
        if (ctx.channelId !== "slack") {
          return undefined;
        }
        const content = normalizeString(event?.content);
        if (!content || !contentMentionsTarget(content, resolved.targetUserId)) {
          return undefined;
        }
        const target = parseChannelAndThread(
          event as Parameters<typeof parseChannelAndThread>[0],
          ctx.conversationId,
        );
        if (!target) {
          return undefined;
        }
        if (matchesAllowlist(content, resolved.allowlistRegex)) {
          return undefined;
        }

        let lastHuman = readCachedLastHuman(
          target.channelId,
          target.threadTs,
          resolved.cacheTtlMs,
        );
        if (lastHuman === undefined) {
          lastHuman = await fetchLastHumanFromSlack(
            api,
            resolved.slackToken,
            target.channelId,
            target.threadTs,
            resolved.botUserId,
          );
          writeCachedLastHuman(target.channelId, target.threadTs, lastHuman);
        }

        if (!lastHuman || !lastHuman.user) {
          return undefined;
        }
        if (lastHuman.user === resolved.targetUserId) {
          return undefined;
        }
        if (content.includes(`<@${lastHuman.user}>`)) {
          return undefined;
        }
        if (
          priorHumanAskedForTarget(
            lastHuman.text,
            resolved.targetUserId,
            resolved.askedForTargetPhrases,
          )
        ) {
          return undefined;
        }

        const priorHumanName = resolved.humanNames[lastHuman.user] ?? lastHuman.user;
        api.logger.info?.(
          `slack-addressee-guard: ${
            resolved.mode === "cancel" ? "cancelling" : "rewriting"
          } reply to ${target.channelId}:${target.threadTs} — prior human ${priorHumanName}`,
        );

        if (resolved.mode === "cancel") {
          return { cancel: true };
        }
        const next = repairContent(content, resolved.targetUserId, lastHuman.user);
        return { content: next };
      },
    );
  },
});

// Exposed for unit tests; not part of the plugin's public API.
export const __testing = {
  parseChannelAndThread,
  repairContent,
  lastHumanBeforeBot,
  priorHumanAskedForTarget,
  matchesAllowlist,
  buildResolvedConfig,
  DEFAULT_ALLOWLIST_PATTERNS,
  DEFAULT_ASKED_FOR_TARGET_PHRASES,
  clearCacheForTests(): void {
    lastHumanCache.clear();
  },
};
