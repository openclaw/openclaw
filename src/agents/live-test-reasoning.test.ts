import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { resolveLiveTestReasoning } from "./live-test-reasoning.js";

describe("resolveLiveTestReasoning", () => {
  it("honors the prepared OpenCode Go transport profile", () => {
    const model = {
      provider: "opencode-go",
      id: "glm-5",
      reasoning: true,
    } as Model;

    expect(resolveLiveTestReasoning(model)).toBe("low");
    expect(
      resolveLiveTestReasoning({ ...model, api: "openai-completions" } as Model),
    ).toBeUndefined();
  });

  it("honors prepared OpenCode Go effort metadata", () => {
    const model = {
      provider: "opencode-go",
      id: "deepseek-v4-flash",
      api: "openai-completions",
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "high", "max"],
      },
    } as Model;

    expect(resolveLiveTestReasoning(model)).toBe("low");
  });
});
