import { describe, test, expect, vi } from "vitest";
import { generateMemorySummary, formatRadarContext } from "./capture.js";
import type { ChatModel } from "./chat.js";

describe("Summary and Radar Generation", () => {
  test("should generate a short summary from chat model", async () => {
    const mockChatModel = {
      complete: vi
        .fn()
        .mockResolvedValue("User shares a traumatic event from their childhood in school."),
    } as unknown as ChatModel;

    const longText =
      "Onetime when I was a kid I went to school and something really bad happened... it was tragic and traumatic".repeat(
        10,
      );
    const summary = await generateMemorySummary(longText, mockChatModel);

    expect(mockChatModel.complete).toHaveBeenCalled();
    expect(summary).toBe("User shares a traumatic event from their childhood in school.");
  });

  test("should format radar context correctly with and without summary", () => {
    const memories = [
      { id: "1", category: "fact", summary: "Short summary", text: "Long original text here" },
      {
        id: "2",
        category: "preference",
        text: "Long preference that should be truncated to 60 characters...",
      },
    ] as any[];

    const radar = formatRadarContext(memories);

    expect(radar).toContain("<star-map>");
    expect(radar).toContain("[ID: 1 | fact] Short summary");
    // Text is under 80 chars, so formatRadarContext does NOT truncate it
    expect(radar).toContain(
      "[ID: 2 | preference] Long preference that should be truncated to 60 characters...",
    );
  });
});
