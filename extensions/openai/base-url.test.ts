import { describe, expect, it } from "vitest";
import {
  canonicalizeCodexResponsesBaseUrl,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
} from "./base-url.js";

describe("openai base URL helpers", () => {
  it("recognizes direct OpenAI API routes", () => {
    expect(isOpenAIApiBaseUrl("https://api.openai.com")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1/")).toBe(true);
  });

  it("rejects proxy or unrelated API routes", () => {
    expect(isOpenAIApiBaseUrl("https://proxy.example.com/v1")).toBe(false);
    expect(isOpenAIApiBaseUrl("https://chatgpt.com/backend-api")).toBe(false);
    expect(isOpenAIApiBaseUrl(undefined)).toBe(false);
  });

  it("recognizes Codex ChatGPT backend routes", () => {
    // New canonical form (includes /codex segment; OpenAI removed the
    // /backend-api/responses alias server-side on 2026-04).
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1/")).toBe(true);
    // Legacy form still recognized as a Codex baseURL for backward
    // compatibility with existing user configs.
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1/")).toBe(true);
  });

  it("rejects non-Codex backend routes", () => {
    expect(isOpenAICodexBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v2")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v2")).toBe(false);
    expect(isOpenAICodexBaseUrl(undefined)).toBe(false);
  });
});

describe("canonicalizeCodexResponsesBaseUrl", () => {
  it("rewrites the legacy /backend-api form to canonical /codex", () => {
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
  });

  it("returns canonical form unchanged for already-canonical inputs", () => {
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/codex/v1")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
  });

  it("passes through non-Codex base URLs unchanged", () => {
    expect(canonicalizeCodexResponsesBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://my-proxy.example.com/openai-codex")).toBe(
      "https://my-proxy.example.com/openai-codex",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com")).toBe("https://chatgpt.com");
  });

  it("returns undefined for missing or empty inputs", () => {
    expect(canonicalizeCodexResponsesBaseUrl(undefined)).toBeUndefined();
    expect(canonicalizeCodexResponsesBaseUrl("")).toBe("");
    expect(canonicalizeCodexResponsesBaseUrl("   ")).toBe("   ");
  });
});
