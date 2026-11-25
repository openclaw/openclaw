// Feishu tests cover conversation id plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildFeishuModelOverrideParentCandidates,
  parseFeishuDirectConversationId,
  parseFeishuTargetId,
} from "./conversation-id.js";

describe("Feishu conversation targets", () => {
  it.each([
    [undefined, undefined, undefined],
    [null, undefined, undefined],
    [42, undefined, undefined],
    [{ id: "ou_sender" }, undefined, undefined],
    ["  ", undefined, undefined],
    ["feishu: ", undefined, undefined],
    ["LARK:DM: ", undefined, undefined],
    [" feishu:UsEr: ou_sender ", "ou_sender", "ou_sender"],
    ["lark:dm:on_union", "on_union", "on_union"],
    ["open_id:ou_sender", "ou_sender", "ou_sender"],
    ["user:custom_user", "custom_user", "custom_user"],
    ["ou_sender", "ou_sender", "ou_sender"],
    ["on_union", "on_union", "on_union"],
    ["custom_user", "custom_user", undefined],
    ["FEISHU:CHAT: oc_group ", "oc_group", undefined],
    ["lark:group:oc_group", "oc_group", undefined],
    ["channel:oc_group", "oc_group", undefined],
    ["oc_group:topic:om_topic", "oc_group:topic:om_topic", undefined],
    ["feishu:lark:user:ou_sender", "lark:user:ou_sender", undefined],
  ])("preserves target and direct-conversation parsing for %j", (raw, target, direct) => {
    expect(parseFeishuTargetId(raw)).toBe(target);
    expect(parseFeishuDirectConversationId(raw)).toBe(direct);
  });
});

describe("buildFeishuModelOverrideParentCandidates", () => {
  it("returns topic and chat fallback ids for sender-scoped topics", () => {
    expect(
      buildFeishuModelOverrideParentCandidates(
        "oc_group_chat:Topic:om_topic_root:Sender:ou_topic_user",
      ),
    ).toEqual(["oc_group_chat:topic:om_topic_root", "oc_group_chat"]);
  });

  it("returns chat fallback ids for sender-scoped chats", () => {
    expect(buildFeishuModelOverrideParentCandidates("oc_group_chat:sender:ou_topic_user")).toEqual([
      "oc_group_chat",
    ]);
  });
});
