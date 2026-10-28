import { expect, it } from "vitest";
import * as claude from "./anthropic.js";

it("supports server compaction for the documented model", () => {
  expect(claude.supportsClaudeServerCompaction({ id: "claude-fable-5-1" })).toBe(true);
});

it.each(["opus", "anthropic/claude-opus-4.8"])("supports in-history instructions for %s", (id) => {
  expect(claude.supportsClaudeInHistorySystemMessages({ id })).toBe(true);
  expect(
    claude.supportsClaudeInHistorySystemMessages({
      id: "deployment",
      params: { canonicalModelId: id },
    }),
  ).toBe(true);
});

it("does not bind the thinking prefix for an unspecified model", () => {
  expect(claude.bindsClaudeThinkingPrefix({})).toBe(false);
});

it("resolves the Haiku 5.5 alias", () => {
  expect(claude.resolveClaudeHaiku55ModelIdentity({ id: "haiku-5.5" })).toBe("claude-haiku-5-5");
});

it("keeps the Sonnet 5 family identity", () => {
  expect(claude.resolveClaudeSonnet5ModelIdentity({ id: "sonnet-5" })).toBe("claude-sonnet-5");
});

it.each([
  [{ id: "deployment", params: { canonicalModelId: "claude-haiku-5-5" } }, false, true],
  [{ id: "sonnet-5.5" }, true, true],
  [{ id: "claude-sonnet-5-5", params: { canonicalModelId: "claude-sonnet-5" } }, false, false],
] as const)("preserves optional-thinking capabilities for %j", (ref, betweenTools, bindsPrefix) => {
  expect(claude.requiresClaudeBetweenToolsThinking(ref)).toBe(betweenTools);
  expect(claude.bindsClaudeThinkingPrefix(ref)).toBe(bindsPrefix);
  expect(claude.requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(false);
  expect(claude.supportsClaudeAdaptiveThinking(ref)).toBe(true);
  expect(claude.supportsClaude1MContext(ref)).toBe(true);
  expect(claude.supportsClaudeNativeXhighEffort(ref)).toBe(true);
  expect(claude.supportsClaudeNativeMaxEffort(ref)).toBe(true);
  expect(claude.requiresClaudeDefaultSampling(ref)).toBe(true);
  expect(claude.supportsClaudeFastMode(ref)).toBe(false);
});

it("resolves the Opus 5.5 cloud identity", () => {
  expect(claude.resolveClaudeOpus55ModelIdentity({ id: "us.anthropic.claude-opus-5-5-v1:0" })).toBe(
    "claude-opus-5-5-v1:0",
  );
});

it("lets listed Claude capabilities override id rules per flag without changing the context contract", () => {
  const listedOff = {
    id: "claude-opus-4-8",
    params: { claudeCapabilities: { adaptiveThinking: false, maxEffort: false } },
  };
  expect(claude.supportsClaudeAdaptiveThinking(listedOff)).toBe(false);
  expect(claude.supportsClaudeNativeMaxEffort(listedOff)).toBe(false);
  // No listed xhigh flag: the id rule still answers.
  expect(claude.supportsClaudeNativeXhighEffort(listedOff)).toBe(true);
  expect(claude.supportsClaude1MContext(listedOff)).toBe(true);

  const claudeCapabilities = {
    adaptiveThinking: true,
    disabledThinking: false,
    xhighEffort: true,
    maxEffort: true,
  };
  const listedOn = { id: "claude-zephyr-1", params: { claudeCapabilities } };
  expect(claude.supportsClaudeAdaptiveThinking(listedOn)).toBe(true);
  expect(claude.requiresClaudeMandatoryAdaptiveThinking(listedOn)).toBe(true);
  expect(claude.supportsClaudeNativeXhighEffort(listedOn)).toBe(true);
  expect(claude.supportsClaudeNativeMaxEffort(listedOn)).toBe(true);
  expect(claude.supportsClaude1MContext(listedOn)).toBe(false);
  // Sonnet 5.5 lists disabled thinking as unsupported but keeps its between-tools off mode.
  const betweenTools = { ...listedOn, id: "claude-sonnet-5-5" };
  expect(claude.requiresClaudeMandatoryAdaptiveThinking(betweenTools)).toBe(false);
});
