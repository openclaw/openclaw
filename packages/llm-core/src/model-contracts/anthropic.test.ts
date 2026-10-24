import { expect, it } from "vitest";
import {
  bindsClaudeThinkingPrefix,
  requiresClaudeBetweenToolsThinking,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeOpus55ModelIdentity,
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeFastMode,
  supportsClaudeInHistorySystemMessages,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  supportsClaudeServerCompaction,
} from "./anthropic.js";

it("supports server compaction for the documented model", () => {
  expect(supportsClaudeServerCompaction({ id: "claude-fable-5-1" })).toBe(true);
});

it.each(["opus", "anthropic/claude-opus-4.8"])("supports in-history instructions for %s", (id) => {
  expect(supportsClaudeInHistorySystemMessages({ id })).toBe(true);
  expect(
    supportsClaudeInHistorySystemMessages({ id: "deployment", params: { canonicalModelId: id } }),
  ).toBe(true);
});

it("does not bind the thinking prefix for an unspecified model", () => {
  expect(bindsClaudeThinkingPrefix({})).toBe(false);
});

it("resolves the Haiku 5.5 alias", () => {
  expect(resolveClaudeHaiku55ModelIdentity({ id: "haiku-5.5" })).toBe("claude-haiku-5-5");
});

it("uses optional adaptive thinking for Haiku without Sonnet's between-tools mode", () => {
  const ref = { id: "deployment", params: { canonicalModelId: "claude-haiku-5-5" } };
  expect(supportsClaudeAdaptiveThinking(ref)).toBe(true);
  expect(supportsClaude1MContext(ref)).toBe(true);
  expect(requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(false);
  expect(requiresClaudeBetweenToolsThinking(ref)).toBe(false);
  expect(supportsClaudeFastMode(ref)).toBe(false);
  expect(supportsClaudeNativeXhighEffort(ref)).toBe(true);
  expect(supportsClaudeNativeMaxEffort(ref)).toBe(true);
});

it("keeps the Sonnet 5 family identity", () => {
  expect(resolveClaudeSonnet5ModelIdentity({ id: "sonnet-5" })).toBe("claude-sonnet-5");
});

it.each([
  [{ id: "sonnet-5.5" }, true],
  [{ id: "claude-sonnet-5-5", params: { canonicalModelId: "claude-sonnet-5" } }, false],
] as const)("preserves Sonnet capabilities for %j (between-tools: %s)", (ref, betweenTools) => {
  expect(requiresClaudeBetweenToolsThinking(ref)).toBe(betweenTools);
  expect(bindsClaudeThinkingPrefix(ref)).toBe(betweenTools);
  expect(requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(false);
  expect(supportsClaudeAdaptiveThinking(ref)).toBe(true);
  expect(supportsClaude1MContext(ref)).toBe(true);
  expect(supportsClaudeNativeXhighEffort(ref)).toBe(true);
  expect(supportsClaudeNativeMaxEffort(ref)).toBe(true);
  expect(requiresClaudeDefaultSampling(ref)).toBe(true);
  expect(supportsClaudeFastMode(ref)).toBe(false);
});

it("resolves the Opus 5.5 cloud identity", () => {
  expect(resolveClaudeOpus55ModelIdentity({ id: "us.anthropic.claude-opus-5-5-v1:0" })).toBe(
    "claude-opus-5-5-v1:0",
  );
});

it("lets listed Claude capabilities override id rules per flag without changing the context contract", () => {
  const listedOff = {
    id: "claude-opus-4-8",
    params: { claudeCapabilities: { adaptiveThinking: false, maxEffort: false } },
  };
  expect(supportsClaudeAdaptiveThinking(listedOff)).toBe(false);
  expect(supportsClaudeNativeMaxEffort(listedOff)).toBe(false);
  // No listed xhigh flag: the id rule still answers.
  expect(supportsClaudeNativeXhighEffort(listedOff)).toBe(true);
  expect(supportsClaude1MContext(listedOff)).toBe(true);

  const claudeCapabilities = {
    adaptiveThinking: true,
    disabledThinking: false,
    xhighEffort: true,
    maxEffort: true,
  };
  const listedOn = { id: "claude-zephyr-1", params: { claudeCapabilities } };
  expect(supportsClaudeAdaptiveThinking(listedOn)).toBe(true);
  expect(requiresClaudeMandatoryAdaptiveThinking(listedOn)).toBe(true);
  expect(supportsClaudeNativeXhighEffort(listedOn)).toBe(true);
  expect(supportsClaudeNativeMaxEffort(listedOn)).toBe(true);
  expect(supportsClaude1MContext(listedOn)).toBe(false);
  // Sonnet 5.5 lists disabled thinking as unsupported but keeps its between-tools off mode.
  const betweenTools = { ...listedOn, id: "claude-sonnet-5-5" };
  expect(requiresClaudeMandatoryAdaptiveThinking(betweenTools)).toBe(false);
});
