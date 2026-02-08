import { describe, expect, it } from "vitest";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("does not misclassify rate limit messages as context overflow", () => {
    const rateLimitSamples = [
      "LLM request rejected: You have reached your specified API usage limits. You will regain access on 2026-03-01 at 00:00 UTC. (rate_limit)",
      "Rate limit exceeded: too many requests",
      "429 Too Many Requests",
      "You exceeded your current quota, please check your plan and billing details",
      "resource has been exhausted",
    ];
    for (const sample of rateLimitSamples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("does not misclassify billing messages as context overflow", () => {
    const billingSamples = [
      "402 Payment Required",
      "Your account has insufficient credits. Please check your billing dashboard.",
      "credit balance too low, plans & billing",
    ];
    for (const sample of billingSamples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("does not misclassify auth messages as context overflow", () => {
    const authSamples = [
      "invalid api key provided",
      "Authentication failed: token has expired",
      "401 Unauthorized",
    ];
    for (const sample of authSamples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("still correctly identifies genuine context overflow errors", () => {
    const overflowSamples = [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 10240 tokens.",
      "request_too_large",
      "Request exceeds the maximum size for the model context window",
      "context length exceeded",
      "prompt is too long",
    ];
    for (const sample of overflowSamples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });
});
