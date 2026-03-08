import { describe, test, expect, vi } from "vitest";
import type { ChatModel } from "./chat.js";
import { generateReflection } from "./reflection.js";

describe("reflection", () => {
  const mockChatModel = {
    complete: vi.fn(),
  } as unknown as ChatModel;

  test("should return early if not enough memories", async () => {
    const result = await generateReflection(
      [{ text: "fact 1", category: "fact", importance: 0.5 }],
      mockChatModel,
    );
    expect(result.summary).toContain("Not enough memories");
    expect(result.memoriesAnalyzed).toBe(1);
  });

  test("should successfully generate reflection from memories", async () => {
    const memories = [
      { text: "User likes Python", category: "preference", importance: 0.9, recallCount: 5 },
      { text: "User lives in Kyiv", category: "fact", importance: 0.8 },
      { text: "User builds bots", category: "fact", importance: 0.7 },
      {
        text: "User is stressed at work",
        category: "fact",
        importance: 0.6,
        emotionalTone: "stressed",
        emotionScore: -0.8,
      },
      { text: "User loves AI", category: "preference", importance: 0.9 },
    ];

    vi.mocked(mockChatModel.complete).mockResolvedValue(
      JSON.stringify({
        summary: "A developer from Kyiv focused on AI and Python.",
        patterns: ["Expert in Python", "Building bots"],
        emotional_patterns: ["Stressed during work tasks"],
      }),
    );

    const result = await generateReflection(memories, mockChatModel);

    expect(result.summary).toBe("A developer from Kyiv focused on AI and Python.");
    expect(result.patterns).toContain("Expert in Python");
    expect(result.emotionalPatterns).toContain("Stressed during work tasks");
    expect(result.memoriesAnalyzed).toBe(5);
  });

  test("should handle malformed JSON from LLM gracefully", async () => {
    const memories = Array(5).fill({ text: "some fact", category: "fact", importance: 0.5 });

    // Return invalid JSON
    vi.mocked(mockChatModel.complete).mockResolvedValue("Not a JSON string");

    const result = await generateReflection(memories, mockChatModel);

    expect(result.summary).toBe("Reflection failed (LLM error). Try again later.");
    expect(result.patterns).toEqual([]);
  });

  test("should handle missing fields in LLM response", async () => {
    const memories = Array(5).fill({ text: "some fact", category: "fact", importance: 0.5 });

    // Return JSON missing patterns
    vi.mocked(mockChatModel.complete).mockResolvedValue(
      JSON.stringify({
        summary: "Just a summary",
      }),
    );

    const result = await generateReflection(memories, mockChatModel);

    expect(result.summary).toBe("Just a summary");
    expect(result.patterns).toEqual([]);
    expect(result.emotionalPatterns).toEqual([]);
  });
});
