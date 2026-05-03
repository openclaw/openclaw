import { describe, expect, it } from "vitest";
import {
  isOpenAIGpt54MiniModel,
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAISupportedReasoningEfforts,
} from "./openai-reasoning-effort.js";

describe("OpenAI reasoning effort support", () => {
  it.each([
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.5" },
  ])("preserves xhigh for $provider/$id", (model) => {
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("xhigh");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("preserves reasoning_effort metadata for gpt-5.4-mini in Chat Completions", () => {
    const model = { provider: "openai", id: "gpt-5.4-mini", api: "openai-completions" };
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("medium");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "medium" })).toBe("medium");
  });

  it("preserves reasoning_effort for gpt-5.4-mini in Responses", () => {
    const model = { provider: "openai", id: "gpt-5.4-mini", api: "openai-responses" };
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("medium");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "medium" })).toBe("medium");
  });

  it("does not downgrade xhigh when Pi compat metadata declares it explicitly", () => {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.5",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("allows provider-native compat values when explicitly declared", () => {
    const model = {
      provider: "groq",
      id: "qwen/qwen3-32b",
      compat: {
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: {
          off: "none",
          low: "default",
          medium: "default",
          high: "default",
        },
      },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual(["none", "default"]);
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "medium",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("default");
    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "off",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("none");
  });

  it("omits unsupported disabled reasoning instead of falling back to enabled effort", () => {
    expect(
      resolveOpenAIReasoningEffortForModel({
        model: { provider: "groq", id: "openai/gpt-oss-120b" },
        effort: "off",
      }),
    ).toBeUndefined();
  });
});

describe("isOpenAIGpt54MiniModel", () => {
  it.each([
    { id: "gpt-5.4-mini", expected: true, reason: "exact id" },
    {
      id: "gpt-5.4-mini-2026-05-01",
      expected: true,
      reason: "dated alias (YYYY-MM-DD suffix stripped by normalizeModelId)",
    },
    {
      id: "gpt-5.4-mini-preview",
      expected: true,
      reason: "non-date suffix preserved by normalize",
    },
    { id: "gpt-5.4-mini-codex", expected: true, reason: "non-date suffix kept" },
    { id: "GPT-5.4-MINI", expected: true, reason: "uppercase normalized to lowercase" },
    {
      id: "  gpt-5.4-mini  ",
      expected: true,
      reason: "surrounding whitespace trimmed by normalize",
    },
    { id: "gpt-5.4-mini2", expected: false, reason: "no separator after mini" },
    { id: "gpt-5.4", expected: false, reason: "missing -mini" },
    { id: "gpt-5.4-pro", expected: false, reason: "sibling family" },
    { id: "gpt-5.4-mini-pro", expected: true, reason: "non-date suffix" },
    { id: "gpt-5", expected: false, reason: "different family" },
    {
      id: "gpt-5.4-pro-2026-05-01",
      expected: false,
      reason: "date-stamped sibling family (strip + regex independence)",
    },
    { id: "", expected: false, reason: "empty string" },
  ])("$reason: $id -> $expected", ({ id, expected }) => {
    expect(isOpenAIGpt54MiniModel({ provider: "openai", id })).toBe(expected);
  });

  it("returns false for non-string id values without throwing", () => {
    expect(isOpenAIGpt54MiniModel({ provider: "openai", id: undefined })).toBe(false);
    expect(isOpenAIGpt54MiniModel({ provider: "openai", id: null })).toBe(false);
    expect(isOpenAIGpt54MiniModel({ provider: "openai", id: 42 })).toBe(false);
    expect(isOpenAIGpt54MiniModel({ provider: "openai", id: { name: "gpt-5.4-mini" } })).toBe(
      false,
    );
    expect(isOpenAIGpt54MiniModel({ provider: "openai" })).toBe(false);
  });

  it("ignores other model fields (regex matches strictly on id)", () => {
    expect(
      isOpenAIGpt54MiniModel({
        provider: "openai-codex",
        id: "gpt-5",
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe(false);
  });
});
