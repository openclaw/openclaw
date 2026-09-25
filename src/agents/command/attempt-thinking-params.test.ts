import { describe, expect, it } from "vitest";
import { resolveAttemptThinkingParams } from "./attempt-execution.helpers.js";

describe("resolveAttemptThinkingParams", () => {
  it.each([
    { options: { thinking: "high" }, explicit: true },
    { options: { thinkingOnce: "low" }, explicit: true },
    { options: { thinking: "default" }, explicit: true },
    { options: {}, explicit: false },
  ])("marks whether current-turn thinking was explicit: $options", ({ options, explicit }) => {
    expect(resolveAttemptThinkingParams("medium", options)).toEqual({
      thinkLevel: "medium",
      thinkLevelExplicit: explicit,
    });
  });
});
