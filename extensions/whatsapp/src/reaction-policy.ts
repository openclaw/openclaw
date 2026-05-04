import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

type WhatsAppReactionPolicySource = {
  allowedReactions?: string[];
  workIntakeReaction?: {
    emoji?: string;
    direct?: boolean;
    group?: "always" | "mentions" | "never";
    cooldownMs?: number;
    keywords?: string[];
  };
};

export type WhatsAppWorkIntakeReactionConfig = NonNullable<
  WhatsAppReactionPolicySource["workIntakeReaction"]
>;

export type ResolvedWhatsAppWorkIntakeReactionConfig = {
  emoji: string;
  direct: boolean;
  group: "always" | "mentions" | "never";
  cooldownMs: number;
  keywords?: string[];
};

const DEFAULT_WORK_INTAKE_KEYWORDS = [
  "/shoargery",
  "/shoarupdate",
  "/custompatch",
  "backend",
  "source code",
  "code",
  "patch",
  "fix",
  "debug",
  "implement",
  "build",
  "deploy",
  "restart",
  "rebuild",
  "config",
  "logs",
  "deep dive",
  "overcall",
  "document",
  "pdf",
  "deck",
  "spreadsheet",
  "automation",
  "cron",
  "gateway",
];

const WORK_INTAKE_REQUEST_PATTERN =
  /\b(can you|could you|please|pls|need you to|i want you to|okay go|go)\b[\s\S]{0,160}\b(fix|patch|change|update|build|make|write|create|run|check|investigate|read|deploy|restart|edit|implement|generate|look into)\b/;

const SELF_ADDRESS_PATTERN = /\b(shoar|s\s*h\s*o\s*a\s*r|kavish's agent|my agent)\b/;

const TASK_VERB_PATTERN =
  /\b(fix|patch|change|update|build|make|write|create|run|check|investigate|read|deploy|restart|edit|implement|generate|look into|summarize|analyse|analyze)\b/;

export function normalizeWhatsAppReactionEmojiList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const emoji = entry.trim();
    if (emoji) {
      seen.add(emoji);
    }
  }
  return Array.from(seen);
}

function getWhatsAppReactionPolicySource(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { channel?: WhatsAppReactionPolicySource; account?: WhatsAppReactionPolicySource } {
  const channel = params.cfg.channels?.whatsapp as WhatsAppReactionPolicySource | undefined;
  const account =
    params.accountId == null
      ? undefined
      : ((params.cfg.channels?.whatsapp?.accounts?.[params.accountId] as
          | WhatsAppReactionPolicySource
          | undefined) ?? undefined);
  return { channel, account };
}

export function resolveWhatsAppAllowedReactions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const source = getWhatsAppReactionPolicySource(params);
  const accountAllowed = normalizeWhatsAppReactionEmojiList(source.account?.allowedReactions);
  if (accountAllowed.length > 0) {
    return accountAllowed;
  }
  return normalizeWhatsAppReactionEmojiList(source.channel?.allowedReactions);
}

export function assertWhatsAppReactionAllowed(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  emoji: string;
}) {
  const allowed = resolveWhatsAppAllowedReactions({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (allowed.length === 0) {
    return;
  }
  if (allowed.includes(params.emoji.trim())) {
    return;
  }
  throw new Error(
    `WhatsApp reaction emoji "${params.emoji}" is not allowed. Use one of: ${allowed.join(" ")}`,
  );
}

export function resolveWhatsAppWorkIntakeReaction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppWorkIntakeReactionConfig | undefined {
  const source = getWhatsAppReactionPolicySource(params);
  const raw = source.account?.workIntakeReaction ?? source.channel?.workIntakeReaction;
  const emoji = raw?.emoji?.trim();
  if (!raw || !emoji) {
    return undefined;
  }
  return {
    emoji,
    direct: raw.direct ?? true,
    group: raw.group ?? "mentions",
    cooldownMs: raw.cooldownMs ?? 120000,
    keywords: raw.keywords,
  };
}

export function bodyLooksLikeWhatsAppWorkIntake(params: {
  body: string;
  mediaType?: string;
  config?: WhatsAppWorkIntakeReactionConfig;
}): boolean {
  const body = params.body.trim().toLowerCase();
  if (!body) {
    return false;
  }
  if (/^\/[a-z0-9_-]+/.test(body)) {
    return true;
  }
  const keywords =
    params.config?.keywords?.filter((entry): entry is string => typeof entry === "string") ??
    DEFAULT_WORK_INTAKE_KEYWORDS;
  if (keywords.some((entry) => body.includes(entry.trim().toLowerCase()))) {
    return true;
  }
  return WORK_INTAKE_REQUEST_PATTERN.test(body);
}

export function bodyLooksLikeWhatsAppGroupWorkIntake(params: {
  body: string;
  mediaType?: string;
  config?: WhatsAppWorkIntakeReactionConfig;
  selfAddressed?: boolean;
}): boolean {
  const body = params.body.trim().toLowerCase();
  if (!body) {
    return false;
  }
  if (/^\/[a-z0-9_-]+/.test(body)) {
    return true;
  }
  if (WORK_INTAKE_REQUEST_PATTERN.test(body)) {
    return true;
  }
  if (
    (params.selfAddressed === true || SELF_ADDRESS_PATTERN.test(body)) &&
    TASK_VERB_PATTERN.test(body)
  ) {
    return true;
  }
  return false;
}
