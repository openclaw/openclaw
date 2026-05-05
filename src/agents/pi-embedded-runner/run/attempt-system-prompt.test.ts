import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
    expect(result.systemPrompt).not.toContain("USER.md");
  });

  it("preserves extraSystemPrompt (subagent task) under systemPromptOverride", () => {
    const subagentTaskBlock = [
      "# Subagent Context",
      "",
      "## Your Role",
      "- You were created to handle: Analyze stock 300274 and report risks.",
      "- Complete this task. That's your entire purpose.",
      "",
    ].join("\n");

    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "## **Your Role**\n\nYou are the finance subagent.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        promptMode: "minimal",
        extraSystemPrompt: subagentTaskBlock,
        runtimeInfo: {
          host: "test-host",
          os: "Windows_NT",
          arch: "x64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    // Override prompt is still applied verbatim.
    expect(result.systemPrompt).toContain("You are the finance subagent.");
    // Subagent task block is preserved verbatim under the minimal-mode header.
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("Analyze stock 300274 and report risks.");
  });

  it("uses Group Chat Context header for non-minimal extraSystemPrompt under override", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      systemPromptOverrideText: "Custom override prompt.",
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        promptMode: "full",
        extraSystemPrompt: "Group chat hint: be concise.",
        runtimeInfo: {
          host: "test-host",
          os: "Windows_NT",
          arch: "x64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("## Group Chat Context");
    expect(result.systemPrompt).toContain("Group chat hint: be concise.");
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
