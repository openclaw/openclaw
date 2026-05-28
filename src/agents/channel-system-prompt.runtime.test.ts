import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelsConfig } from "../config/types.channels.js";
import {
  __testing as runtimeTesting,
  applyChannelSystemPrompt,
} from "./channel-system-prompt.runtime.js";
import { buildEmbeddedSystemPrompt } from "./embedded-agent-runner/system-prompt.js";

describe("applyChannelSystemPrompt", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chprompt-"));
    runtimeTesting.resetWarnedPaths();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns the original extraSystemPrompt when no config is present", () => {
    const result = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: undefined,
      workspaceDir,
      extraSystemPrompt: "extras",
    });
    expect(result).toBe("extras");
  });

  it("returns the original extraSystemPrompt when no mapping matches", () => {
    const result = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C999",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "prompt.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: "extras",
    });
    expect(result).toBe("extras");
  });

  it("prepends file contents to extraSystemPrompt when the mapping resolves", () => {
    const promptPath = path.join(workspaceDir, "prompt.md");
    fs.writeFileSync(promptPath, "You are the analytics agent.");
    const result = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "prompt.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: "per-session extras",
    });
    expect(result).toBe("You are the analytics agent.\n\nper-session extras");
  });

  it("returns the channel prompt alone when extras are absent", () => {
    const promptPath = path.join(workspaceDir, "prompt.md");
    fs.writeFileSync(promptPath, "Channel role.");
    const result = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "prompt.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: undefined,
    });
    expect(result).toBe("Channel role.");
  });

  it("returns the original extraSystemPrompt when the configured file is missing", () => {
    const result = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "does-not-exist.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: "extras",
    });
    expect(result).toBe("extras");
  });

  it("honors absolute paths without joining against workspaceDir", () => {
    const absDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chprompt-abs-"));
    try {
      const absPromptPath = path.join(absDir, "role.md");
      fs.writeFileSync(absPromptPath, "Absolute role.");
      const result = applyChannelSystemPrompt({
        channelPluginId: "discord",
        conversationId: "111111111111111111",
        channelsConfig: {
          discord: { systemPromptByChannel: { "111111111111111111": absPromptPath } },
        } as ChannelsConfig,
        workspaceDir,
        extraSystemPrompt: undefined,
      });
      expect(result).toBe("Absolute role.");
    } finally {
      fs.rmSync(absDir, { recursive: true, force: true });
    }
  });

  it("produces byte-identical output across repeated calls with stable inputs", () => {
    const promptPath = path.join(workspaceDir, "prompt.md");
    fs.writeFileSync(promptPath, "Stable role.");
    const args = {
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "prompt.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: "extras",
    };
    const first = applyChannelSystemPrompt(args);
    const second = applyChannelSystemPrompt(args);
    expect(first).toBe(second);
  });
});

describe("buildEmbeddedSystemPrompt with channel prompt injection", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chprompt-build-"));
    runtimeTesting.resetWarnedPaths();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function assemble(extraSystemPrompt: string | undefined): string {
    return buildEmbeddedSystemPrompt({
      workspaceDir,
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      extraSystemPrompt,
    });
  }

  it("produces byte-identical assembled prompts across two back-to-back calls", () => {
    const promptPath = path.join(workspaceDir, "role.md");
    fs.writeFileSync(promptPath, "You are the analytics agent.");
    const enhanced = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: {
        slack: { systemPromptByChannel: { C123: "role.md" } },
      } as ChannelsConfig,
      workspaceDir,
      extraSystemPrompt: undefined,
    });
    const first = assemble(enhanced);
    const second = assemble(enhanced);
    expect(first).toBe(second);
    expect(first).toContain("You are the analytics agent.");
  });

  it("is byte-identical to pre-feature output when no channel mapping exists", () => {
    const extras = "baseline extras";
    const withoutChannel = applyChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: undefined,
      workspaceDir,
      extraSystemPrompt: extras,
    });
    expect(withoutChannel).toBe(extras);
    const assembledA = assemble(extras);
    const assembledB = assemble(withoutChannel);
    expect(assembledA).toBe(assembledB);
  });
});
