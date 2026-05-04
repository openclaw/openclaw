import { describe, expect, it } from "vitest";
import { classifyWhatsAppGroupMessageSignal } from "./group-message-signal.js";

const BOT_BROS = "120363406331109499@g.us";

function classify(
  body: string,
  overrides: Partial<Parameters<typeof classifyWhatsAppGroupMessageSignal>[0]> = {},
) {
  return classifyWhatsAppGroupMessageSignal({
    body,
    chatType: "group",
    conversationId: BOT_BROS,
    groupSubject: "bot-bros",
    nowMs: 1_800_000_000_000,
    ...overrides,
  });
}

describe("classifyWhatsAppGroupMessageSignal", () => {
  it("caps low-signal bot-bros chatter at two lines", () => {
    const result = classify("this is insane");

    expect(result.state).toBe("low_signal_burst");
    expect(result.reason).toBe("short_banter_without_task");
    expect(result.maxReplyLines).toBe(2);
    expect(result.debug.scope).toBe("bot_bros");
    expect(result.emotionPulse?.id).toBe("laugh");
    expect(result.emotionPulse?.carrier).toBe("emoji_burst");
  });

  it("treats spaced shoar summons as low-signal style, not a reason for an essay", () => {
    const result = classify("s h o a r");

    expect(result.state).toBe("low_signal_burst");
    expect(result.maxReplyLines).toBe(2);
    expect(result.debug.repetitive).toBe(true);
  });

  it("does not cap explicit depth requests", () => {
    const result = classify("shoar go in depth on what happened here");

    expect(result.state).toBe("normal");
    expect(result.reason).toBe("explicit_depth_request");
    expect(result.maxReplyLines).toBeUndefined();
    expect(result.emotionPulse?.carrier).toBe("task_reply");
  });

  it("does not cap substantive tasks", () => {
    const result = classify("shoar fix this bug");

    expect(result.state).toBe("normal");
    expect(result.reason).toBe("substantive_or_not_low_signal");
    expect(result.debug.substantiveTask).toBe(true);
    expect(result.emotionPulse?.id).toBe("work_intake");
  });

  it("caps casual bot-bros vibe turns even when they are not spammy", () => {
    const result = classify("the timing in that whole exchange actually landed cleanly");

    expect(result.state).toBe("casual_vibe");
    expect(result.reason).toBe("bot_bros_casual_vibe");
    expect(result.maxReplyLines).toBe(2);
    expect(result.debug.emotionPulseId).toBe("win");
  });

  it("does not cap explicit requests to elaborate", () => {
    const result = classify("shoar can you explain why that worked?");

    expect(result.state).toBe("normal");
    expect(result.reason).toBe("explicit_depth_request");
    expect(result.maxReplyLines).toBeUndefined();
  });

  it("caps when recent bot-bros history is a short spam burst", () => {
    const result = classify("what do you all think about this?", {
      groupHistory: [
        { sender: "A", body: "lol", timestamp: 1_799_999_930_000 },
        { sender: "B", body: "bruh", timestamp: 1_799_999_940_000 },
        { sender: "C", body: "test", timestamp: 1_799_999_950_000 },
      ],
    });

    expect(result.state).toBe("low_signal_burst");
    expect(result.reason).toBe("recent_low_signal_burst");
    expect(result.debug.recentShortCount).toBe(3);
  });

  it("leaves other groups alone", () => {
    const result = classify("this is insane", {
      conversationId: "120363000000000000@g.us",
      groupSubject: "project-room",
      groupSystemPrompt: undefined,
    });

    expect(result.state).toBe("normal");
    expect(result.reason).toBe("not_bot_bros_group");
    expect(result.maxReplyLines).toBeUndefined();
  });

  it("detects bot-bros from the current turn ownership prompt", () => {
    const result = classify("this is insane", {
      conversationId: "120363000000000000@g.us",
      groupSubject: "project-room",
      groupSystemPrompt: "BOT-BROS TURN OWNERSHIP PROTOCOL",
    });

    expect(result.state).toBe("low_signal_burst");
    expect(result.debug.scope).toBe("bot_bros");
  });

  it("leaves direct messages alone even when Brodie is mentioned", () => {
    const result = classifyWhatsAppGroupMessageSignal({
      body: "ask Brodie to check this",
      chatType: "direct",
      conversationId: "+15550001111",
    });

    expect(result.state).toBe("normal");
    expect(result.reason).toBe("direct_chat_unaffected");
  });

  it("marks bot-bros win signals with a win pulse for micro timing", () => {
    const result = classify("shoar reactions are back");

    expect(result.state).toBe("low_signal_burst");
    expect(result.emotionPulse?.id).toBe("win");
    expect(result.emotionPulse?.carrier).toBe("micro_text");
    expect(result.debug.emotionIntensity).toBe(2);
  });
});
