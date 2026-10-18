import { describe, expect, it } from "vitest";
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

describe("supportsClaudeServerCompaction", () => {
  it.each(["claude-fable-5-1"])("accepts documented model %s", (id) => {
    expect(supportsClaudeServerCompaction({ id })).toBe(true);
  });
});

describe("supportsClaudeInHistorySystemMessages", () => {
  it.each([
    ["opus", true],
    ["anthropic/claude-opus-4.8", true],
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
  it.each([[{}, false]])("resolves %j to %s", (ref, expected) => {
    expect(bindsClaudeThinkingPrefix(ref)).toBe(expected);
  });
});

describe("Claude Haiku 5.5 model contract", () => {
  it.each([["haiku-5.5", "claude-haiku-5-5"]])(
    "resolves %s without broadening the version boundary",
    (id, expected) => {
      expect(resolveClaudeHaiku55ModelIdentity({ id })).toBe(expected);
    },
  );
  it("uses optional adaptive thinking without Sonnet's between-tools mode", () => {
    const ref = { id: "deployment", params: { canonicalModelId: "claude-haiku-5-5" } };
    expect(supportsClaudeAdaptiveThinking(ref)).toBe(true);
    expect(supportsClaude1MContext(ref)).toBe(true);
    expect(requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(false);
    expect(requiresClaudeBetweenToolsThinking(ref)).toBe(false);
    expect(supportsClaudeFastMode(ref)).toBe(false);
    expect(supportsClaudeNativeXhighEffort(ref)).toBe(true);
    expect(supportsClaudeNativeMaxEffort(ref)).toBe(true);
  });
});

describe("Claude Sonnet 5.5 model contract", () => {
  it.each([["sonnet-5", "claude-sonnet-5"]])(
    "keeps the Sonnet 5 family identity for %s",
    (id, expected) => {
      expect(resolveClaudeSonnet5ModelIdentity({ id })).toBe(expected);
    },
  );

  it.each([
    [{ id: "sonnet-5.5" }, true],
    [{ id: "claude-sonnet-5-5", params: { canonicalModelId: "claude-sonnet-5" } }, false],
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
});

describe("Claude Opus 5.5 model contract", () => {
  it.each([["us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5-v1:0"]])(
    "resolves %s without broadening the version boundary",
    (id, expected) => {
      expect(resolveClaudeOpus55ModelIdentity({ id })).toBe(expected);
    },
  );
});

describe("listed Claude capabilities", () => {
  it("override id rules per flag without changing the context contract", () => {
    const listedOff = {
      id: "claude-opus-4-8",
      params: { claudeCapabilities: { adaptiveThinking: false, maxEffort: false } },
    };
    expect(supportsClaudeAdaptiveThinking(listedOff)).toBe(false);
    expect(supportsClaudeNativeMaxEffort(listedOff)).toBe(false);
    // No listed xhigh flag: the id rule still answers.
    expect(supportsClaudeNativeXhighEffort(listedOff)).toBe(true);
    expect(supportsClaude1MContext(listedOff)).toBe(true);

    const listedOn = {
      id: "claude-zephyr-1",
      params: {
        claudeCapabilities: {
          adaptiveThinking: true,
          disabledThinking: false,
          xhighEffort: true,
          maxEffort: true,
        },
      },
    };
    expect(supportsClaudeAdaptiveThinking(listedOn)).toBe(true);
    expect(requiresClaudeMandatoryAdaptiveThinking(listedOn)).toBe(true);
    expect(supportsClaudeNativeXhighEffort(listedOn)).toBe(true);
    expect(supportsClaudeNativeMaxEffort(listedOn)).toBe(true);
    expect(supportsClaude1MContext(listedOn)).toBe(false);
    // Sonnet 5.5 lists disabled thinking as unsupported but keeps its between-tools off mode.
    expect(
      requiresClaudeMandatoryAdaptiveThinking({
        id: "claude-sonnet-5-5",
        params: { claudeCapabilities: { ...listedOn.params.claudeCapabilities } },
      }),
    ).toBe(false);
  });
});
