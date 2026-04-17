import { describe, test, expect } from "vitest";

describe("smart-extractor parseExtractionResponse", () => {

  test("parses well-formed JSON response", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        {
          key: "Editor preference",
          value: "The user prefers Neovim over VS Code.",
          category: "preference",
          importance: 0.8,
          tags: ["editor", "neovim"],
        },
        {
          key: "User email",
          value: "The user's email is dev@example.com.",
          category: "entity",
          importance: 0.9,
          tags: ["email", "contact"],
        },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("Editor preference");
    expect(results[0].text).toBe("The user prefers Neovim over VS Code.");
    expect(results[0].category).toBe("preference");
    expect(results[0].importance).toBe(0.8);
    expect(results[0].tags).toEqual(["editor", "neovim"]);
    expect(results[1].category).toBe("entity");
  });

  test("handles markdown-fenced JSON", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = '```json\n{"memories": [{"key": "test", "value": "The user likes tea.", "category": "preference", "importance": 0.7, "tags": ["drink"]}]}\n```';

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("The user likes tea.");
  });

  test("returns empty for invalid JSON", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    expect(parseExtractionResponse("not json")).toEqual([]);
    expect(parseExtractionResponse("")).toEqual([]);
  });

  test("returns empty when memories is missing", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    expect(parseExtractionResponse(JSON.stringify({}))).toEqual([]);
    expect(parseExtractionResponse(JSON.stringify({ memories: "not array" }))).toEqual([]);
  });

  test("falls back to text field when value is missing", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "test", text: "The user works remotely.", category: "fact", importance: 0.7, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("The user works remotely.");
  });

  test("defaults category to other when invalid", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "test", value: "Something.", category: "invalid_cat", importance: 0.6, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results[0].category).toBe("other");
  });

  test("clamps importance to 0-1 range", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "high", value: "Very important.", category: "fact", importance: 2.0, tags: [] },
        { key: "low", value: "Less important.", category: "fact", importance: 0.4, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(1.0);
  });

  test("filters out memories with importance below 0.5", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "keep", value: "Important fact.", category: "fact", importance: 0.7, tags: [] },
        { key: "drop", value: "Trivial note.", category: "other", importance: 0.3, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("keep");
  });

  test("filters out entries with text shorter than 5 chars", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "short", value: "hi", category: "other", importance: 0.7, tags: [] },
        { key: "valid", value: "The user likes Python.", category: "preference", importance: 0.7, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("valid");
  });

  test("generates key from text when key is missing", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { value: "The user lives in Berlin.", category: "fact", importance: 0.7, tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results[0].key).toBe("The user lives in Berlin.");
  });

  test("filters tags to strings only", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "test", value: "A fact.", category: "fact", importance: 0.7, tags: ["valid", 123, null, "also-valid"] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results[0].tags).toEqual(["valid", "also-valid"]);
  });

  test("defaults importance to 0.7 when missing", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        { key: "test", value: "A fact without importance.", category: "fact", tags: [] },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results[0].importance).toBe(0.7);
  });

  test("handles Chinese output correctly", async () => {
    const { parseExtractionResponse } = await import("./smart-extractor.js");
    const raw = JSON.stringify({
      memories: [
        {
          key: "用户工作地点",
          value: "用户在纽约从事前端开发工作。",
          category: "fact",
          importance: 0.7,
          tags: ["工作", "纽约", "前端"],
        },
      ],
    });

    const results = parseExtractionResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("用户在纽约从事前端开发工作。");
    expect(results[0].tags).toEqual(["工作", "纽约", "前端"]);
  });
});

describe("smart-extractor extractMemories", () => {
  test("returns empty when no messages provided", async () => {
    const { extractMemories } = await import("./smart-extractor.js");
    const mockClient = {} as any;
    const result = await extractMemories(mockClient, "gpt-4o-mini", [], []);
    expect(result.memories).toEqual([]);
    expect(result.source).toBe("llm");
  });
});
