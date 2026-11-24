import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  cancelStandingIntent,
  createLocationStandingIntent,
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

function parseLocationCreateParams(value: unknown):
  | {
      nodeId: string;
      direction: "enter" | "exit";
      centerLat: number;
      centerLon: number;
      radiusMeters: number;
    }
  | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("location must be an object");
  }
  const record = value as Record<string, unknown>;
  const direction = record.direction;
  if (direction !== "enter" && direction !== "exit") {
    throw new Error("location.direction must be enter or exit");
  }
  return {
    nodeId: trimRequiredString(record.nodeId, "location.nodeId", 200),
    direction,
    centerLat: readBoundedNumber(record.centerLat, "location.centerLat", -90, 90),
    centerLon: readBoundedNumber(record.centerLon, "location.centerLon", -180, 180),
    radiusMeters: readBoundedNumber(record.radiusMeters, "location.radiusMeters", 1),
  };
}

function readBoundedNumber(value: unknown, field: string, min: number, max?: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new Error(
      max !== undefined
        ? `${field} must be a finite number between ${min} and ${max}`
        : `${field} must be a finite number >= ${min}`,
    );
  }
  return value;
}
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

function parseChoice<T extends string | undefined>(
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
  /** Creating turn's session key; the only accepted location delivery target. */
  sessionKey?: string;
}): AnyAgentTool["execute"] {
  return async (_toolCallId, rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    if (params.action === "create") {
      const provider = options.provider?.trim();
      const senderId = options.senderId?.trim();
      if (!provider || !senderId) {
        const missingIdentity = [provider ? null : "channel", senderId ? null : "sender"]
          .filter(Boolean)
          .join(" and ");
        throw new Error(
          `authenticated ${missingIdentity} identity is unavailable for this turn; retry from an authenticated channel conversation`,
        );
      }
      const nowMs = Date.now();
      const locationParams = parseLocationCreateParams(params.location);
      if (locationParams) {
        if (params.triggerKeywords !== undefined) {
          throw new Error("combine either triggerKeywords or location, not both");
        }
        // Delivery binds to the authenticated creating turn's session; the
        // model cannot redirect a location reminder to an arbitrary target.
        const deliveryTarget = options.sessionKey?.trim();
        if (!deliveryTarget) {
          throw new Error(
            "location intent delivery is unavailable for this turn; retry from a conversation session",
          );
        }
        const intent = await createLocationStandingIntent({
          agentId: options.agentId,
          assertCurrent: options.assertCurrent,
          description: trimRequiredString(
            params.description,
            "description",
            INTENT_DESCRIPTION_MAX_CHARS,
          ),
          ...locationParams,
          deliveryTarget,
          creatorSender: senderId,
          expiresAt: parseExpiry(params.expiresAt, nowMs),
          sourceSessionId: options.sourceSessionId,
          nowMs,
        });
        return jsonResult({ intent, message: renderArmedIntentMessage("channel") });
      }
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
        maxFires: readPositiveIntegerParam(params, "maxFires") ?? DEFAULT_INTENT_MAX_FIRES,
        cooldownSeconds:
          readNonNegativeIntegerParam(params, "cooldownSeconds") ?? DEFAULT_INTENT_COOLDOWN_SECONDS,
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
          status: parseChoice<StandingIntentStatus | undefined>(
            params.status,
            "status",
            ["pending", "armed", "fired", "done", "cancelled", "expired"],
            undefined,
          ),
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
