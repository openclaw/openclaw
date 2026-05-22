import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  stripSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../../system-prompt-cache-boundary.js";

let buildAttemptSystemPrompt: typeof import("./attempt-system-prompt.js").buildAttemptSystemPrompt;

beforeEach(async () => {
  vi.resetModules();
  vi.doUnmock("../system-prompt.js");
  ({ buildAttemptSystemPrompt } = await import("./attempt-system-prompt.js"));
});

const baseProviderTransform = {
  provider: "openai",
  workspaceDir: "/tmp/openclaw",
  context: {
    provider: "openai",
    modelId: "gpt-5.5",
    promptMode: "full" as const,
  },
};

const transformProviderSystemPrompt: Parameters<
  typeof buildAttemptSystemPrompt
>[0]["transformProviderSystemPrompt"] = ({ context }) => context.systemPrompt;

describe("buildAttemptSystemPrompt", () => {
  it("preserves bootstrap Project Context when a system prompt override is configured", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "Custom override prompt.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        bootstrapTruncationNotice: "Bootstrap context was truncated.",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
          {
            path: "/tmp/openclaw/USER.md",
            content: "User profile should stay in normal prompt context only.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Custom override prompt.");
    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
    expect(result.systemPrompt).not.toContain("USER.md");
  });

  it("preserves runtime extra system prompt context when a system prompt override is configured", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "Custom override prompt.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        promptMode: "minimal",
        extraSystemPrompt:
          "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Custom override prompt.");
    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("RUN_MODE_TASK_77950");
  });

  it("emits a cache boundary that precedes subagent context when a system prompt override is configured (#85203)", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "Custom override prompt.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        promptMode: "minimal",
        extraSystemPrompt: "## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    const markerIdx = result.systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const subagentHeaderIdx = result.systemPrompt.indexOf("## Subagent Context");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(subagentHeaderIdx).toBeGreaterThan(markerIdx);
    expect(result.systemPrompt.slice(0, markerIdx)).toContain("Custom override prompt.");

    // Lock in the disclosed single-newline separator AFTER provider strip:
    // override+extraSystemPrompt now joins through marker + helper, so the
    // stripped byte sequence puts exactly one "\n" between the pre-marker
    // content and "## Subagent Context" — not the previous "\n\n" gap.
    const stripped = stripSystemPromptCacheBoundary(result.systemPrompt);
    const strippedSubIdx = stripped.indexOf("## Subagent Context");
    expect(strippedSubIdx).toBeGreaterThan(0);
    expect(stripped[strippedSubIdx - 1]).toBe("\n");
    expect(stripped[strippedSubIdx - 2]).not.toBe("\n");
  });

  it("strips marker substrings smuggled in via extraSystemPrompt so providers never see nested cache boundaries (#85203)", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "Custom override prompt.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        promptMode: "minimal",
        extraSystemPrompt: `Task body that accidentally embeds the sentinel ${SYSTEM_PROMPT_CACHE_BOUNDARY}before we finish.`,
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    const markerCount = result.systemPrompt.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1;
    expect(markerCount).toBe(1);
    const markerIdx = result.systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const subagentHeaderIdx = result.systemPrompt.indexOf("## Subagent Context");
    expect(subagentHeaderIdx).toBeGreaterThan(markerIdx);
    expect(stripSystemPromptCacheBoundary(result.systemPrompt)).not.toContain(
      "OPENCLAW_CACHE_BOUNDARY",
    );
  });

  it("omits system prompts for raw model probes", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(result.systemPrompt).toBe("");
    expect(result.systemPromptOverride()).toBe("");
  });
});
