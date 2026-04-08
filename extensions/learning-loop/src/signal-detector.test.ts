import { describe, expect, it } from "vitest";
import { SignalDetector } from "./signal-detector.js";

describe("SignalDetector", () => {
  it("detects execution failures from text blocks and attributes skill and tool names", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "Error: tool name: knowledge_search failed while loading " +
              ".agents/skills/test-skill/SKILL.md with ECONNREFUSED",
          },
        ],
      },
      {
        role: "tool",
        name: "knowledge_store",
        content: "command not found: rg",
      },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
      skillName: "test-skill",
      toolName: "knowledge_search",
    });
    expect(signals[1]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
      toolName: "knowledge_store",
    });
  });

  it("detects terse provider and auth failures without requiring the word error", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "assistant",
        content: "Bad Request: Missing session ID",
      },
      {
        role: "tool",
        name: "knowledge_search",
        content: "unauthorized: invalid api key",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "The provider is temporarily overloaded and unavailable." },
        ],
      },
    ]);

    expect(signals).toHaveLength(3);
    expect(signals[0]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
    });
    expect(signals[1]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
      toolName: "knowledge_search",
    });
    expect(signals[2]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
    });
  });

  it("detects execution failures from toolResult messages", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "toolResult",
        name: "knowledge_store",
        content: "command not found: rg",
      },
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
      toolName: "knowledge_store",
    });
  });

  it("detects user corrections, deduplicates them, and clears dedupe state between sessions", () => {
    const detector = new SignalDetector();
    const correction = {
      role: "user",
      content: "No, that's wrong. You should use rg instead of grep here.",
    };

    const firstPass = detector.detect([correction, correction]);

    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]).toMatchObject({
      type: "user_correction",
      section: "Instructions",
      excerpt: correction.content,
    });

    expect(detector.detect([correction])).toEqual([]);

    detector.clearProcessedSignals();

    expect(detector.detect([correction])).toHaveLength(1);
  });

  it("detects softer correction wording like please use and make sure to", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "user",
        content: "Please use rg rather than grep for repository searches.",
      },
      {
        role: "user",
        content: "Make sure to keep final replies terse.",
      },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      type: "user_correction",
      section: "Instructions",
    });
    expect(signals[1]).toMatchObject({
      type: "user_correction",
      section: "Instructions",
    });
  });

  it("does not treat ordinary wanted or asked statements as corrections", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "user",
        content: "I wanted to ask about the Graphiti setup.",
      },
      {
        role: "user",
        content: "I asked yesterday whether this endpoint was stable.",
      },
      {
        role: "user",
        content: "I said to use rg, not grep.",
      },
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "user_correction",
      section: "Instructions",
      excerpt: "I said to use rg, not grep.",
    });
  });

  it("does not treat positive confirmations as corrections", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "user",
        content: "That's right, keep doing that.",
      },
      {
        role: "user",
        content: "That is correct.",
      },
    ]);

    expect(signals).toEqual([]);
  });

  it("does not infer bogus skill or tool ids from ordinary prose", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "assistant",
        content: "Error: the tool call failed because the provider was unavailable.",
      },
      {
        role: "user",
        content: "Actually, the skills are documented elsewhere.",
      },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      type: "execution_failure",
      section: "Troubleshooting",
      toolName: undefined,
    });
    expect(signals[1]).toMatchObject({
      type: "user_correction",
      section: "Instructions",
      skillName: undefined,
    });
  });

  it("keeps identical failure excerpts for different skills instead of deduping them together", () => {
    const detector = new SignalDetector();

    const signals = detector.detect([
      {
        role: "assistant",
        content: "permission denied while loading .agents/skills/search-skill/SKILL.md",
      },
      {
        role: "assistant",
        content: "permission denied while loading .agents/skills/deploy-skill/SKILL.md",
      },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ skillName: "search-skill" });
    expect(signals[1]).toMatchObject({ skillName: "deploy-skill" });
  });
});
