import { describe, expect, it } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";

describe("Feishu topic session delivery", () => {
  it("owns topic and sender session inheritance", () => {
    for (const [rawId, parents] of [
      ["oc_group:Topic:om_root:Sender:ou_user", ["oc_group:topic:om_root", "oc_group"]],
      ["oc_group:topic:om_root", ["oc_group"]],
    ] as const) {
      expect(
        feishuPlugin.messaging?.resolveSessionConversation?.({ kind: "group", rawId }),
      ).toEqual({
        id: rawId.toLowerCase(),
        // Core derives proactive delivery from this id; without it a topic send starts a new topic.
        threadId: "om_root",
        baseConversationId: "oc_group",
        parentConversationCandidates: parents,
      });
    }

    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group",
      }),
    ).toEqual({
      id: "oc_group",
      threadId: undefined,
      baseConversationId: "oc_group",
      parentConversationCandidates: [],
    });
  });

  it("lets core reuse a group session's route thread id for heartbeats", () => {
    // Without this opt-in a heartbeat posts a new top-level message, which starts a new topic.
    expect(feishuPlugin.messaging?.preserveHeartbeatThreadIdForGroupRoute).toBe(true);
  });
});
