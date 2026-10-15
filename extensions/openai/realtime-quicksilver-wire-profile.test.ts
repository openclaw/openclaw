import { describe, expect, it } from "vitest";
import { buildOpenAIQuicksilverSession } from "./realtime-quicksilver-wire.js";

describe("GPT-Live session shaping", () => {
  it("defaults a released-only voice to Marin on the unlisted route", () => {
    expect(
      buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary", voice: "spruce" }).audio,
    ).toEqual({ output: { voice: "marin" } });
  });

  it("bounds initial items to the newest context", () => {
    const session = buildOpenAIQuicksilverSession({
      model: "gpt-live-test-canary",
      initialItems: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `${index}:${"x".repeat(1_000)}`,
      })),
    });

    expect(session.initial_items).toHaveLength(10);
    expect(session.initial_items?.[0]?.content[0]?.text).toMatch(/^10:/);
    expect(session.initial_items?.at(-1)?.content[0]?.text).toMatch(/^19:/);
    expect(session.initial_items?.every((item) => item.content[0]?.text.length === 800)).toBe(true);
  });
});
