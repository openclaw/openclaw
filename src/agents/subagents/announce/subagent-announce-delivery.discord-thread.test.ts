// Compose Discord's public threading contract with message-tool extraction and
// the settle-turn source match for a requester that lives in a Discord thread.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../../channels/plugins/types.public.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { extractMessagingToolSend } from "../../embedded-agent-messaging-extraction.js";
import { hasMessagingToolDeliveryToSource } from "./subagent-announce-completion-delivery.js";

const THREAD_ID = "1111111111111111111";
const PARENT_ID = "2222222222222222222";

// Discord thread requesters carry the thread's own channel id as both target and thread.
const threadOrigin = {
  channel: "discord",
  to: `channel:${THREAD_ID}`,
  accountId: "default",
  threadId: THREAD_ID,
};

// The settle turn runs with the requester's route as its current source.
const settleTurnContext = {
  currentChannelId: `channel:${THREAD_ID}`,
  currentThreadId: THREAD_ID,
};

let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeAll(async () => {
  const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "channel-plugin-api.js",
  });
  snapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
});

afterAll(() => restoreActivePluginRegistrySnapshot(snapshot));

function settleResultFor(target: string) {
  const send = extractMessagingToolSend(
    "message",
    { action: "send", channel: "discord", target, message: "verified result" },
    settleTurnContext,
  );
  return {
    send,
    result: {
      didSendViaMessagingTool: true,
      messagingToolSentTargets: send ? [{ ...send, accountId: "default" }] : [],
    },
  };
}

describe("Discord thread requester settle delivery", () => {
  it("credits a message-tool send to the requester's own thread", () => {
    const { send, result } = settleResultFor(`channel:${THREAD_ID}`);

    expect(send).toMatchObject({ provider: "discord", to: `channel:${THREAD_ID}` });
    expect(send?.threadId).toBe(THREAD_ID);
    expect(hasMessagingToolDeliveryToSource(result, threadOrigin)).toBe(true);
  });

  it("does not credit a send to the thread's parent channel", () => {
    const { send, result } = settleResultFor(`channel:${PARENT_ID}`);

    expect(send?.threadId).toBeUndefined();
    expect(send?.threadImplicit).toBeUndefined();
    expect(hasMessagingToolDeliveryToSource(result, threadOrigin)).toBe(false);
  });
});
