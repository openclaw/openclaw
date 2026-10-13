import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { jsonResult as json, type AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { resolveZalouserAccountSync } from "./accounts.js";
import { sendImageZalouser, sendMessageZalouser } from "./send.js";
import { parseZalouserOutboundTarget } from "./session-route.js";
import { normalizeZalouserCredentialProfile } from "./session-state.js";
import type { ZalouserConfig } from "./types.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
  sendZaloLink,
} from "./zalo-js.js";

const ACTIONS = ["send", "image", "link", "friends", "groups", "me", "status"] as const;

const ZalouserToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
    threadId: Type.Optional(Type.String({ description: "Thread ID for messaging" })),
    message: Type.Optional(Type.String({ description: "Message text" })),
    isGroup: Type.Optional(Type.Boolean({ description: "Is group chat" })),
    profile: Type.Optional(Type.String({ description: "Profile name" })),
    query: Type.Optional(Type.String({ description: "Search query" })),
    url: Type.Optional(Type.String({ description: "URL for media/link" })),
  },
  { additionalProperties: false },
);

type ToolParams = Static<typeof ZalouserToolSchema>;

type ZalouserToolContext = Pick<
  OpenClawPluginToolContext,
  "deliveryContext" | "config" | "runtimeConfig" | "getRuntimeConfig"
>;

function resolveToolMediaMaxBytes(profile: string | undefined, context?: ZalouserToolContext) {
  const cfg = context?.getRuntimeConfig?.() ?? context?.runtimeConfig ?? context?.config ?? {};
  const route = context?.deliveryContext;
  if (route?.channel === "zalouser" && route.accountId) {
    const account = resolveZalouserAccountSync({ cfg, accountId: route.accountId });
    // Profiles are credentials, not account IDs; only the actual route can select an account cap.
    if (
      normalizeZalouserCredentialProfile(account.profile) ===
      normalizeZalouserCredentialProfile(profile)
    ) {
      return account.mediaMaxBytes;
    }
  }
  return resolveChannelMediaMaxBytes({
    cfg,
    // SAFETY: The plugin schema validates this open-world channel config section.
    resolveChannelLimitMb: () => (cfg.channels?.zalouser as ZalouserConfig | undefined)?.mediaMaxMb,
  });
}

function resolveAmbientZalouserTarget(context?: ZalouserToolContext): {
  threadId?: string;
  isGroup?: boolean;
} {
  const deliveryContext = context?.deliveryContext;
  const rawTarget = deliveryContext?.to;
  if (
    (deliveryContext?.channel === undefined || deliveryContext.channel === "zalouser") &&
    typeof rawTarget === "string" &&
    rawTarget.trim()
  ) {
    try {
      return parseZalouserOutboundTarget(rawTarget);
    } catch {
      // Ignore unrelated delivery targets; explicit tool params still win.
    }
  }
  if (deliveryContext?.channel && deliveryContext.channel !== "zalouser") {
    return {};
  }
  const ambientThreadId = deliveryContext?.threadId;
  if (typeof ambientThreadId === "string" && ambientThreadId.trim()) {
    return { threadId: ambientThreadId.trim() };
  }
  if (typeof ambientThreadId === "number" && Number.isFinite(ambientThreadId)) {
    return { threadId: String(ambientThreadId) };
  }
  return {};
}

function resolveZalouserSendTarget(params: ToolParams, context?: ZalouserToolContext) {
  const explicitThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  const ambientTarget = resolveAmbientZalouserTarget(context);
  return {
    threadId: explicitThreadId || ambientTarget.threadId,
    isGroup: typeof params.isGroup === "boolean" ? params.isGroup : ambientTarget.isGroup,
  };
}

async function executeZalouserTool(
  params: ToolParams,
  signal?: AbortSignal,
  context?: ZalouserToolContext,
): Promise<AgentToolResult<unknown>> {
  try {
    switch (params.action) {
      case "send":
      case "image":
      case "link": {
        const target = resolveZalouserSendTarget(params, context);
        const content = params.action === "send" ? params.message : params.url;
        if (!target.threadId || !content) {
          const required =
            params.action === "image"
              ? target.threadId
                ? "url"
                : "threadId"
              : params.action === "send"
                ? "threadId and message"
                : "threadId and url";
          throw new Error(`${required} required for ${params.action} action`);
        }
        const send =
          params.action === "send"
            ? sendMessageZalouser
            : params.action === "image"
              ? sendImageZalouser
              : sendZaloLink;
        const result = await send(target.threadId, content, {
          signal,
          profile: params.profile,
          ...(params.action === "image"
            ? { mediaMaxBytes: resolveToolMediaMaxBytes(params.profile, context) }
            : {}),
          ...(params.action !== "send" ? { caption: params.message } : {}),
          isGroup: target.isGroup,
        });
        if (!result.ok) {
          const kind = params.action === "send" ? "message" : params.action;
          throw new Error(result.error || `Failed to send ${kind}`);
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "friends": {
        const rows = await listZaloFriendsMatching(params.profile, params.query);
        return json(rows);
      }

      case "groups": {
        const rows = await listZaloGroupsMatching(params.profile, params.query);
        return json(rows);
      }

      case "me": {
        const info = await getZaloUserInfo(params.profile);
        return json(info ?? { error: "Not authenticated" });
      }

      case "status": {
        const authenticated = await checkZaloAuthenticated(params.profile);
        return json({
          authenticated,
          output: authenticated ? "authenticated" : "not authenticated",
        });
      }

      default: {
        params.action satisfies never;
        throw new Error(
          `Unknown action: ${String(params.action)}. Valid actions: send, image, link, friends, groups, me, status`,
        );
      }
    }
  } catch (err) {
    return json({
      error: formatErrorMessage(err),
      ...(isChannelPartialDeliveryError(err)
        ? {
            ok: false,
            deliveryStatus: "partial_failed",
            sentBeforeError: true,
            result: err.deliveryResult,
          }
        : {}),
    });
  }
}

export function createZalouserTool(context?: ZalouserToolContext): AnyAgentTool {
  return {
    name: "zalouser",
    label: "Zalo Personal",
    description:
      "Send messages and access data via Zalo personal account. " +
      "Actions: send (text message), image (send image URL), link (send link), " +
      "friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
    parameters: ZalouserToolSchema,
    execute: async (_toolCallId, params, signal) =>
      await executeZalouserTool(params as ToolParams, signal, context),
  } satisfies AnyAgentTool;
}
