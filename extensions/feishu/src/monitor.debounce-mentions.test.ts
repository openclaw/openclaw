import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./event-types.js";
import { resolveFeishuDebounceMentions } from "./monitor.message-handler.js";

const BOT = "ou_bot";

function mention(openId: string, name: string, key: string) {
  return { key, id: { open_id: openId }, name } as NonNullable<
    FeishuMessageEvent["message"]["mentions"]
  >[number];
}

function groupEvent(
  mentions: NonNullable<FeishuMessageEvent["message"]["mentions"]>,
): FeishuMessageEvent {
  return { message: { chat_type: "group", mentions } } as unknown as FeishuMessageEvent;
}

describe("resolveFeishuDebounceMentions", () => {
  it("preserves the full mention set of a mention-forward request (@bot + others)", () => {
    // A debounced burst containing an explicit "@bot @Alice" entry must keep
    // Alice so shouldExposeMentionTargets can hand the agent her open_id.
    const entry = groupEvent([mention(BOT, "Bot", "@_1"), mention("ou_alice", "Alice", "@_2")]);
    const result = resolveFeishuDebounceMentions({ entries: [entry], botOpenId: BOT });
    const ids = (result ?? []).map((m) => m.id.open_id);
    expect(ids).toContain(BOT);
    expect(ids).toContain("ou_alice");
  });

  it("filters an ordinary burst (no forward request) down to the bot mention", () => {
    const entries = [
      groupEvent([mention(BOT, "Bot", "@_1")]),
      groupEvent([mention("ou_carol", "Carol", "@_3")]),
    ];
    const result = resolveFeishuDebounceMentions({ entries, botOpenId: BOT });
    expect((result ?? []).map((m) => m.id.open_id)).toEqual([BOT]);
  });
});
