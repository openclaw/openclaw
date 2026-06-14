import { describe, expect, it } from "vitest";
import {
  GROUP_CALL_GATE_DEFAULTS,
  type GroupCallGateConfig,
  isAddressed,
  resolveGroupCallGateConfig,
  shouldRespondToGroupTurn,
} from "./group-call-gate.js";

describe("resolveGroupCallGateConfig", () => {
  it("returns the defaults for undefined / empty input", () => {
    expect(resolveGroupCallGateConfig(undefined)).toEqual(GROUP_CALL_GATE_DEFAULTS);
    expect(resolveGroupCallGateConfig({})).toEqual(GROUP_CALL_GATE_DEFAULTS);
  });

  it("keeps provided fields and fills only the missing ones", () => {
    expect(resolveGroupCallGateConfig({ requireAddress: false })).toEqual({
      requireAddress: false,
      wakePhrases: GROUP_CALL_GATE_DEFAULTS.wakePhrases,
      followUpWindowMs: GROUP_CALL_GATE_DEFAULTS.followUpWindowMs,
    });
    expect(resolveGroupCallGateConfig({ wakePhrases: ["aria"], followUpWindowMs: 0 })).toEqual({
      requireAddress: true,
      wakePhrases: ["aria"],
      followUpWindowMs: 0,
    });
  });
});

const CONFIG: GroupCallGateConfig = {
  requireAddress: true,
  wakePhrases: ["assistant", "aria"],
  followUpWindowMs: 10_000,
};

describe("isAddressed", () => {
  it("matches a wake phrase regardless of case", () => {
    expect(isAddressed("Assistant, what's on my screen?", CONFIG.wakePhrases)).toBe(true);
    expect(isAddressed("hey ARIA can you help", CONFIG.wakePhrases)).toBe(true);
  });

  it("matches at a punctuation/edge boundary but not inside another word", () => {
    expect(isAddressed("aria!", CONFIG.wakePhrases)).toBe(true);
    expect(isAddressed("assistantship program", CONFIG.wakePhrases)).toBe(false);
    expect(isAddressed("mariana told me", CONFIG.wakePhrases)).toBe(false);
  });

  it("does not match when the bot is not named", () => {
    expect(isAddressed("so what do you think about the budget", CONFIG.wakePhrases)).toBe(false);
  });

  it("never matches with no phrases", () => {
    expect(isAddressed("assistant", [])).toBe(false);
  });
});

describe("shouldRespondToGroupTurn", () => {
  it("always responds in a 1:1 call (not a group)", () => {
    const r = shouldRespondToGroupTurn({
      transcript: "what time is it",
      isGroup: false,
      config: CONFIG,
      lastAddressedAt: undefined,
      now: 1000,
    });
    expect(r.respond).toBe(true);
    expect(r.gated).toBe(false);
  });

  it("responds in a group call only when addressed", () => {
    const addressed = shouldRespondToGroupTurn({
      transcript: "assistant, what time is it",
      isGroup: true,
      config: CONFIG,
      lastAddressedAt: undefined,
      now: 1000,
    });
    expect(addressed.respond).toBe(true);
    expect(addressed.addressed).toBe(true);

    const notAddressed = shouldRespondToGroupTurn({
      transcript: "what time is it",
      isGroup: true,
      config: CONFIG,
      lastAddressedAt: undefined,
      now: 1000,
    });
    expect(notAddressed.respond).toBe(false);
    expect(notAddressed.gated).toBe(true);
  });

  it("keeps responding inside the follow-up window, then stops", () => {
    const inWindow = shouldRespondToGroupTurn({
      transcript: "and what about tomorrow",
      isGroup: true,
      config: CONFIG,
      lastAddressedAt: 1000,
      now: 1000 + 5_000,
    });
    expect(inWindow.respond).toBe(true);
    expect(inWindow.addressed).toBe(false);

    const expired = shouldRespondToGroupTurn({
      transcript: "and what about tomorrow",
      isGroup: true,
      config: CONFIG,
      lastAddressedAt: 1000,
      now: 1000 + 20_000,
    });
    expect(expired.respond).toBe(false);
  });

  it("is disabled when requireAddress is off", () => {
    const r = shouldRespondToGroupTurn({
      transcript: "just chatting",
      isGroup: true,
      config: { ...CONFIG, requireAddress: false },
      lastAddressedAt: undefined,
      now: 1000,
    });
    expect(r.respond).toBe(true);
    expect(r.gated).toBe(false);
  });

  it("does not mute the bot when no wake phrases are configured", () => {
    const r = shouldRespondToGroupTurn({
      transcript: "just chatting",
      isGroup: true,
      config: { ...CONFIG, wakePhrases: [] },
      lastAddressedAt: undefined,
      now: 1000,
    });
    expect(r.respond).toBe(true);
    expect(r.gated).toBe(false);
  });
});
