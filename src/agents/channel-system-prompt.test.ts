import { describe, expect, it } from "vitest";
import type { ChannelsConfig } from "../config/types.channels.js";
import { composeChannelSystemPrompt, resolveChannelSystemPrompt } from "./channel-system-prompt.js";

function makeConfig(pluginId: string, mapping: Record<string, string> | undefined): ChannelsConfig {
  return {
    [pluginId]: mapping ? { systemPromptByChannel: mapping } : {},
  } as ChannelsConfig;
}

const passthroughResolvePath = (raw: string, _workspaceDir: string) => raw;

describe("resolveChannelSystemPrompt", () => {
  it("returns not-configured when channelPluginId is missing", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: undefined,
      conversationId: "C123",
      channelsConfig: makeConfig("slack", { C123: "prompt.md" }),
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });

  it("returns not-configured when conversationId is missing", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: undefined,
      channelsConfig: makeConfig("slack", { C123: "prompt.md" }),
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });

  it("returns not-configured when channelsConfig is missing", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: undefined,
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });

  it("returns not-configured when the plugin section is absent", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: makeConfig("discord", { "111": "prompt.md" }),
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });

  it("returns not-configured when the conversation id has no mapping", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C999",
      channelsConfig: makeConfig("slack", { C123: "prompt.md" }),
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });

  it("returns loaded with file content when the mapping and file exist", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: makeConfig("slack", { C123: "prompts/analytics.md" }),
      workspaceDir: "/ws",
      readFile: (p) =>
        p === "/ws/prompts/analytics.md" ? "You are the analytics agent." : undefined,
      resolvePath: (raw, ws) => `${ws}/${raw}`,
    });
    expect(result).toEqual({
      kind: "loaded",
      content: "You are the analytics agent.",
      path: "/ws/prompts/analytics.md",
    });
  });

  it("returns missing-file when the mapping points at a file that cannot be read", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: makeConfig("slack", { C123: "prompts/missing.md" }),
      workspaceDir: "/ws",
      readFile: () => undefined,
      resolvePath: (raw, ws) => `${ws}/${raw}`,
    });
    expect(result).toEqual({ kind: "missing-file", path: "/ws/prompts/missing.md" });
  });

  it("produces byte-identical loaded results across repeated calls with stable inputs", () => {
    const args = {
      channelPluginId: "discord",
      conversationId: "111111111111111111",
      channelsConfig: makeConfig("discord", { "111111111111111111": "general.md" }),
      workspaceDir: "/ws",
      readFile: (p: string) =>
        p === "/ws/general.md" ? "You are the general channel agent." : undefined,
      resolvePath: (raw: string, ws: string) => `${ws}/${raw}`,
    };
    const first = resolveChannelSystemPrompt(args);
    const second = resolveChannelSystemPrompt(args);
    expect(first).toEqual(second);
    if (first.kind === "loaded" && second.kind === "loaded") {
      expect(first.content).toBe(second.content);
      expect(first.path).toBe(second.path);
    } else {
      expect.fail("expected loaded results");
    }
  });

  it("treats an empty-string mapping value as not-configured", () => {
    const result = resolveChannelSystemPrompt({
      channelPluginId: "slack",
      conversationId: "C123",
      channelsConfig: makeConfig("slack", { C123: "" }),
      workspaceDir: "/ws",
      readFile: () => "ignored",
      resolvePath: passthroughResolvePath,
    });
    expect(result).toEqual({ kind: "not-configured" });
  });
});

describe("composeChannelSystemPrompt", () => {
  it("returns undefined when both inputs are undefined", () => {
    expect(composeChannelSystemPrompt(undefined, undefined)).toBeUndefined();
  });

  it("returns the channel prompt alone when extras are absent", () => {
    expect(composeChannelSystemPrompt("channel", undefined)).toBe("channel");
  });

  it("returns the extras alone when the channel prompt is absent", () => {
    expect(composeChannelSystemPrompt(undefined, "extras")).toBe("extras");
  });

  it("prepends channel prompt and separates with a blank line when both present", () => {
    expect(composeChannelSystemPrompt("channel", "extras")).toBe("channel\n\nextras");
  });
});
