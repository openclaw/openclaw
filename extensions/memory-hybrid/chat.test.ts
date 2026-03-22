import { describe, test, expect, vi, beforeEach } from "vitest";
import { ChatModel } from "./chat.js";

// Mock fetch globally
const fetchMock = vi.fn();
global.fetch = fetchMock;

describe("ChatModel", () => {
  let chatModel: ChatModel;

  beforeEach(() => {
    fetchMock.mockReset();
    chatModel = new ChatModel("test-key", "gemma-3-27b-it", "google");
  });

  test("checkForContradiction should detect contradictions", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  contradiction: true,
                  reason: "User moved to a new city",
                  action: "update",
                }),
              },
            ],
          },
        },
      ],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await chatModel.checkForContradiction(
      "User lives in Kyiv",
      "User moved to Warsaw",
    );

    expect(result.contradiction).toBe(true);
    expect(result.action).toBe("update");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Check prompt contained both facts
    const callArgs = fetchMock.mock.calls[0][1];
    expect(callArgs.body).toContain("Kyiv");
    expect(callArgs.body).toContain("Warsaw");
  });

  test("checkForContradiction should keep unrelated facts", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  contradiction: false,
                  reason: "Different topics",
                  action: "keep_both",
                }),
              },
            ],
          },
        },
      ],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await chatModel.checkForContradiction("User likes Python", "User lives in Kyiv");

    expect(result.contradiction).toBe(false);
    expect(result.action).toBe("keep_both");
  });

  test("should detect duplicates and return ignore_new", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  contradiction: false,
                  reason: "Same information",
                  action: "ignore_new",
                }),
              },
            ],
          },
        },
      ],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await chatModel.checkForContradiction(
      "User's name is Vova",
      "The user is called Vova",
    );

    expect(result.action).toBe("ignore_new");
  });

  test("should handle JSON wrapped in markdown code blocks", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '```json\n{"contradiction": true, "reason": "moved", "action": "update"}\n```',
              },
            ],
          },
        },
      ],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await chatModel.checkForContradiction("A", "B");
    expect(result.action).toBe("update");
  });

  test("should fallback gracefully on API error", async () => {
    fetchMock.mockRejectedValue(new Error("Network timeout"));

    const result = await chatModel.checkForContradiction("A", "B");

    expect(result.contradiction).toBe(false);
    expect(result.action).toBe("keep_both");
    expect(result.reason).toContain("LLM error");
  });

  test("should fallback gracefully on invalid JSON", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "This is not valid JSON at all!" }],
          },
        },
      ],
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await chatModel.checkForContradiction("A", "B");

    expect(result.contradiction).toBe(false);
    expect(result.action).toBe("keep_both");
  });
});
