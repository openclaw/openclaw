import { describe, expect, it } from "vitest";
import { resolveAttemptRouteParams } from "./attempt-execution.helpers.js";

describe("resolveAttemptRouteParams", () => {
  it.each([
    { options: { thinking: "high" }, explicit: true },
    { options: { thinkingOnce: "low" }, explicit: true },
    { options: { thinking: "default" }, explicit: true },
    { options: {}, explicit: false },
  ])("marks whether current-turn thinking was explicit: $options", ({ options, explicit }) => {
    expect(
      resolveAttemptRouteParams({
        modelOverride: "example-model",
        modelRoutingProvenance: {
          requestedProvider: "openai",
          requestedModel: "example-model",
          stage: "initial",
        },
        resolvedThinkLevel: "medium",
        opts: options,
      }),
    ).toEqual({
      model: "example-model",
      modelRoutingProvenance: {
        requestedProvider: "openai",
        requestedModel: "example-model",
        stage: "initial",
      },
      thinkLevel: "medium",
      thinkLevelExplicit: explicit,
    });
  });
});
