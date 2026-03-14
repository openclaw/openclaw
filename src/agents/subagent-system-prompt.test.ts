import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";

describe("buildSubagentSystemPrompt", () => {
  it("tells subagents to recover requester context from session history when available", () => {
    const prompt = buildSubagentSystemPrompt({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:test",
      task: "Continue the task",
    });

    expect(prompt).toContain("Recover context when needed");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("requester session");
    expect(prompt).toContain("- **Stay focused**");
    expect(prompt).not.toContain("1. **Stay focused**");
  });

  it("omits requester-session recovery guidance when no requester session is provided", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:test",
      task: "Continue the task",
    });

    expect(prompt).not.toContain("Recover context when needed");
    expect(prompt).not.toContain("sessions_history");
    expect(prompt).toContain("- **Stay focused**");
    expect(prompt).not.toContain("1. **Stay focused**");
  });
});
