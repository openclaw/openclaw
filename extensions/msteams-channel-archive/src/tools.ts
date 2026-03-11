import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/msteams";
import { parseSearchDate, type MSTeamsChannelArchiveStore } from "./archive-store.js";

const TOOL_LIMIT_MIN = 1;
const TOOL_LIMIT_MAX = 100;

const ChannelArchiveSearchSchema = Type.Object(
  {
    conversationId: Type.Optional(
      Type.String({ description: "Teams conversationId to scope the search" }),
    ),
    query: Type.Optional(Type.String({ description: "Case-insensitive text query" })),
    threadId: Type.Optional(
      Type.String({ description: "Thread/root message id to scope results" }),
    ),
    senderId: Type.Optional(Type.String({ description: "Sender AAD/Teams id to filter by" })),
    since: Type.Optional(
      Type.String({ description: "Only include messages on or after this ISO timestamp" }),
    ),
    until: Type.Optional(
      Type.String({ description: "Only include messages on or before this ISO timestamp" }),
    ),
    hasAttachments: Type.Optional(
      Type.Boolean({ description: "Filter by whether messages have attachments" }),
    ),
    limit: Type.Optional(
      Type.Number({ minimum: TOOL_LIMIT_MIN, maximum: TOOL_LIMIT_MAX, description: "Max results" }),
    ),
  },
  { additionalProperties: false },
);

const ChannelArchiveGetMessageSchema = Type.Object(
  {
    conversationId: Type.String({ description: "Teams conversationId containing the message" }),
    messageId: Type.String({ description: "Teams message id" }),
  },
  { additionalProperties: false },
);

const ChannelArchiveGetThreadSchema = Type.Object(
  {
    conversationId: Type.String({ description: "Teams conversationId containing the thread" }),
    threadId: Type.Optional(Type.String({ description: "Thread id or root message id" })),
    rootMessageId: Type.Optional(Type.String({ description: "Explicit root message id" })),
    limit: Type.Optional(
      Type.Number({
        minimum: TOOL_LIMIT_MIN,
        maximum: TOOL_LIMIT_MAX,
        description: "Max messages",
      }),
    ),
  },
  { additionalProperties: false },
);

const ChannelArchiveSearchAttachmentsSchema = Type.Object(
  {
    conversationId: Type.Optional(
      Type.String({ description: "Teams conversationId to scope attachment search" }),
    ),
    query: Type.Optional(Type.String({ description: "Attachment name/hash query" })),
    mime: Type.Optional(Type.String({ description: "Exact MIME type to match" })),
    since: Type.Optional(
      Type.String({
        description: "Only include attachments from messages after this ISO timestamp",
      }),
    ),
    limit: Type.Optional(
      Type.Number({ minimum: TOOL_LIMIT_MIN, maximum: TOOL_LIMIT_MAX, description: "Max results" }),
    ),
  },
  { additionalProperties: false },
);

type ChannelArchiveSearchParams = Static<typeof ChannelArchiveSearchSchema>;
type ChannelArchiveGetMessageParams = Static<typeof ChannelArchiveGetMessageSchema>;
type ChannelArchiveGetThreadParams = Static<typeof ChannelArchiveGetThreadSchema>;
type ChannelArchiveSearchAttachmentsParams = Static<typeof ChannelArchiveSearchAttachmentsSchema>;

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerArchiveTools(
  api: OpenClawPluginApi,
  store: MSTeamsChannelArchiveStore,
): void {
  api.registerTool(
    {
      name: "channel_archive_search",
      label: "Teams Channel Archive Search",
      description: "Search archived Microsoft Teams channel messages.",
      parameters: ChannelArchiveSearchSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelArchiveSearchParams;
        const results = await store.searchMessages({
          conversationId: p.conversationId,
          query: p.query,
          threadId: p.threadId,
          senderId: p.senderId,
          since: parseSearchDate(p.since),
          until: parseSearchDate(p.until),
          hasAttachments: p.hasAttachments,
          limit: p.limit,
        });
        return jsonResult(results);
      },
    },
    { name: "channel_archive_search" },
  );

  api.registerTool(
    {
      name: "channel_archive_get_message",
      label: "Teams Channel Archive Get Message",
      description: "Get one archived Microsoft Teams channel message with attachment metadata.",
      parameters: ChannelArchiveGetMessageSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelArchiveGetMessageParams;
        const result = await store.getMessage({
          conversationId: p.conversationId,
          messageId: p.messageId,
        });
        if (!result) {
          throw new Error(`Archived message not found: ${p.messageId}`);
        }
        return jsonResult(result);
      },
    },
    { name: "channel_archive_get_message" },
  );

  api.registerTool(
    {
      name: "channel_archive_get_thread",
      label: "Teams Channel Archive Get Thread",
      description: "Get the archived messages that belong to a Teams channel thread.",
      parameters: ChannelArchiveGetThreadSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelArchiveGetThreadParams;
        const results = await store.getThread({
          conversationId: p.conversationId,
          threadId: p.threadId,
          rootMessageId: p.rootMessageId,
          limit: p.limit,
        });
        return jsonResult(results);
      },
    },
    { name: "channel_archive_get_thread" },
  );

  api.registerTool(
    {
      name: "channel_archive_search_attachments",
      label: "Teams Channel Archive Search Attachments",
      description: "Search archived Microsoft Teams channel attachments.",
      parameters: ChannelArchiveSearchAttachmentsSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelArchiveSearchAttachmentsParams;
        const results = await store.searchAttachments({
          conversationId: p.conversationId,
          query: p.query,
          mime: p.mime,
          since: parseSearchDate(p.since),
          limit: p.limit,
        });
        return jsonResult(results);
      },
    },
    { name: "channel_archive_search_attachments" },
  );
}
