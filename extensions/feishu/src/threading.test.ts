import { describe, expect, it } from "vitest";
import { feishuThreadingAdapter } from "./threading.js";

describe("Feishu threading adapter", () => {
  it("keeps native chat identity separate from delivery routing", () => {
    expect(
      feishuThreadingAdapter.buildToolContext({
        context: { To: "user:ou_sender", NativeChannelId: "oc_direct_chat", ChatType: "direct" },
      }),
    ).toMatchObject({
      currentChannelId: "oc_direct_chat",
      currentChatType: "direct",
      currentMessagingTarget: "user:ou_sender",
    });
  });

  it("keeps internal trigger ids out of implicit reply anchors", () => {
    const buildToolContext = (CurrentMessageId: string) =>
      feishuThreadingAdapter.buildToolContext({
        context: { To: "chat:oc_group", ChatType: "group", CurrentMessageId },
      });

    expect(buildToolContext("om_inbound")).toMatchObject({ currentMessageId: "om_inbound" });
    // Queued, cron, and cross-session turns carry an internal run id. The explicit
    // undefined tells the shared owner not to fall back to it (#167270).
    expect(buildToolContext("b6a9fb30-6bc6-4a52-8f1e-3c2d7e9a4b10")).toHaveProperty(
      "currentMessageId",
      undefined,
    );
  });
});
