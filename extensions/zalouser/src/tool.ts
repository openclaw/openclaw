import { Type } from "@sinclair/typebox";
import { sendImageZalouser, sendLinkZalouser, sendMessageZalouser } from "./send.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
} from "./zalo-js.js";

const ACTIONS = ["send", "image", "link", "friends", "groups", "me", "status"] as const;

type AgentToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
};

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export const ZalouserToolSchema = Type.Object(
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

type ToolParams = {
  action: (typeof ACTIONS)[number];
  threadId?: string;
  message?: string;
  isGroup?: boolean;
  profile?: string;
  query?: string;
  url?: string;
};

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export async function executeZalouserTool(
  _toolCallId: string,
  params: ToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
): Promise<AgentToolResult> {
  try {
    switch (params.action) {
      case "send": {
        if (!params.threadId || !params.message) {
          throw new Error("threadId and message required for send action");
        }
        const result = await sendMessageZalouser(params.threadId, params.message, {
          profile: params.profile,
          isGroup: params.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send message");
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "image": {
        if (!params.threadId) {
          throw new Error("threadId required for image action");
        }
        if (!params.url) {
          throw new Error("url required for image action");
        }
        const result = await sendImageZalouser(params.threadId, params.url, {
          profile: params.profile,
          caption: params.message,
          isGroup: params.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send image");
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "link": {
        if (!params.threadId || !params.url) {
          throw new Error("threadId and url required for link action");
        }
        const result = await sendLinkZalouser(params.threadId, params.url, {
          profile: params.profile,
          caption: params.message,
          isGroup: params.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send link");
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
