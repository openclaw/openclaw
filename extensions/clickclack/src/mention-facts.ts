import {
  buildMentionRegexes,
  normalizeMentionText,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const CLICKCLACK_MENTION_PATTERN = /(?:^|[^a-z0-9_@-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/giu;

function buildLocalMentionRegexes(params: {
  cfg?: OpenClawConfig;
  mentionPatterns: string[];
  channelId?: string;
}): RegExp[] {
  if (params.mentionPatterns.length === 0) {
    return [];
  }
  const cfg = params.cfg;
  const syntheticCfg: OpenClawConfig = {
    ...cfg,
    messages: {
      ...cfg?.messages,
      groupChat: {
        ...cfg?.messages?.groupChat,
        mentionPatterns: params.mentionPatterns,
      },
    },
  };
  return buildMentionRegexes(syntheticCfg, undefined, {
    provider: "clickclack",
    conversationId: params.channelId,
  });
}

function resolveMentionHandles(body: string): string[] {
  return [...body.matchAll(CLICKCLACK_MENTION_PATTERN)]
    .map((match) => match[1]?.toLowerCase())
    .filter((handle): handle is string => Boolean(handle));
}

export function resolveClickClackMentionFacts(params: {
  isDirect: boolean;
  body?: string;
  mentionPatterns: string[];
  botHandle?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  channelId?: string;
}) {
  const { isDirect, body, mentionPatterns, botHandle, cfg, agentId, channelId } = params;

  if (isDirect) {
    return {
      canDetectMention: false,
      wasMentioned: false,
    };
  }

  if (!body) {
    return {
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
    };
  }

  const sharedMentionRegexes = buildMentionRegexes(cfg, agentId, {
    provider: "clickclack",
    conversationId: channelId,
  });
  const localMentionRegexes = buildLocalMentionRegexes({
    cfg,
    mentionPatterns,
    channelId,
  });
  const mentionRegexes = [...sharedMentionRegexes, ...localMentionRegexes];
  const bodyForRegex = normalizeMentionText(body);
  const hasConfiguredMention = mentionRegexes.some((regex) => regex.test(bodyForRegex));

  const mentionHandles = resolveMentionHandles(body);
  const normalizedBotHandle = botHandle?.replace(/^@/u, "").trim().toLowerCase();
  const hasHandleMention = normalizedBotHandle
    ? mentionHandles.includes(normalizedBotHandle)
    : false;
  const wasMentioned = hasHandleMention || hasConfiguredMention;

  return {
    canDetectMention: true,
    wasMentioned,
    hasAnyMention: mentionHandles.length > 0 || hasConfiguredMention,
  };
}
