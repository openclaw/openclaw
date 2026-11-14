import { describe, expect, it } from "vitest";
import * as claude from "./anthropic.js";
import {
  bindsClaudeThinkingPrefix,
  requiresClaudeBetweenToolsThinking,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeOpus55ModelIdentity,
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeSonnet55ModelIdentity,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeFastMode,
  supportsClaudeInHistorySystemMessages,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  supportsClaudeServerCompaction,
} from "./anthropic.js";

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
  it.each([["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5-v1:0"]])(
    "resolves %s without broadening the version boundary",
    (id, expected) => {
      expect(resolveClaudeSonnet55ModelIdentity({ id })).toBe(expected);
    },
  );

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

  it.each([["opus-5", false]])(
    "preserves family capabilities for %s with mandatory thinking: %s",
    (id, mandatory) => {
      expect(requiresClaudeMandatoryAdaptiveThinking({ id })).toBe(mandatory);
      expect(supportsClaudeAdaptiveThinking({ id })).toBe(true);
      expect(supportsClaude1MContext({ id })).toBe(true);
      expect(supportsClaudeNativeXhighEffort({ id })).toBe(true);
      expect(supportsClaudeNativeMaxEffort({ id })).toBe(true);
      expect(supportsClaudeFastMode({ id })).toBe(true);
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

it("reads server compaction from the listed /v1/models capability", () => {
  const listed = (serverCompaction: boolean) => ({
    id: "claude-zzz-9-9",
    params: { claudeCapabilities: { serverCompaction } },
  });
  expect(claude.supportsClaudeServerCompaction({ id: "claude-zzz-9-9" })).toBe(false);
  expect(claude.supportsClaudeServerCompaction(listed(true))).toBe(true);
  expect(claude.supportsClaudeServerCompaction({ ...listed(false), id: "claude-fable-5-1" })).toBe(
    false,
  );
});
