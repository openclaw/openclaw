import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-runtime";
import { openUrl } from "openclaw/plugin-sdk/browser";
import {
  optionalStringEnum,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { resolveChatgptAppsConfig } from "./config.js";
import { linkChatgptApp, listChatgptAppsForLinking } from "./link-service.js";

const CHATGPT_LINK_TOOL_EXTERNAL_CHANNELS = new Set([
  "discord",
  "feishu",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "signal",
  "slack",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
]);

const ChatgptAppsToolSchema = Type.Object(
  {
    refresh: Type.Optional(
      Type.Boolean({
        description: "Refresh the authoritative ChatGPT apps inventory before returning results.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ChatgptAppLinkToolSchema = Type.Object(
  {
    appId: Type.String({
      description: "The ChatGPT app id from the app inventory.",
    }),
    waitForCompletion: Type.Optional(
      Type.Boolean({
        description: "Wait for the app inventory to report that linking completed.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Optional wait timeout override in seconds.",
        minimum: 0,
      }),
    ),
    openMode: optionalStringEnum(["auto", "print_only"] as const, {
      description: "Use browser-open when possible or return the URL without opening it.",
    }),
  },
  { additionalProperties: false },
);

function shouldExposeChatgptLinkTools(ctx: OpenClawPluginToolContext): boolean {
  if (ctx.senderIsOwner !== true) {
    return false;
  }
  const channel = ctx.messageChannel?.trim().toLowerCase();
  if (!channel) {
    return true;
  }
  return !CHATGPT_LINK_TOOL_EXTERNAL_CHANNELS.has(channel);
}

function createChatgptAppsInventoryTool(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "chatgpt_apps",
    label: "ChatGPT Apps",
    ownerOnly: true,
    description:
      "List the authoritative ChatGPT app inventory grouped by accessibility and linkability.",
    parameters: ChatgptAppsToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const refresh = readBooleanParam(rawParams, "refresh") === true;
      return jsonResult(
        await listChatgptAppsForLinking({
          config: api.config,
          pluginConfig: api.pluginConfig,
          stateDir: api.runtime.state.resolveStateDir(),
          workspaceDir: ctx.workspaceDir,
          env: process.env,
          forceRefetch: refresh,
        }),
      );
    },
  };
}

function createChatgptAppLinkTool(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "chatgpt_app_link",
    label: "ChatGPT App Link",
    ownerOnly: true,
    description:
      "Open or print a ChatGPT app install URL, then optionally wait for the inventory to report that linking completed.",
    parameters: ChatgptAppLinkToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const appId = readStringParam(rawParams, "appId", { required: true });
      const waitForCompletion = readBooleanParam(rawParams, "waitForCompletion") ?? true;
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });
      const openMode =
        readStringParam(rawParams, "openMode") === "print_only" ? "print_only" : "auto";

      return jsonResult(
        await linkChatgptApp({
          config: api.config,
          pluginConfig: api.pluginConfig,
          stateDir: api.runtime.state.resolveStateDir(),
          workspaceDir: ctx.workspaceDir,
          env: process.env,
          appId,
          waitForCompletion,
          timeoutSeconds,
          openMode,
          openUrl,
        }),
      );
    },
  };
}

export function createChatgptAppsLinkToolFactory(
  api: OpenClawPluginApi,
): OpenClawPluginToolFactory | null {
  const config = resolveChatgptAppsConfig(api.pluginConfig);
  if (!config.enabled || !config.linking.enabled) {
    return null;
  }

  return (ctx: OpenClawPluginToolContext) => {
    if (!shouldExposeChatgptLinkTools(ctx)) {
      return null;
    }

    return [createChatgptAppsInventoryTool(api, ctx), createChatgptAppLinkTool(api, ctx)];
  };
}
