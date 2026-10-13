import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listThreadBindingsBySessionKey,
  listThreadBindingsBySessionKeyAsync,
  type ThreadBindingRecord,
  type ThreadBindingTargetKind,
  unbindThreadBindingsBySessionKeyAsync,
} from "./monitor/thread-bindings.js";

type DiscordSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
};

type DiscordSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

type DiscordSubagentDeliveryTargetResult =
  | {
      origin: {
        channel: "discord";
        accountId?: string;
        to: string;
        threadId?: string | number;
      };
    }
  | undefined;

export async function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent) {
  const targetKind = normalizeOptionalLowercaseString(event.targetKind);
  await unbindThreadBindingsBySessionKeyAsync({
    targetSessionKey: event.targetSessionKey,
    accountId: event.accountId,
    targetKind: targetKind === "subagent" || targetKind === "acp" ? targetKind : undefined,
    reason: event.reason,
    sendFarewell: event.sendFarewell,
  });
}

function shouldResolveDiscordDeliveryTarget(event: DiscordSubagentDeliveryTargetEvent): boolean {
  return Boolean(
    event.expectsCompletionMessage &&
    normalizeOptionalLowercaseString(event.requesterOrigin?.channel) === "discord",
  );
}

/** @deprecated Use handleDiscordSubagentDeliveryTargetAsync; removed in the next Plugin SDK major. */
export function handleDiscordSubagentDeliveryTarget(
  event: DiscordSubagentDeliveryTargetEvent,
): DiscordSubagentDeliveryTargetResult {
  if (!shouldResolveDiscordDeliveryTarget(event)) {
    return undefined;
  }
  return resolveDiscordDeliveryTarget(
    event,
    listThreadBindingsBySessionKey({
      targetSessionKey: event.childSessionKey,
      accountId: event.requesterOrigin?.accountId?.trim() || undefined,
      targetKind: "subagent",
    }),
  );
}

export async function handleDiscordSubagentDeliveryTargetAsync(
  event: DiscordSubagentDeliveryTargetEvent,
): Promise<DiscordSubagentDeliveryTargetResult> {
  if (!shouldResolveDiscordDeliveryTarget(event)) {
    return undefined;
  }
  const bindings = await listThreadBindingsBySessionKeyAsync({
    targetSessionKey: event.childSessionKey,
    accountId: event.requesterOrigin?.accountId?.trim() || undefined,
    targetKind: "subagent",
  });
  return resolveDiscordDeliveryTarget(event, bindings);
}

function resolveDiscordDeliveryTarget(
  event: DiscordSubagentDeliveryTargetEvent,
  bindings: ThreadBindingRecord[],
): DiscordSubagentDeliveryTargetResult {
  const requesterAccountId = event.requesterOrigin?.accountId?.trim();
  const requesterThreadId = normalizeOptionalStringifiedId(event.requesterOrigin?.threadId);
  const binding =
    (requesterThreadId
      ? bindings.find(
          (entry) =>
            entry.threadId === requesterThreadId &&
            (!requesterAccountId || entry.accountId === requesterAccountId),
        )
      : undefined) ?? (bindings.length === 1 ? bindings[0] : undefined);
  if (!binding) {
    return undefined;
  }
  return {
    origin: {
      channel: "discord" as const,
      accountId: binding.accountId,
      to: `channel:${binding.threadId}`,
      threadId: binding.threadId,
    },
  };
}
