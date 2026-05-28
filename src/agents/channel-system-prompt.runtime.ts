import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ChannelsConfig } from "../config/types.channels.js";
import { composeChannelSystemPrompt, resolveChannelSystemPrompt } from "./channel-system-prompt.js";
import { log } from "./embedded-agent-runner/logger.js";

const warnedMissingPaths = new Set<string>();

function expandHome(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

function resolvePromptPath(raw: string, workspaceDir: string): string {
  const expandedRaw = expandHome(raw);
  if (path.isAbsolute(expandedRaw)) {
    return expandedRaw;
  }
  return path.resolve(expandHome(workspaceDir), expandedRaw);
}

function readFileOrUndefined(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

export function applyChannelSystemPrompt(params: {
  channelPluginId: string | undefined;
  conversationId: string | undefined;
  channelsConfig: ChannelsConfig | undefined;
  workspaceDir: string;
  extraSystemPrompt: string | undefined;
}): string | undefined {
  const result = resolveChannelSystemPrompt({
    channelPluginId: params.channelPluginId,
    conversationId: params.conversationId,
    channelsConfig: params.channelsConfig,
    workspaceDir: params.workspaceDir,
    readFile: readFileOrUndefined,
    resolvePath: resolvePromptPath,
  });

  if (result.kind === "missing-file") {
    if (!warnedMissingPaths.has(result.path)) {
      warnedMissingPaths.add(result.path);
      log.warn(
        `[channel-system-prompt] configured prompt file not readable: ${result.path} (channel=${params.channelPluginId} conversation=${params.conversationId})`,
      );
    }
    return params.extraSystemPrompt;
  }

  if (result.kind === "not-configured") {
    return params.extraSystemPrompt;
  }

  return composeChannelSystemPrompt(result.content, params.extraSystemPrompt);
}

const testing = {
  resetWarnedPaths(): void {
    warnedMissingPaths.clear();
  },
};

export { testing as __testing };
