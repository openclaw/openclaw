import { describe, expect, it } from "vitest";
import {
  bindsClaudeThinkingPrefix,
  requiresClaudeBetweenToolsThinking,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeOpus55ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeSonnet55ModelIdentity,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeFastMode,
  supportsClaudeInHistorySystemMessages,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "./anthropic.js";

describe("supportsClaudeInHistorySystemMessages", () => {
  it.each([
    ["claude-opus-5", true],
    ["claude-opus-5-5", true],
    ["claude-opus-4-8", true],
    ["claude-sonnet-5", true],
    ["claude-sonnet-5-5", true],
    ["claude-fable-5", true],
    ["claude-fable-5-1", true],
    ["claude-mythos-5", true],
    ["claude-mythos-5-1", true],
    ["opus", true],
    ["sonnet", true],
    ["anthropic/claude-opus-4.8", true],
    ["claude-opus-4-7", false],
    ["claude-sonnet-4-6", false],
    ["claude-haiku-4-5", false],
    ["claude-mythos-preview", false],
    ["claude-opus-50", false],
    ["", false],
  ])("resolves the in-history protocol for %s to %s", (id, expected) => {
    expect(supportsClaudeInHistorySystemMessages({ id })).toBe(expected);
    expect(
      supportsClaudeInHistorySystemMessages({
        id: "deployment",
        params: { canonicalModelId: id },
      }),
    ).toBe(expected);
  });
});

describe("bindsClaudeThinkingPrefix", () => {
  it.each([
    [{ id: "Claude Gateway/claude-fable-5-1" }, true],
    [{ id: "Claude Gateway/claude-sonnet-5" }, false],
    [{ id: "claude-mythos-5-1" }, false],
    [{ id: "anthropic/claude-fable-5.1" }, true],
    [{ id: "us.anthropic.claude-fable-5-1-v1:0" }, true],
    [{ id: "claude-fable-5-1@20260801" }, true],
    [{ id: "deployment", params: { canonicalModelId: "claude-fable-5-1" } }, true],
    [{ id: "claude-fable-5-1", params: { canonicalModelId: "claude-opus-5" } }, false],
    [{ id: "claude-fable-5" }, false],
    [{ id: "claude-opus-5-5" }, true],
    [{ id: "claude-fable-5-10" }, false],
    [{ id: "claude-fable-5-2" }, false],
    [{}, false],
  ])("resolves %j to %s", (ref, expected) => {
    expect(bindsClaudeThinkingPrefix(ref)).toBe(expected);
  });
});

describe("Claude Sonnet 5.5 model contract", () => {
  it.each([
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["sonnet-5.5", "claude-sonnet-5-5"],
    ["sonnet-5-5", "claude-sonnet-5-5"],
    ["Claude Gateway/claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5-v1:0"],
    ["claude-sonnet-5-5@20260928", "claude-sonnet-5-5@20260928"],
    ["claude-sonnet-5", undefined],
    ["claude-sonnet-5-50", undefined],
    ["claude-sonnet-5-5other", undefined],
  ])("resolves %s without broadening the version boundary", (id, expected) => {
    expect(resolveClaudeSonnet55ModelIdentity({ id })).toBe(expected);
  });

  it.each([
    ["sonnet", "claude-sonnet-5-5"],
    ["sonnet-5", "claude-sonnet-5"],
    ["claude-sonnet-5-5-v1:0", "claude-sonnet-5-5-v1:0"],
  ])("keeps the Sonnet 5 family identity for %s", (id, expected) => {
    expect(resolveClaudeSonnet5ModelIdentity({ id })).toBe(expected);
  });

  it.each([
    [{ id: "claude-sonnet-5-5" }, true],
    [{ id: "sonnet" }, true],
    [{ id: "sonnet-5.5" }, true],
    [{ id: "sonnet-5-5" }, true],
    [{ id: "deployment", params: { canonicalModelId: "claude-sonnet-5-5" } }, true],
    [{ id: "claude-sonnet-5-5", params: { canonicalModelId: "claude-sonnet-5" } }, false],
    [{ id: "claude-sonnet-5" }, false],
    [{ id: "sonnet-5" }, false],
  ] as const)(
    "preserves family capabilities for %j with between-tools thinking: %s",
    (ref, betweenTools) => {
      expect(requiresClaudeBetweenToolsThinking(ref)).toBe(betweenTools);
      expect(bindsClaudeThinkingPrefix(ref)).toBe(betweenTools);
      expect(requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(false);
      expect(supportsClaudeAdaptiveThinking(ref)).toBe(true);
      expect(supportsClaude1MContext(ref)).toBe(true);
      expect(supportsClaudeNativeXhighEffort(ref)).toBe(true);
      expect(supportsClaudeNativeMaxEffort(ref)).toBe(true);
      expect(requiresClaudeDefaultSampling(ref)).toBe(true);
      expect(supportsClaudeFastMode(ref)).toBe(false);
    },
  );

  it.each([
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5-50",
    "claude-sonnet-5-5other",
    "claude-sonnet-4-6",
  ])("does not enable between-tools thinking for %s", (id) =>
    expect(requiresClaudeBetweenToolsThinking({ id })).toBe(false),
  );
});

describe("Claude Opus 5.5 model contract", () => {
  it.each([
    ["opus", "claude-opus-5-5"],
    ["opus-5.5", "claude-opus-5-5"],
    ["us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5-v1:0"],
    ["claude-opus-5-5@20260922", "claude-opus-5-5@20260922"],
    ["claude-opus-5", undefined],
    ["claude-opus-5-50", undefined],
    ["claude-opus-5-5other", undefined],
  ])("resolves %s without broadening the version boundary", (id, expected) => {
    expect(resolveClaudeOpus55ModelIdentity({ id })).toBe(expected);
  });

  it.each([
    ["claude-opus-5-5", true],
    ["claude-opus-5", false],
    ["opus-5", false],
  ])("preserves family capabilities for %s with mandatory thinking: %s", (id, mandatory) => {
    expect(requiresClaudeMandatoryAdaptiveThinking({ id })).toBe(mandatory);
    expect(supportsClaudeAdaptiveThinking({ id })).toBe(true);
    expect(supportsClaude1MContext({ id })).toBe(true);
    expect(supportsClaudeNativeXhighEffort({ id })).toBe(true);
    expect(supportsClaudeNativeMaxEffort({ id })).toBe(true);
    expect(supportsClaudeFastMode({ id })).toBe(true);
  });
});
