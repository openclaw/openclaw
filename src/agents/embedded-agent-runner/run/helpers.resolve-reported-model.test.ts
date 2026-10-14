import { describe, expect, it } from "vitest";
import { resolveReportedModelRef } from "./helpers.js";

describe("resolveReportedModelRef", () => {
  it.each([
    [undefined, { provider: "openrouter", model: "openai/gpt-5.4" }],
    [
      { provider: "openai", model: "gpt-5.4-codex" },
      { provider: "openai", model: "gpt-5.4-codex" },
    ],
    [
      { provider: "openclaw", model: "openclaw" },
      { provider: "openrouter", model: "openai/gpt-5.4" },
    ],
  ])("reports the upstream model with assistant metadata %j", (assistant, expected) => {
    expect(
      resolveReportedModelRef({ provider: "openrouter", model: "openai/gpt-5.4", assistant }),
    ).toEqual(expected);
  });
});
