import { createHash } from "node:crypto";
import type {
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  StartedOpenClawCrablineCorrelatedAdapter,
} from "@openclaw/crabline";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { parseQaTarget } from "./qa-bus-protocol.js";

const MATRIX_QA_SERVER_NAME = "matrix-qa.test";
const MATRIX_QA_DRIVER_ID = `@driver:${MATRIX_QA_SERVER_NAME}`;
const DISCORD_ID_PATTERN = /^\d{17,20}$/u;
const DISCORD_ID_FLOOR = 100_000_000_000_000_000n;

export function resolveDiscordQaId(value: string) {
  const trimmed = value.trim();
  if (DISCORD_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const digest = BigInt(`0x${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`);
  return String(DISCORD_ID_FLOOR + (digest % DISCORD_ID_FLOOR));
}

function resolveMatrixQaSenderId(senderId: string) {
  return senderId === "driver"
    ? MATRIX_QA_DRIVER_ID
    : senderId === "observer"
      ? `@observer:${MATRIX_QA_SERVER_NAME}`
      : senderId;
}

function resolveMatrixQaConversationId(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    throw new Error("Matrix QA conversation id must be non-empty");
  }
  const explicitTarget = normalizeExplicitMatrixTarget(trimmed);
  if (explicitTarget) {
    return explicitTarget;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `!${digest}:${MATRIX_QA_SERVER_NAME}`;
}

function normalizeExplicitMatrixTarget(target: string) {
  let normalized = target.trim();
  for (const prefix of ["matrix:", "room:", "user:"]) {
    if (normalized.toLowerCase().startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trim();
    }
  }
  return /^[!@#]/u.test(normalized) && normalized.includes(":") ? normalized : undefined;
}

function encodeQaThreadComponent(value: string) {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function translateQaTarget(
  target: string,
  resolveConversationId: (value: string) => string,
  resolveThreadId: (value: string) => string,
  prefixes: readonly string[],
) {
  if (target.startsWith("thread:")) {
    if (target.startsWith("thread:/v1/")) {
      const parsed = parseQaTarget(target);
      const kind = parsed.chatType === "direct" ? "dm" : "group";
      return `thread:/v1/${kind}/${encodeQaThreadComponent(resolveConversationId(parsed.conversationId))}/${encodeQaThreadComponent(resolveThreadId(parsed.threadId ?? ""))}`;
    }
    const threadTarget = target.slice("thread:".length);
    const separator = threadTarget.indexOf("/");
    if (separator > 0) {
      return `thread:${resolveConversationId(threadTarget.slice(0, separator))}/${resolveThreadId(threadTarget.slice(separator + 1))}`;
    }
  }
  for (const prefix of prefixes) {
    if (target.startsWith(prefix)) {
      return `${prefix}${resolveConversationId(target.slice(prefix.length))}`;
    }
  }
  return resolveConversationId(target);
}

function resolveQaMention(text: string, mention: string) {
  return text.replace(
    /(^|[\s([{])@openclaw(?=$|[\s.,!?;)\]}])/gu,
    (_match, prefix: string) => `${prefix}${mention}`,
  );
}

function resolveDiscordQaTarget(target: string) {
  return translateQaTarget(target.trim(), resolveDiscordQaId, resolveDiscordQaId, [
    "channel:",
    "group:",
    "dm:",
    "user:",
  ]);
}

function resolveMatrixQaTarget(target: string) {
  return (
    normalizeExplicitMatrixTarget(target) ??
    translateQaTarget(target, resolveMatrixQaConversationId, (threadId) => threadId, [
      "channel:",
      "group:",
      "dm:",
    ])
  );
}

export function createCrablineProviderInboundInput(
  adapter: StartedOpenClawCrablineCorrelatedAdapter,
  input: QaBusInboundMessageInput,
): OpenClawCrablineInboundInput {
  const kind = input.conversation.kind === "direct" ? "direct" : "group";
  return {
    ...input,
    conversation: {
      ...input.conversation,
      id:
        adapter.channel === "matrix"
          ? resolveMatrixQaConversationId(input.conversation.id)
          : adapter.channel === "discord"
            ? resolveDiscordQaId(input.conversation.id)
            : input.conversation.id,
      kind,
    },
    senderId:
      adapter.channel === "matrix"
        ? resolveMatrixQaSenderId(input.senderId)
        : adapter.channel === "discord"
          ? resolveDiscordQaId(input.senderId)
          : input.senderId,
    text:
      adapter.channel === "matrix" && adapter.manifest.provider === "matrix"
        ? resolveQaMention(input.text, adapter.manifest.botUserId)
        : adapter.channel === "discord" && adapter.manifest.provider === "discord"
          ? resolveQaMention(input.text, `<@${adapter.manifest.botUserId}>`)
          : input.text,
    ...(input.threadId && adapter.channel === "discord"
      ? { threadId: resolveDiscordQaId(input.threadId) }
      : {}),
  };
}

export function resolveCrablineStateConversation(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  input: QaBusInboundMessageInput;
  providerInbound: OpenClawCrablineInbound;
}) {
  return params.adapter.channel === "matrix" || params.adapter.channel === "discord"
    ? params.input.conversation
    : params.providerInbound.stateConversation;
}

export function createCrablineProviderDelivery(
  adapter: Pick<StartedOpenClawCrablineCorrelatedAdapter, "channel" | "createAgentDelivery">,
  target: string,
  threadId?: string,
) {
  const { providerTargetKey, ...delivery } = adapter.createAgentDelivery({
    target:
      adapter.channel === "matrix"
        ? resolveMatrixQaTarget(target)
        : adapter.channel === "discord"
          ? resolveDiscordQaTarget(target)
          : target,
    threadId: adapter.channel === "discord" && threadId ? resolveDiscordQaId(threadId) : threadId,
  });
  return { delivery, providerTargetKey };
}

export function createCrablineProviderCorrelation(
  adapter: StartedOpenClawCrablineCorrelatedAdapter,
  target: Pick<QaBusInboundMessageInput, "conversation" | "threadId">,
) {
  return adapter.createInbound({
    input: createCrablineProviderInboundInput(adapter, {
      conversation: target.conversation,
      senderId: target.conversation.kind === "direct" ? target.conversation.id : "driver",
      text: "QA provider correlation",
      ...(target.threadId ? { threadId: target.threadId } : {}),
    }),
  });
}
