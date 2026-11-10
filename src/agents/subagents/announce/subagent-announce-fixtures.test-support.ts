import { createTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export function privateRequesterRouteCases() {
  return [
    { name: "channel-less", origin: undefined, canDeliver: false },
    {
      name: "internal session target",
      origin: { channel: "internal", to: "agent:main:main" },
      canDeliver: false,
    },
    { name: "channel", origin: { channel: "discord", to: "channel:123" }, canDeliver: true },
    { name: "WebChat", origin: { channel: "webchat" }, canDeliver: true },
  ];
}

export function visibleCompletion(text: string) {
  return {
    required: true,
    resultText: text,
    terminalReply: { disposition: "visible" as const, text },
  };
}

export function pendingWake(
  batchRunIds: string[],
  overrides: Partial<NonNullable<SubagentRunRecord["requesterSettleWake"]>> = {},
): NonNullable<SubagentRunRecord["requesterSettleWake"]> {
  return { status: "pending", attemptCount: 0, batchRunIds, ...overrides };
}

export function completionReader(
  findChild: (sessionId: string) => SubagentRunRecord | undefined,
  stopReason?: string,
): typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent {
  return async ({ sessionId }, match) => {
    const child = findChild(sessionId);
    const event = {
      type: "message",
      message: {
        role: "assistant",
        display: true,
        ...(stopReason ? { stopReason } : {}),
        content: [{ type: "text", text: child?.completion?.resultText }],
        __openclaw: { runId: child?.runId },
      },
    };
    return child && matchesTranscriptEvent(event, match) ? { event } : undefined;
  };
}

export function registerDirectTargetTestChannel(channelId: string) {
  const instance = createTestInstance(channelId);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: channelId,
            capabilities: { chatTypes: ["direct", "channel"] },
          }),
          messaging: {
            inferTargetChatType: instance.wrap(({ to }: { to: string }) =>
              to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
            ),
          },
        },
      },
    ]),
  );
  return instance;
}
