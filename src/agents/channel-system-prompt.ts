import type { ChannelsConfig, ExtensionChannelConfig } from "../config/types.channels.js";

export type ChannelSystemPromptResult =
  | { kind: "not-configured" }
  | { kind: "loaded"; content: string; path: string }
  | { kind: "missing-file"; path: string };

export type ResolveChannelSystemPromptArgs = {
  channelPluginId: string | undefined;
  conversationId: string | undefined;
  channelsConfig: ChannelsConfig | undefined;
  workspaceDir: string;
  readFile: (absolutePath: string) => string | undefined;
  resolvePath: (raw: string, workspaceDir: string) => string;
};

export function resolveChannelSystemPrompt(
  args: ResolveChannelSystemPromptArgs,
): ChannelSystemPromptResult {
  const { channelPluginId, conversationId, channelsConfig, workspaceDir, readFile, resolvePath } =
    args;
  if (!channelPluginId || !conversationId || !channelsConfig) {
    return { kind: "not-configured" };
  }
  const pluginSection = channelsConfig[channelPluginId];
  if (!pluginSection || typeof pluginSection !== "object") {
    return { kind: "not-configured" };
  }
  const mapping = (pluginSection as ExtensionChannelConfig).systemPromptByChannel;
  if (!mapping || typeof mapping !== "object") {
    return { kind: "not-configured" };
  }
  const rawPath = mapping[conversationId];
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { kind: "not-configured" };
  }
  const absolutePath = resolvePath(rawPath, workspaceDir);
  const content = readFile(absolutePath);
  if (content === undefined) {
    return { kind: "missing-file", path: absolutePath };
  }
  return { kind: "loaded", content, path: absolutePath };
}

export function composeChannelSystemPrompt(
  channelPrompt: string | undefined,
  extraSystemPrompt: string | undefined,
): string | undefined {
  if (channelPrompt && extraSystemPrompt) {
    return `${channelPrompt}\n\n${extraSystemPrompt}`;
  }
  return channelPrompt ?? extraSystemPrompt;
}
