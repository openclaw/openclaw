import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";

describe("buildSubagentSystemPrompt", () => {
  const baseParams = {
    childSessionKey: "child-123",
    requesterSessionKey: "parent-456",
  };

  it("does not embed the task text verbatim in the system prompt", () => {
    const task = "Investigate the authentication flow and fix token refresh";
    const result = buildSubagentSystemPrompt({ ...baseParams, task });

    expect(result).not.toContain(task);
  });

  it("includes a generic task reference pointing to the first user message", () => {
    const result = buildSubagentSystemPrompt({
      ...baseParams,
      task: "some task description",
    });

    expect(result).toContain("specific task (see first user message)");
  });

  it("does not embed placeholder when task is omitted", () => {
    const result = buildSubagentSystemPrompt(baseParams);

    expect(result).not.toContain("{{TASK_DESCRIPTION}}");
    expect(result).toContain("specific task (see first user message)");
  });

  it("does not embed placeholder when task is empty", () => {
    const result = buildSubagentSystemPrompt({ ...baseParams, task: "  " });

    expect(result).not.toContain("{{TASK_DESCRIPTION}}");
    expect(result).toContain("specific task (see first user message)");
  });

  it("includes session context in the output", () => {
    const result = buildSubagentSystemPrompt(baseParams);

    expect(result).toContain("child-123");
    expect(result).toContain("parent-456");
  });
});
