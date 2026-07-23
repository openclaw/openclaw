import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { MatrixParticipationStrategy } from "../../types.js";

export type ParticipationAgentIdentity = {
  agentId: string;
  aliases?: readonly string[];
  mentionRegexes?: readonly RegExp[];
};

export type ParticipationDirective = {
  sourceText: string;
  mustSpeakAgentIds?: string[];
  shouldSpeakAgentIds?: string[];
  couldSpeakAgentIds?: string[];
  mustNotSpeakAgentIds?: string[];
  silence?: boolean;
};

export type ParticipationDecision = {
  directive?: ParticipationDirective;
  shouldSuppress: boolean;
  matchedAgentIds: string[];
  reason: "none" | "silence" | "must-not" | "outside-selected-speakers";
};

type ParticipationAiResult = {
  mustSpeakAgentIds?: unknown;
  shouldSpeakAgentIds?: unknown;
  couldSpeakAgentIds?: unknown;
  mustNotSpeakAgentIds?: unknown;
  silence?: unknown;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function resolveAliases(agent: ParticipationAgentIdentity): string[] {
  return unique([agent.agentId, ...(agent.aliases ?? [])].map(normalizeText));
}

function regexMatches(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  const matched = regex.test(text);
  regex.lastIndex = 0;
  return matched;
}

function matchesAgentMention(agent: ParticipationAgentIdentity, text: string): boolean {
  if (
    resolveAliases(agent).some((alias) =>
      new RegExp(`(^|[^a-z0-9_@])${escapeRegex(alias)}([^a-z0-9_]|$)`, "i").test(text),
    )
  ) {
    return true;
  }
  return (agent.mentionRegexes ?? []).some((regex) => regexMatches(regex, text));
}

function startsWithAgentMention(agent: ParticipationAgentIdentity, text: string): boolean {
  if (
    resolveAliases(agent).some((alias) =>
      new RegExp(`^@?${escapeRegex(alias)}(?:[,:!?]|\\s|$)`, "i").test(text),
    )
  ) {
    return true;
  }
  return (agent.mentionRegexes ?? []).some((regex) => {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    regex.lastIndex = 0;
    return match?.index === 0;
  });
}

export function findParticipationMentionedAgents(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
}): string[] {
  const text = normalizeText(params.text);
  if (!text) {
    return [];
  }
  const matched: string[] = [];
  for (const agent of params.availableAgents) {
    if (matchesAgentMention(agent, text)) {
      matched.push(agent.agentId);
    }
  }
  return unique(matched);
}

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

function extractJsonObject(text: string): ParticipationAiResult | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, trimmed].filter((value): value is string => Boolean(value))) {
    try {
      return JSON.parse(candidate) as ParticipationAiResult;
    } catch {}
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as ParticipationAiResult;
      } catch {}
    }
  }
  return undefined;
}

export function resolveParticipationDirectiveFromAiResult(params: {
  text: string;
  result: ParticipationAiResult | undefined;
  availableAgents: readonly ParticipationAgentIdentity[];
}): ParticipationDirective | undefined {
  const allowedIds = new Set(params.availableAgents.map((agent) => agent.agentId));
  const mustSpeakAgentIds = sanitizeAgentIds(params.result?.mustSpeakAgentIds, allowedIds);
  const shouldSpeakAgentIds = sanitizeAgentIds(params.result?.shouldSpeakAgentIds, allowedIds);
  const couldSpeakAgentIds = sanitizeAgentIds(params.result?.couldSpeakAgentIds, allowedIds);
  const mustNotSpeakAgentIds = sanitizeAgentIds(params.result?.mustNotSpeakAgentIds, allowedIds);
  const silence = params.result?.silence === true;
  if (
    !silence &&
    !mustSpeakAgentIds?.length &&
    !shouldSpeakAgentIds?.length &&
    !couldSpeakAgentIds?.length &&
    !mustNotSpeakAgentIds?.length
  ) {
    return undefined;
  }
  return {
    sourceText: params.text,
    ...(mustSpeakAgentIds ? { mustSpeakAgentIds } : {}),
    ...(shouldSpeakAgentIds ? { shouldSpeakAgentIds } : {}),
    ...(couldSpeakAgentIds ? { couldSpeakAgentIds } : {}),
    ...(mustNotSpeakAgentIds ? { mustNotSpeakAgentIds } : {}),
    ...(silence ? { silence: true } : {}),
  };
}

export function parseParticipationDirectiveDeterministic(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  explicitMentionOnly?: boolean;
}): ParticipationDirective | undefined {
  const normalized = normalizeText(params.text);
  if (!normalized) {
    return undefined;
  }
  if (
    /\b(?:nobody|no one|none of you)\b.*\b(?:reply|respond|weigh in|answer|speak)\b/.test(
      normalized,
    ) ||
    /\b(?:do not|don't)\s+(?:reply|respond|weigh in|answer|speak)\b/.test(normalized)
  ) {
    return { sourceText: params.text, silence: true };
  }
  const mentionedAgentIds = findParticipationMentionedAgents(params);
  if (mentionedAgentIds.length === 0) {
    return undefined;
  }
  if (
    /(?:\ball agents\b|\beveryone\b|\beverybody\b).*\bexcept\b/.test(normalized) ||
    /\b(?:everyone|everybody|all agents)\b.*\bnot\b/.test(normalized)
  ) {
    return {
      sourceText: params.text,
      mustNotSpeakAgentIds: mentionedAgentIds,
    };
  }
  if (
    params.explicitMentionOnly ||
    /\b(?:only|just)\b/.test(normalized) ||
    /\b(?:reply|respond|weigh in|answer|take this|handle this|check this)\b/.test(normalized) ||
    mentionedAgentIds.some((agentId) => {
      const agent = params.availableAgents.find((entry) => entry.agentId === agentId);
      return startsWithAgentMention(agent ?? { agentId }, normalized);
    })
  ) {
    return {
      sourceText: params.text,
      shouldSpeakAgentIds: mentionedAgentIds,
    };
  }
  return undefined;
}

async function parseParticipationDirectiveWithAi(params: {
  text: string;
  availableAgents: readonly ParticipationAgentIdentity[];
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  recentHistory?: readonly { sender?: string; body?: string }[];
  log?: (message: string) => void;
}): Promise<ParticipationDirective | undefined> {
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
    const completion = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: [
        {
          role: "system",
          content:
            'Classify which OpenClaw agents should answer a Matrix group-chat turn. Return JSON only with schema {"mustSpeakAgentIds":string[],"shouldSpeakAgentIds":string[],"couldSpeakAgentIds":string[],"mustNotSpeakAgentIds":string[],"silence":boolean}. Use only listed agent ids. If the turn directly addresses one or more agents, put those agents in shouldSpeakAgentIds and put no others in couldSpeakAgentIds. If it says nobody/no one/do not reply, set silence true. If it says everyone except named agents, put named agents in mustNotSpeakAgentIds. Leave all arrays empty and silence false when there is no participation instruction.',
        },
        {
          role: "user",
          content: JSON.stringify({
            text: params.text,
            availableAgents: params.availableAgents.map((agent) => ({
              agentId: agent.agentId,
              aliases: resolveAliases(agent),
            })),
            recentHistory: (params.recentHistory ?? []).slice(-6),
          }),
        },
      ] as never,
      options: { maxTokens: 220 } as never,
    });
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
  strategy?: MatrixParticipationStrategy;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelRef?: string;
  explicitMentionOnly?: boolean;
  recentHistory?: readonly { sender?: string; body?: string }[];
  log?: (message: string) => void;
}): Promise<ParticipationDirective | undefined> {
  const strategy = params.strategy ?? "ai-first";
  if (strategy === "deterministic") {
    return parseParticipationDirectiveDeterministic({
      text: params.text,
      availableAgents: params.availableAgents,
      explicitMentionOnly: params.explicitMentionOnly,
    });
  }
  if (!params.cfg || !params.agentId) {
    return undefined;
  }
  return await parseParticipationDirectiveWithAi({
    text: params.text,
    availableAgents: params.availableAgents,
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    recentHistory: params.recentHistory,
    log: params.log,
  });
}

export function resolveParticipationDecision(params: {
  agentId: string;
  directive?: ParticipationDirective;
}): ParticipationDecision {
  const directive = params.directive;
  if (!directive) {
    return { shouldSuppress: false, matchedAgentIds: [], reason: "none" };
  }
  if (directive.silence === true) {
    return { directive, shouldSuppress: true, matchedAgentIds: [], reason: "silence" };
  }
  const mustNotSpeakAgentIds = unique(directive.mustNotSpeakAgentIds ?? []);
  if (mustNotSpeakAgentIds.includes(params.agentId)) {
    return {
      directive,
      shouldSuppress: true,
      matchedAgentIds: mustNotSpeakAgentIds,
      reason: "must-not",
    };
  }
  const selectedSpeakerIds = unique([
    ...(directive.mustSpeakAgentIds ?? []),
    ...(directive.shouldSpeakAgentIds ?? []),
    ...(directive.couldSpeakAgentIds ?? []),
  ]);
  if (selectedSpeakerIds.length > 0 && !selectedSpeakerIds.includes(params.agentId)) {
    return {
      directive,
      shouldSuppress: true,
      matchedAgentIds: selectedSpeakerIds,
      reason: "outside-selected-speakers",
    };
  }
  return {
    directive,
    shouldSuppress: false,
    matchedAgentIds: selectedSpeakerIds,
    reason: "none",
  };
}
