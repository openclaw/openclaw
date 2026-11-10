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

// A Claude model OpenClaw has never seen must get every restriction and no
// optional capability, with no code change, until its /v1/models row says otherwise.
it.each([
  "claude-zzz-9-9",
  "anthropic/claude-zzz-9-9",
  "anthropic.claude-zzz-9-9-v1:0",
  "claude-fable-5-2",
])("applies the strict Claude contract to %s", (id) => {
  for (const ref of [{ id }, { id: "deployment", params: { canonicalModelId: id } }]) {
    expect(claude.bindsClaudeThinkingPrefix(ref)).toBe(true);
    expect(claude.supportsClaudeAdaptiveThinking(ref)).toBe(true);
    expect(claude.requiresClaudeMandatoryAdaptiveThinking(ref)).toBe(true);
    expect(claude.requiresClaudeDefaultSampling(ref)).toBe(true);
    expect(claude.usesClaude5RequestContract(ref)).toBe(true);
    expect(claude.rejectsClaudeAssistantPrefill(ref)).toBe(true);
    expect(claude.requiresClaudeBetweenToolsThinking(ref)).toBe(false);
    expect(claude.supportsClaudeFastMode(ref)).toBe(false);
  }
});

it("applies no Claude contract to non-Claude models", () => {
  for (const id of ["gpt-6-astra", "MiniMax-M2", "kimi-k3"]) {
    expect(claude.bindsClaudeThinkingPrefix({ id })).toBe(false);
    expect(claude.requiresClaudeMandatoryAdaptiveThinking({ id })).toBe(false);
    expect(claude.requiresClaudeDefaultSampling({ id })).toBe(false);
    expect(claude.rejectsClaudeAssistantPrefill({ id })).toBe(false);
  }
});

// The closed lists relax the strict contract only for these released generations.
it.each([
  [
    "claude-3-5-sonnet-20241022",
    { binds: false, mandatory: false, adaptive: false, sampling: false },
  ],
  [
    "claude-sonnet-4-5-20250929",
    { binds: false, mandatory: false, adaptive: false, sampling: false },
  ],
  ["claude-opus-4-6", { binds: false, mandatory: false, adaptive: true, sampling: false }],
  ["claude-opus-4-8", { binds: false, mandatory: false, adaptive: true, sampling: true }],
  ["claude-opus-5-20260724", { binds: false, mandatory: false, adaptive: true, sampling: true }],
  ["claude-fable-5", { binds: false, mandatory: true, adaptive: true, sampling: true }],
  ["claude-fable-5-1", { binds: true, mandatory: true, adaptive: true, sampling: true }],
  ["claude-opus-5-5", { binds: true, mandatory: true, adaptive: true, sampling: true }],
  ["claude-haiku-5-5", { binds: true, mandatory: false, adaptive: true, sampling: true }],
  ["claude-mythos-5-1", { binds: true, mandatory: true, adaptive: true, sampling: true }],
] as const)("keeps the released contract for %s", (id, expected) => {
  expect(claude.bindsClaudeThinkingPrefix({ id })).toBe(expected.binds);
  expect(claude.requiresClaudeMandatoryAdaptiveThinking({ id })).toBe(expected.mandatory);
  expect(claude.supportsClaudeAdaptiveThinking({ id })).toBe(expected.adaptive);
  expect(claude.requiresClaudeDefaultSampling({ id })).toBe(expected.sampling);
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
