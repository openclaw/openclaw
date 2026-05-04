import { describe, expect, it } from "vitest";
import {
  analyzeWhatsAppEmotionTextShape,
  classifyWhatsAppEmotionPulse,
  resolveWhatsAppEmotionPulseGuidance,
} from "./emotion-pulse.js";

const HOUSE_EMOJIS = ["👨🏻‍💻", "🫡", "💓", "🤣", "🤯", "💀", "🔥", "🤨", "🏆", "🥹", "💯", "😭"];

describe("WhatsApp emotion pulse", () => {
  it("classifies technical wins as short win pulses", () => {
    const result = classifyWhatsAppEmotionPulse({
      body: "shoar reactions are back",
      lowSignal: false,
      substantiveTask: false,
      depthRequested: false,
    });

    expect(result.id).toBe("win");
    expect(result.carrier).toBe("micro_text");
  });

  it("classifies pure emoji chaos bursts without adding text", () => {
    const result = classifyWhatsAppEmotionPulse({
      body: "😭😭😭💀💀",
      lowSignal: true,
      substantiveTask: false,
      depthRequested: false,
    });

    expect(result.id).toBe("laugh");
    expect(result.carrier).toBe("emoji_burst");
  });

  it("classifies real work as task reply instead of vibe", () => {
    const result = classifyWhatsAppEmotionPulse({
      body: "shoar fix this routing bug",
      lowSignal: false,
      substantiveTask: true,
      depthRequested: false,
    });

    expect(result.id).toBe("work_intake");
    expect(result.carrier).toBe("task_reply");
  });

  it("analyzes selected emoji bursts and caps separately", () => {
    const pure = analyzeWhatsAppEmotionTextShape({
      text: "🔥🔥🔥💯💯",
      allowedEmojis: HOUSE_EMOJIS,
    });
    const mixed = analyzeWhatsAppEmotionTextShape({
      text: "WE GOT IT 🔥🔥🔥💯💯",
      allowedEmojis: HOUSE_EMOJIS,
    });

    expect(pure.emojiOnly).toBe(true);
    expect(pure.emojiCount).toBe(5);
    expect(mixed.emojiOnly).toBe(false);
    expect(mixed.uppercaseWordCount).toBe(3);
    expect(mixed.emojiCount).toBe(5);
  });

  it("documents carrier constraints for prompt injection", () => {
    const guidance = resolveWhatsAppEmotionPulseGuidance({
      allowedEmojis: HOUSE_EMOJIS,
      workIntakeEmoji: "👨🏻‍💻",
    }).join("\n");

    expect(guidance).toContain("emoji_burst is 5-7 selected emojis with no text");
    expect(guidance).toContain("caps_burst is 2-5 caps words with 0-2 selected emojis");
    expect(guidance).toContain("Emotion never overrides NO_REPLY");
    expect(guidance).toContain("Brodie-finesse lesson");
  });
});
