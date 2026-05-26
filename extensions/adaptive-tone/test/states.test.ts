import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { toneGuidance } from "../src/guidance.js";
import { resolveToneState } from "../src/states.js";

const cfg = normalizeConfig({});
const noon = new Date(2026, 0, 1, 12, 0, 0);
const lateNight = new Date(2026, 0, 1, 23, 30, 0);

const empty: unknown[] = [];

describe("resolveToneState priority", () => {
  it("wellbeing beats everything", () => {
    const state = resolveToneState(
      { prompt: "I'm not well, deploy the server", messages: empty, channelId: "slack" },
      lateNight,
      cfg,
    );
    expect(state).toBe("gentle-care");
  });

  it("repetition (3rd ask) beats time and place", () => {
    const messages = [
      { role: "user", content: "restart the gateway" },
      { role: "user", content: "restart the gateway please" },
    ];
    const state = resolveToneState(
      { prompt: "restart the gateway", messages, channelId: "slack" },
      lateNight,
      cfg,
    );
    expect(state).toBe("patient-repeat");
  });

  it("second ask is patient-light", () => {
    const messages = [{ role: "user", content: "restart the gateway" }];
    const state = resolveToneState(
      { prompt: "restart the gateway", messages, channelId: "whatsapp" },
      noon,
      cfg,
    );
    expect(state).toBe("patient-light");
  });

  it("late night beats channel", () => {
    const state = resolveToneState(
      { prompt: "what's the status", messages: empty, channelId: "slack" },
      lateNight,
      cfg,
    );
    expect(state).toBe("quiet-latenight");
  });

  it("falls through to channel register during the day", () => {
    expect(
      resolveToneState({ prompt: "status?", messages: empty, channelId: "slack" }, noon, cfg),
    ).toBe("professional");
    expect(
      resolveToneState({ prompt: "status?", messages: empty, channelId: "whatsapp" }, noon, cfg),
    ).toBe("casual");
  });

  it("is neutral with no signals", () => {
    expect(
      resolveToneState({ prompt: "status?", messages: empty, channelId: "irc" }, noon, cfg),
    ).toBe("neutral");
  });

  it("is neutral when the master switch is off", () => {
    const off = normalizeConfig({ enabled: false });
    expect(
      resolveToneState({ prompt: "I'm not well", messages: empty, channelId: "slack" }, lateNight, off),
    ).toBe("neutral");
  });

  it("respects a disabled wellbeing axis", () => {
    const noWell = normalizeConfig({ wellbeing: { enabled: false } });
    expect(
      resolveToneState({ prompt: "I'm not well", messages: empty, channelId: "irc" }, noon, noWell),
    ).toBe("neutral");
  });
});

describe("toneGuidance", () => {
  it("returns undefined for neutral", () => {
    expect(toneGuidance("neutral", cfg)).toBeUndefined();
  });

  it("is deterministic for the same state (cache stability)", () => {
    expect(toneGuidance("casual", cfg)).toBe(toneGuidance("casual", cfg));
  });

  it("honours operator overrides", () => {
    const overridden = normalizeConfig({ guidanceOverrides: { casual: "Be playful." } });
    expect(toneGuidance("casual", overridden)).toContain("Be playful.");
  });

  it("includes a safety boundary in gentle-care", () => {
    expect(toneGuidance("gentle-care", cfg)?.toLowerCase()).toContain("medical advice");
  });
});
