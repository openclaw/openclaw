import { describe, expect, it, vi } from "vitest";

vi.mock("./agent-scope.js", () => ({
  resolveAgentExecutionContract: () => "strict-agentic",
  resolveSessionAgentIds: () => ({ sessionAgentId: "default" }),
}));

import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";

describe("isStrictAgenticExecutionContractActive", () => {
  const base = { provider: "openai" };

  describe("matches standard model IDs", () => {
    it.each([
      "gpt-5",
      "gpt-5.4",
      "gpt-5.4-2025-03",
      "gpt-5-preview",
      "gpt-5-turbo",
      "gpt-5-mini",
      "gpt-5o",
      "GPT-5.4",
    ])("activates for %s", (modelId) => {
      expect(isStrictAgenticExecutionContractActive({ ...base, modelId })).toBe(true);
    });
  });

  describe("matches prefixed model IDs", () => {
    it.each([
      "openai/gpt-5.4",
      "openai:gpt-5.4",
      "openai-codex/gpt-5",
      "custom-provider/gpt-5o",
    ])("activates for %s", (modelId) => {
      expect(isStrictAgenticExecutionContractActive({ ...base, modelId })).toBe(true);
    });
  });

  describe("does not match non-gpt-5 models", () => {
    it.each([
      "gpt-4.5",
      "gpt-4o",
      "gpt-6",
      "claude-opus-4-6",
      "gemini-2.5-pro",
      "",
      null,
    ])("does not activate for %s", (modelId) => {
      expect(isStrictAgenticExecutionContractActive({ ...base, modelId })).toBe(false);
    });
  });

  describe("requires openai provider", () => {
    it("does not activate for non-openai provider", () => {
      expect(
        isStrictAgenticExecutionContractActive({ provider: "anthropic", modelId: "gpt-5.4" }),
      ).toBe(false);
    });

    it("activates for openai-codex provider", () => {
      expect(
        isStrictAgenticExecutionContractActive({ provider: "openai-codex", modelId: "gpt-5.4" }),
      ).toBe(true);
    });
  });
});
