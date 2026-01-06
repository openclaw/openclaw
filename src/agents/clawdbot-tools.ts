import type { ClawdbotConfig } from "../config/config.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createDiscordTool } from "./tools/discord-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSlackTool } from "./tools/slack-tool.js";

export function createClawdbotTools(options?: {
  browserControlUrl?: string;
  agentSessionKey?: string;
  agentSurface?: string;
  config?: ClawdbotConfig;
}): AnyAgentTool[] {
  const imageTool = createImageTool({ config: options?.config });
  return [
    createBrowserTool({ defaultControlUrl: options?.browserControlUrl }),
    createCanvasTool(),
    createNodesTool(),
    createCronTool(),
    createDiscordTool(),
    createSlackTool(),
    createGatewayTool(),
    createSessionsListTool(),
    createSessionsHistoryTool(),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentSurface: options?.agentSurface,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentSurface: options?.agentSurface,
    }),
    ...(imageTool ? [imageTool] : []),
  ];
}
