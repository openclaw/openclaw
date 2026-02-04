import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";

describe("buildSubagentSystemPrompt", () => {
  it("includes background context section when context is provided", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "look up the weather",
      context: "The user is in San Francisco and prefers metric units.",
    });

    expect(prompt).toContain("## Background Context");
    expect(prompt).toContain("The user is in San Francisco and prefers metric units.");
  });

  it("omits background context section when context is not provided", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "look up the weather",
    });

    expect(prompt).not.toContain("## Background Context");
  });

  it("omits background context section when context is empty string", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "look up the weather",
      context: "",
    });

    expect(prompt).not.toContain("## Background Context");
  });

  it("includes label and session context", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:telegram:123",
      label: "Weather check",
      task: "look up the weather",
    });

    expect(prompt).toContain("Weather check");
    expect(prompt).toContain("agent:main:telegram:123");
    expect(prompt).toContain("agent:main:subagent:abc");
  });
});
