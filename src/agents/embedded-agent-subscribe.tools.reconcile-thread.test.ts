import { afterEach, describe, expect, it } from "vitest";
import { mattermostPlugin } from "../../extensions/mattermost/src/channel.js";
import { getMatchingMessagingToolReplyTargets } from "../auto-reply/reply/reply-payloads-dedupe.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
} from "./embedded-agent-subscribe.tools.js";

function registerMattermost(): void {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: mattermostPlugin.id, source: "test", plugin: mattermostPlugin },
    ]),
  );
}

describe("extractMessagingToolSendResult thread evidence", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("preserves implicit thread evidence when the provider result omits it", () => {
    registerMattermost();

    const pending = extractMessagingToolSend(
      "message",
      { action: "send", provider: "mattermost", to: "channel:abc", message: "answer" },
      {
        currentChannelId: "channel:abc",
        currentMessagingTarget: "channel:abc",
        currentThreadId: "root-1",
        replyToMode: "all",
      },
    );
    expect(pending?.threadImplicit).toBe(true);
    expect(pending?.threadId).toBe("root-1");

    const confirmed = extractMessagingToolSendResult(pending!, {
      details: { toolSend: { to: "channel:abc" } },
    });
    expect(confirmed.threadImplicit).toBe(true);
    expect(confirmed.threadId).toBe("root-1");

    const matches = getMatchingMessagingToolReplyTargets({
      messageProvider: "mattermost",
      originatingTo: "channel:abc",
      originatingThreadId: "root-1",
      messagingToolSentTargets: [confirmed],
    });
    expect(matches).toHaveLength(1);
  });

  it("lets an explicit provider-reported thread override pending implicit evidence", () => {
    registerMattermost();

    const confirmed = extractMessagingToolSendResult(
      { tool: "message", provider: "mattermost", to: "channel:abc", threadImplicit: true },
      { details: { toolSend: { to: "channel:abc", threadId: "root-9" } } },
    );
    expect(confirmed.threadId).toBe("root-9");
    expect(confirmed.threadImplicit).toBeUndefined();
  });
});
