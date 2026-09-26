import { describe, expect, it } from "vitest";
import {
  bindsClaudeThinkingPrefix,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeOpus55ModelIdentity,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeFastMode,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "./anthropic.js";

describe("bindsClaudeThinkingPrefix", () => {
  it.each([
    [{ id: "claude-fable-5-1" }, true],
    [{ id: "Claude Gateway/claude-fable-5-1" }, true],
    [{ id: "Claude Gateway/claude-sonnet-5" }, false],
    [{ id: "claude-mythos-5-1" }, false],
    [{ id: "anthropic/claude-fable-5.1" }, true],
    [{ id: "us.anthropic.claude-fable-5-1-v1:0" }, true],
    [{ id: "global.anthropic.claude-mythos-5-1-v1:0" }, false],
    [{ id: "claude-fable-5-1@20260801" }, true],
    [{ id: "deployment", params: { canonicalModelId: "claude-mythos-5-1" } }, false],
    [{ id: "deployment", params: { canonicalModelId: "claude-fable-5-1" } }, true],
    [{ id: "claude-fable-5-1", params: { canonicalModelId: "claude-opus-5" } }, false],
    [{ id: "claude-fable-5" }, false],
    [{ id: "claude-mythos-5" }, false],
    [{ id: "claude-opus-5" }, false],
    [{ id: "claude-opus-5-5" }, true],
    [{ id: "anthropic/claude-opus-5.5" }, true],
    [{ id: "us.anthropic.claude-opus-5-5-v1:0" }, true],
    [{ id: "deployment", params: { canonicalModelId: "claude-opus-5-5" } }, true],
    [{ id: "claude-opus-5-5", params: { canonicalModelId: "claude-opus-5" } }, false],
    [{ id: "claude-opus-5-50" }, false],
    [{ id: "claude-sonnet-5" }, false],
    [{ id: "claude-opus-4-8" }, false],
    [{ id: "claude-sonnet-4-6" }, false],
    [{ id: "claude-haiku-4-5" }, false],
    [{ id: "claude-fable-5-10" }, false],
    [{ id: "claude-mythos-5-1other" }, false],
    [{ id: "claude-fable-5-2" }, false],
    [{ id: "gpt-5.6-luna" }, false],
    [{}, false],
  ])("resolves %j to %s", (ref, expected) => {
    expect(bindsClaudeThinkingPrefix(ref)).toBe(expected);
  });
});

describe("Claude Opus 5.5 model contract", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["opus", "claude-opus-5-5"],
    ["opus-5.5", "claude-opus-5-5"],
    ["opus-5-5", "claude-opus-5-5"],
    ["Claude Gateway/claude-opus-5-5", "claude-opus-5-5"],
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
    ["opus-5.5", true],
    ["opus-5-5", true],
    ["claude-opus-5", false],
    ["opus", true],
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
