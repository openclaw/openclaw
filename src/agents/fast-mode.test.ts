import { describe, expect, it } from "vitest";
import { resolveFastModeState } from "./fast-mode.js";

describe("resolveFastModeState", () => {
  it("uses agent fastModeDefault when session override is absent", () => {
    const state = resolveFastModeState({
      cfg: {},
      provider: "openai",
      model: "gpt-4o-mini",
      agentCfg: { fastModeDefault: true },
    });

    expect(state).toEqual({ enabled: true, source: "config" });
  });

  it("prefers session override over agent fastModeDefault", () => {
    const state = resolveFastModeState({
      cfg: {},
      provider: "openai",
      model: "gpt-4o-mini",
      sessionEntry: { fastMode: false },
      agentCfg: { fastModeDefault: true },
    });

    expect(state).toEqual({ enabled: false, source: "session" });
  });
});
