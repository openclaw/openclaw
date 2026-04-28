import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";

export type ParticipationDirectiveMode = "open" | "subset_only" | "exclude_subset" | "silence";
export type ParticipationDirectivePersistence = "message" | "room";
export type ParticipationParseStrategy =
  | "ai-first"
  | "deterministic"
  | "ai-delivery-gate"
  | "deterministic-then-ai";

export type ParticipationDirective = {
  mode: ParticipationDirectiveMode;
  includeAgentIds?: string[];
  excludeAgentIds?: string[];
  sourceText: string;
  persistence: ParticipationDirectivePersistence;
  clearsStoredPolicy?: boolean;
};

export type ParticipationAgentIdentity = { agentId: string; aliases?: readonly string[] };

export type ParticipationDecision = {
  directive?: ParticipationDirective;
  currentDirective?: ParticipationDirective;
  storedDirective?: ParticipationDirective;
  shouldSuppress: boolean;
  matchedAgentIds: string[];
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveMentionableAliases(agentId: string, aliases?: readonly string[]): string[] {
  return unique([agentId, ...(aliases ?? [])].map((v) => normalizeText(v)).filter(Boolean));
}

export function findParticipationMentionedAgents(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
}): string[] {
  const text = normalizeText(params.text);
  const matched: string[] = [];
  for (const agent of params.availableAgents) {
    const aliases = resolveMentionableAliases(agent.agentId, agent.aliases);
    if (
      aliases.some((alias) =>
        new RegExp(`(^|[^a-z0-9_])${escapeRegex(alias)}([^a-z0-9_]|$)`, "i").test(text),
      )
    ) {
      matched.push(agent.agentId);
    }
  }
  return unique(matched);
}

function hasEphemeralDirectiveLanguage(normalized: string): boolean {
  return (
    /\bjust this (?:message|turn|time)\b/.test(normalized) ||
    /\bfor this (?:message|turn)(?: only)?\b/.test(normalized) ||
    /\bone message only\b/.test(normalized) ||
    /\bthis one\b/.test(normalized) ||
    /\bfor now\b/.test(normalized) ||
    /\btemporar(?:y|ily)\b/.test(normalized) ||
    /\bfor the moment\b/.test(normalized)
  );
}

function buildDirective(params: {
  mode: ParticipationDirectiveMode;
  sourceText: string;
  normalizedText: string;
  includeAgentIds?: string[];
  excludeAgentIds?: string[];
  clearsStoredPolicy?: boolean;
}): ParticipationDirective {
  return {
    mode: params.mode,
    sourceText: params.sourceText,
    persistence: hasEphemeralDirectiveLanguage(params.normalizedText) ? "message" : "room",
    ...(params.includeAgentIds ? { includeAgentIds: params.includeAgentIds } : {}),
    ...(params.excludeAgentIds ? { excludeAgentIds: params.excludeAgentIds } : {}),
    ...(params.clearsStoredPolicy ? { clearsStoredPolicy: true } : {}),
  };
}

export function parseParticipationDirective(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  explicitMentionOnly?: boolean;
}): ParticipationDirective | undefined {
  const normalized = normalizeText(params.text);
  if (!normalized) {
    return undefined;
  }

  if (
    /\b(?:nobody|no one|none of you)\b.*\b(?:reply|respond|weigh in|answer)\b/.test(normalized) ||
    /\b(?:don['’]t|do not)\s+(?:reply|respond|weigh in)\b/.test(normalized)
  ) {
    return buildDirective({ mode: "silence", sourceText: params.text, normalizedText: normalized });
  }

  const mentionedAgents = findParticipationMentionedAgents(params);
  if (
    /(?:\ball agents\b|\beveryone\b|\beverybody\b).*\bexcept\b/.test(normalized) &&
    mentionedAgents.length > 0
  ) {
    return buildDirective({
      mode: "exclude_subset",
      excludeAgentIds: mentionedAgents,
      sourceText: params.text,
      normalizedText: normalized,
    });
  }
  if (mentionedAgents.length > 0 && params.explicitMentionOnly) {
    return buildDirective({
      mode: "subset_only",
      includeAgentIds: mentionedAgents,
      sourceText: params.text,
      normalizedText: normalized,
    });
  }
  if (
    /\b(?:all agents|everyone|everybody)\b.*\b(?:can reply|can respond|reply again|respond again|jump in again|weigh in again)\b/.test(
      normalized,
    ) ||
    /\b(?:all agents|everyone|everybody)\b.*\bagain\b.*\b(?:reply|respond|jump in|weigh in)\b/.test(
      normalized,
    ) ||
    /\ball agents can reply again\b/.test(normalized)
  ) {
    return buildDirective({
      mode: "open",
      sourceText: params.text,
      normalizedText: normalized,
      clearsStoredPolicy: true,
    });
  }
  if (
    mentionedAgents.length > 0 &&
    (/(?:^|\s)(?:can|could|would|will|should|do|does|did|are|is)/.test(normalized) ||
      /(?:do you agree|what do you think|are you there|handle this|take this|please|check this)/.test(
        normalized,
      ) ||
      mentionedAgents.some((agentId) => {
        const agent = params.availableAgents.find((entry) => entry.agentId === agentId);
        const aliases = resolveMentionableAliases(agentId, agent?.aliases);
        return aliases.some((alias) =>
          new RegExp(`^(?:${escapeRegex(alias)})(?:[,:!?]|\\s|$)`, "i").test(normalized),
        );
      }))
  ) {
    return buildDirective({
      mode: "subset_only",
      includeAgentIds: mentionedAgents,
      sourceText: params.text,
      normalizedText: normalized,
    });
  }
  if (mentionedAgents.length === 0) {
    return undefined;
  }
  if (
    /\b(?:only|just)\b/.test(normalized) ||
    /\b(?:reply|respond|weigh in|answer|take this)\b/.test(normalized)
  ) {
    return buildDirective({
      mode: "subset_only",
      includeAgentIds: mentionedAgents,
      sourceText: params.text,
      normalizedText: normalized,
    });
  }
  return undefined;
}

type ParticipationAiDecision = {
  action?: string;
  includeAgentIds?: unknown;
  excludeAgentIds?: unknown;
  persistence?: string;
  clearsStoredPolicy?: boolean;
};

function sanitizeAgentIds(value: unknown, allowedIds: Set<string>): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = unique(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry && allowedIds.has(entry)),
  );
  return out.length > 0 ? out : undefined;
}

function extractJsonObject(text: string): ParticipationAiDecision | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, trimmed].filter((v): v is string => Boolean(v))) {
    try {
      return JSON.parse(candidate) as ParticipationAiDecision;
    } catch {}
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as ParticipationAiDecision;
      } catch {}
    }
  }
  return undefined;
}

export function resolveParticipationDirectiveFromAiResult(params: {
  text: string;
  result: ParticipationAiDecision | undefined;
  availableAgents: readonly ParticipationAgentIdentity[];
}): ParticipationDirective | undefined {
  const normalizedText = normalizeText(params.text);
  const allowedIds = new Set(params.availableAgents.map((entry) => entry.agentId));
  const action = typeof params.result?.action === "string" ? params.result.action.trim() : "";
  if (
    !action ||
    action === "none" ||
    !["open", "subset_only", "exclude_subset", "silence"].includes(action)
  ) {
    return undefined;
  }
  const persistence =
    params.result?.persistence === "message" || params.result?.persistence === "room"
      ? params.result.persistence
      : hasEphemeralDirectiveLanguage(normalizedText)
        ? "message"
        : "room";
  const includeAgentIds = sanitizeAgentIds(params.result?.includeAgentIds, allowedIds);
  const excludeAgentIds = sanitizeAgentIds(params.result?.excludeAgentIds, allowedIds);
  if (action === "subset_only" && !includeAgentIds?.length) {
    return undefined;
  }
  if (action === "exclude_subset" && !excludeAgentIds?.length) {
    return undefined;
  }
  return {
    mode: action as ParticipationDirectiveMode,
    sourceText: params.text,
    persistence,
    ...(includeAgentIds ? { includeAgentIds } : {}),
    ...(excludeAgentIds ? { excludeAgentIds } : {}),
    ...(params.result?.clearsStoredPolicy ? { clearsStoredPolicy: true } : {}),
  };
}

export async function parseParticipationDirectiveWithAiOverride(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  strategy?: ParticipationParseStrategy;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelRef?: string;
  abortSignal?: AbortSignal;
  explicitMentionedAgentIds?: readonly string[];
  recentHistory?: readonly { sender?: string; body?: string }[];
  log?: (message: string) => void;
}): Promise<ParticipationDirective | undefined> {
  const strategy = params.strategy ?? "ai-first";
  if (
    !["ai-first", "ai-delivery-gate", "deterministic-then-ai"].includes(strategy) ||
    !params.cfg ||
    !params.agentId
  ) {
    return undefined;
  }
  try {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: params.modelRef,
    });
    if ("error" in prepared) {
      params.log?.(`matrix participation ai parser unavailable: ${prepared.error}`);
      return undefined;
    }
    const aliases = params.availableAgents.map((agent) => ({
      agentId: agent.agentId,
      aliases: resolveMentionableAliases(agent.agentId, agent.aliases),
    }));
    const completion = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model as never,
      auth: prepared.auth as never,
      context: [
        {
          role: "system",
          content:
            'You classify Matrix group-chat participation directives for agents. Return JSON only. Schema: {"action":"none|open|subset_only|exclude_subset|silence","includeAgentIds?:string[],"excludeAgentIds?:string[],"persistence":"message|room","clearsStoredPolicy?:boolean}. Default persistence must be room unless the message is explicitly temporary. Never invent agent ids. If one or more agent ids are explicitly mentioned, default to subset_only for the mentioned agents unless the message clearly invites everyone, excludes a subset, or resets the room. Direct named-address questions like "Argus do you agree?", "Sentinel, what do you think?", and "@forge can you check this" should normally be subset_only for the addressed agent(s).',
        },
        {
          role: "user",
          content: JSON.stringify({
            text: params.text,
            availableAgents: aliases,
            explicitMentionedAgentIds: params.explicitMentionedAgentIds ?? [],
            recentHistory: (params.recentHistory ?? []).slice(-6),
            rules: {
              temporaryExamples: [
                "just this message",
                "for this turn only",
                "temporarily",
                "for now",
              ],
              resetExamples: ["all agents can reply again", "everyone can reply again"],
            },
          }),
        },
      ] as never,
      options: { maxTokens: 220, signal: params.abortSignal } as never,
    } as never);
    return resolveParticipationDirectiveFromAiResult({
      text: params.text,
      result: extractJsonObject((completion as { text?: string }).text ?? ""),
      availableAgents: params.availableAgents,
    });
  } catch (err) {
    params.log?.(`matrix participation ai parser failed: ${String(err)}`);
    return undefined;
  }
}

export async function parseParticipationDirectiveWithStrategy(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  strategy?: ParticipationParseStrategy;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelRef?: string;
  abortSignal?: AbortSignal;
  explicitMentionOnly?: boolean;
  explicitMentionedAgentIds?: readonly string[];
  recentHistory?: readonly { sender?: string; body?: string }[];
  log?: (message: string) => void;
}): Promise<ParticipationDirective | undefined> {
  if ((params.strategy ?? "ai-first") === "deterministic") {
    return parseParticipationDirective({
      text: params.text,
      availableAgents: params.availableAgents,
      explicitMentionOnly: params.explicitMentionOnly,
    });
  }
  return parseParticipationDirectiveWithAiOverride(params);
}

export function resolveParticipationDecision(params: {
  agentId: string;
  text?: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  currentDirective?: ParticipationDirective;
  storedDirective?: ParticipationDirective;
}): ParticipationDecision {
  const currentDirective =
    params.currentDirective ??
    (typeof params.text === "string"
      ? parseParticipationDirective({ text: params.text, availableAgents: params.availableAgents })
      : undefined);
  const effectiveDirective = currentDirective ?? params.storedDirective;
  if (!effectiveDirective) {
    return {
      currentDirective,
      storedDirective: params.storedDirective,
      shouldSuppress: false,
      matchedAgentIds: [],
    };
  }
  if (effectiveDirective.mode === "open") {
    return {
      directive: effectiveDirective,
      currentDirective,
      storedDirective: params.storedDirective,
      shouldSuppress: false,
      matchedAgentIds: [],
    };
  }
  if (effectiveDirective.mode === "silence") {
    return {
      directive: effectiveDirective,
      currentDirective,
      storedDirective: params.storedDirective,
      shouldSuppress: true,
      matchedAgentIds: [],
    };
  }
  if (effectiveDirective.mode === "subset_only") {
    const matchedAgentIds = unique(effectiveDirective.includeAgentIds ?? []);
    return {
      directive: effectiveDirective,
      currentDirective,
      storedDirective: params.storedDirective,
      matchedAgentIds,
      shouldSuppress: !matchedAgentIds.includes(params.agentId),
    };
  }
  const matchedAgentIds = unique(effectiveDirective.excludeAgentIds ?? []);
  return {
    directive: effectiveDirective,
    currentDirective,
    storedDirective: params.storedDirective,
    matchedAgentIds,
    shouldSuppress: matchedAgentIds.includes(params.agentId),
  };
}
