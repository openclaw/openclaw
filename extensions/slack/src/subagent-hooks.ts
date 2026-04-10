import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";

type SlackSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type SlackSubagentEndedEvent = {
  targetSessionKey: string;
};

type SlackSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
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
        threadId: string;
      };
    }
  | undefined;

export function handleSlackSubagentSpawning(
  _api: OpenClawPluginApi,
  event: SlackSubagentSpawningEvent,
): SlackSubagentSpawningResult {
  if (!event.threadRequested) {
    return undefined;
  }
  if (normalizeOptionalLowercaseString(event.requester?.channel) !== "slack") {
    return undefined;
  }
  const to = event.requester?.to?.trim();
  const threadId = normalizeOptionalStringifiedId(event.requester?.threadId);
  if (!to || !threadId) {
    return {
      status: "error",
      error: "Slack thread-bound subagent spawns require an originating channel and thread_ts.",
    };
  }
  return { status: "ok", threadBindingReady: true };
}

export function handleSlackSubagentDeliveryTarget(
  event: SlackSubagentDeliveryTargetEvent,
): SlackSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  if (normalizeOptionalLowercaseString(event.requesterOrigin?.channel) !== "slack") {
    return undefined;
  }
  const to = event.requesterOrigin?.to?.trim();
  const threadId = normalizeOptionalStringifiedId(event.requesterOrigin?.threadId);
  if (!to || !threadId) {
    return undefined;
  }
  return {
    origin: {
      channel: "slack",
      accountId: event.requesterOrigin?.accountId?.trim() || undefined,
      to,
      threadId,
    },
  };
}

export function handleSlackSubagentEnded(_event: SlackSubagentEndedEvent) {
  // Slack thread routing can resolve directly from requesterOrigin, so there is
  // no per-session binding state to clean up here.
}

export function registerSlackSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event) => handleSlackSubagentSpawning(api, event));
  api.on("subagent_delivery_target", (event) => handleSlackSubagentDeliveryTarget(event));
  api.on("subagent_ended", (event) => handleSlackSubagentEnded(event));
}
