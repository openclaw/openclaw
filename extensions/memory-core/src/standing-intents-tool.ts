import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  cancelStandingIntent,
  createStandingIntent,
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  listStandingIntents,
  type IntentScope,
  type StandingIntentStatus,
} from "./standing-intents.js";

const INTENT_DESCRIPTION_MAX_CHARS = 500;
const INTENT_KEYWORD_MAX_COUNT = 24;
const INTENT_KEYWORD_MAX_CHARS = 120;
const STANDING_INTENT_AUTOMATION_GUIDANCE =
  "The system injects the reminder automatically when it triggers. Do not deliver it early or cancel it unless the user asks.";

type IntentSenderScope = "sender" | "anyone";
function trimRequiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new Error(`${field} must be at most ${maxChars} characters`);
  }
  return trimmed;
}

function renderArmedIntentMessage(scope: IntentScope): string {
  const scopeDescription =
    scope === "channel"
      ? "for this channel"
      : scope === "conversation"
        ? "for this conversation"
        : "everywhere";
  return `Intent is armed ${scopeDescription}. ${STANDING_INTENT_AUTOMATION_GUIDANCE}`;
}

function integerOption(value: unknown, field: string, fallback: number, minimum: 0 | 1): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be a ${minimum === 1 ? "positive" : "non-negative"} integer`);
  }
  return value;
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("triggerKeywords must be a non-empty string array");
  }
  const normalized = value.map((entry) =>
    trimRequiredString(entry, "triggerKeywords entry", INTENT_KEYWORD_MAX_CHARS).toLowerCase(),
  );
  const unique = [...new Set(normalized)];
  if (unique.length > INTENT_KEYWORD_MAX_COUNT) {
    throw new Error(`triggerKeywords must contain at most ${INTENT_KEYWORD_MAX_COUNT} entries`);
  }
  return unique;
}

function parseExpiry(value: unknown, nowMs: number): number {
  if (value === undefined) {
    return nowMs + DEFAULT_INTENT_EXPIRY_MS;
  }
  if (typeof value !== "string") {
    throw new Error("expiresAt must be an ISO 8601 timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= nowMs) {
    throw new Error("expiresAt must be a future ISO 8601 timestamp");
  }
  return parsed;
}

function parseStatus(value: unknown): StandingIntentStatus | undefined {
  return value === undefined
    ? undefined
    : parseChoice<StandingIntentStatus>(
        value,
        "status",
        ["pending", "armed", "fired", "done", "cancelled", "expired"],
        "pending",
      );
}

function parseChoice<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  const choice = allowed.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return choice;
}

export function createStandingIntentExecutor(options: {
  agentId: string;
  assertCurrent?: () => void;
  sourceSessionId?: string;
  conversationId?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
}): AnyAgentTool["execute"] {
  return async (_toolCallId, rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    if (params.action === "create") {
      const provider = options.provider?.trim();
      const senderId = options.senderId?.trim();
      if (!provider || !senderId) {
        const missingIdentity = !provider
          ? senderId
            ? "channel"
            : "channel and sender"
          : "sender";
        throw new Error(
          `authenticated ${missingIdentity} identity is unavailable for this turn; retry from an authenticated channel conversation`,
        );
      }
      const nowMs = Date.now();
      const scope = parseChoice<IntentScope>(
        params.scope,
        "scope",
        ["conversation", "channel", "anywhere"],
        "channel",
      );
      const senderScope = parseChoice<IntentSenderScope>(
        params.senderScope,
        "senderScope",
        ["sender", "anyone"],
        "sender",
      );
      const intent = await createStandingIntent({
        agentId: options.agentId,
        assertCurrent: options.assertCurrent,
        description: trimRequiredString(
          params.description,
          "description",
          INTENT_DESCRIPTION_MAX_CHARS,
        ),
        triggerKeywords: normalizeKeywords(params.triggerKeywords),
        channelScope:
          scope === "anywhere"
            ? null
            : encodeStandingIntentChannelScope({
                scope,
                provider: options.provider ?? "",
                accountId: options.accountId,
                conversationId: options.conversationId,
              }),
        senderScope:
          senderScope === "anyone"
            ? null
            : encodeStandingIntentSenderScope({
                provider: options.provider ?? "",
                accountId: options.accountId,
                senderId: options.senderId ?? "",
              }),
        creatorSender: senderId,
        expiresAt: parseExpiry(params.expiresAt, nowMs),
        maxFires: integerOption(params.maxFires, "maxFires", DEFAULT_INTENT_MAX_FIRES, 1),
        cooldownSeconds: integerOption(
          params.cooldownSeconds,
          "cooldownSeconds",
          DEFAULT_INTENT_COOLDOWN_SECONDS,
          0,
        ),
        sourceSessionId: options.sourceSessionId,
        nowMs,
      });
      return jsonResult({ intent, message: renderArmedIntentMessage(scope) });
    }
    if (params.action === "list") {
      return jsonResult({
        intents: await listStandingIntents({
          agentId: options.agentId,
          assertCurrent: options.assertCurrent,
          status: parseStatus(params.status),
        }),
      });
    }
    if (params.action === "cancel") {
      const id = trimRequiredString(params.id, "id", 200);
      const intent = await cancelStandingIntent({
        agentId: options.agentId,
        id,
        assertCurrent: options.assertCurrent,
      });
      return jsonResult({ cancelled: intent !== null, intent });
    }
    throw new Error("action must be create, list, or cancel");
  };
}
