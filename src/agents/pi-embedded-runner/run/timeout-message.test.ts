import { describe, expect, it } from "vitest";
import { buildNoResponseTimeoutMessage } from "./timeout-message.js";

describe("buildNoResponseTimeoutMessage", () => {
  it("mentions both total turn timeout and LLM idle timeout guidance", () => {
    const text = buildNoResponseTimeoutMessage();
    expect(text).toContain("agents.defaults.timeoutSeconds");
    expect(text).toContain("agents.defaults.llm.idleTimeoutSeconds");
  });
});
