import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveSlackAccount } from "./accounts.js";
import {
  autoBindSpawnedSlackSubagent,
  listSlackThreadBindingsBySessionKey,
  parseSlackChannelIdFromTo,
  unbindSlackThreadBindingsBySessionKey,
  type SlackBindingTargetKind,
} from "./thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

type SlackSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};

type SlackSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: string;
  reason?: string;
};

type SlackSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type SlackSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean }
  | { status: "error"; error: string }
  | undefined;

type SlackSubagentDeliveryTargetResult =
  | {
      origin: {
        channel: "slack";
        accountId?: string;
        to: string;
        threadId?: string | number;
      };
    }
  | undefined;

function normalizeSlackBindingTargetKind(raw?: string): SlackBindingTargetKind | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "subagent" || normalized === "acp") {
    return normalized;
  }
  return undefined;
}

function resolveThreadBindingFlags(api: OpenClawPluginApi, accountId?: string) {
  const account = resolveSlackAccount({
    cfg: api.config,
    accountId,
  });
  // Reuse the core 3-tier (account -> channel -> session) `enabled` chain so it
  // stays in sync with `resolveThreadBindingSpawnPolicy`. The spawn flag stays
  // local because Slack opts in explicitly (default false), unlike the core
  // helper which would default it to true for `current`-placement channels.
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: api.config,
    channel: "slack",
    accountId: account.accountId,
    kind: "subagent",
  });
  const baseThreadBindings = api.config.channels?.slack?.threadBindings;
  const accountThreadBindings =
    api.config.channels?.slack?.accounts?.[account.accountId]?.threadBindings;
  return {
    enabled: policy.enabled,
    spawnSubagentSessions:
      accountThreadBindings?.spawnSubagentSessions ??
      baseThreadBindings?.spawnSubagentSessions ??
      false,
  };
}

export async function handleSlackSubagentSpawning(
  api: OpenClawPluginApi,
  event: SlackSubagentSpawningEvent,
): Promise<SlackSubagentSpawningResult> {
  if (!event.threadRequested) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "slack") {
    return undefined;
  }
  const threadBindingFlags = resolveThreadBindingFlags(api, event.requester?.accountId);
  if (!threadBindingFlags.enabled) {
    return {
      status: "error" as const,
      error:
        "Slack thread bindings are disabled (set channels.slack.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
    };
  }
  if (!threadBindingFlags.spawnSubagentSessions) {
    return {
      status: "error" as const,
      error:
        "Slack thread-bound subagent spawns are disabled for this account (set channels.slack.threadBindings.spawnSubagentSessions=true to enable).",
    };
  }
  try {
    const agentId = event.agentId?.trim() || "subagent";
    const binding = await autoBindSpawnedSlackSubagent({
      accountId: event.requester?.accountId,
      channel: event.requester?.channel,
      to: event.requester?.to,
      threadId: event.requester?.threadId,
      childSessionKey: event.childSessionKey,
      agentId,
      label: event.label,
      boundBy: "system",
    });
    if (!binding) {
      return {
        status: "error" as const,
        error:
          "Unable to bind a Slack thread for this subagent session. Thread mode requires an existing thread_ts on the originating Slack message.",
      };
    }
    return { status: "ok" as const, threadBindingReady: true };
  } catch (err) {
    return {
      status: "error" as const,
      error: `Slack thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export function handleSlackSubagentEnded(event: SlackSubagentEndedEvent) {
  unbindSlackThreadBindingsBySessionKey({
    targetSessionKey: event.targetSessionKey,
    accountId: event.accountId,
    targetKind: normalizeSlackBindingTargetKind(event.targetKind),
    reason: event.reason,
  });
}

export function handleSlackSubagentDeliveryTarget(
  event: SlackSubagentDeliveryTargetEvent,
): SlackSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "slack") {
    return undefined;
  }
  const requesterAccountId = event.requesterOrigin?.accountId?.trim();
  const requesterThreadTs =
    event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
      ? (normalizeOptionalStringifiedId(event.requesterOrigin.threadId) ?? "")
      : "";
  const requesterChannelId = parseSlackChannelIdFromTo(event.requesterOrigin?.to) ?? "";

  const bindings = listSlackThreadBindingsBySessionKey({
    targetSessionKey: event.childSessionKey,
    ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
    targetKind: "subagent",
  });
  if (bindings.length === 0) {
    return undefined;
  }

  let binding: (typeof bindings)[number] | undefined;
  if (requesterChannelId && requesterThreadTs) {
    binding = bindings.find((entry) => {
      if (entry.channelId !== requesterChannelId || entry.threadTs !== requesterThreadTs) {
        return false;
      }
      if (requesterAccountId && entry.accountId !== requesterAccountId) {
        return false;
      }
      return true;
    });
  }
  if (!binding && requesterChannelId) {
    const byChannel = bindings.filter((entry) => entry.channelId === requesterChannelId);
    if (byChannel.length === 1) {
      binding = byChannel[0];
    }
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return undefined;
  }
  return {
    origin: {
      channel: "slack" as const,
      accountId: binding.accountId,
      to: `channel:${binding.channelId}`,
      threadId: binding.threadTs,
    },
  };
}

export function registerSlackSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event) => handleSlackSubagentSpawning(api, event));
  api.on("subagent_ended", (event) => handleSlackSubagentEnded(event));
  api.on("subagent_delivery_target", (event) => handleSlackSubagentDeliveryTarget(event));
}
