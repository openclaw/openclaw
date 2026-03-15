import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/msteams";
import { createArchiveStore } from "./src/archive-store.js";
import { createChannelArchiveCleanupService } from "./src/channel-cleanup.js";
import { registerArchiveTools } from "./src/tools.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringArray(value: unknown, options?: { preserveEmpty?: boolean }): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  return options?.preserveEmpty ? normalized : normalized.filter(Boolean);
}

function normalizeConversationId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("conversation:")) {
    const trimmed = value.slice("conversation:".length).trim();
    return trimmed || undefined;
  }
  return value;
}

const pluginConfigSchema = Type.Object(
  {
    cleanup: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          intervalMinutes: Type.Optional(Type.Number({ minimum: 5 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const plugin = {
  id: "msteams-channel-archive",
  name: "Microsoft Teams Channel Archive",
  description: "Persistent archive and retrieval tools for Microsoft Teams channel history.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const store = createArchiveStore({
      stateDir: api.runtime.state.resolveStateDir(),
      logger: api.logger,
    });

    registerArchiveTools(api, store);
    api.registerService(createChannelArchiveCleanupService({ api, store }));

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "msteams") {
        return;
      }

      const metadata = readRecord(event.metadata);
      const provider = readString(metadata?.provider);
      if (provider && provider !== "msteams") {
        return;
      }

      const providerMetadata = readRecord(metadata?.providerMetadata);
      const chatType = readString(metadata?.chatType);
      const conversationType = readString(providerMetadata?.conversationType) ?? chatType;
      if (chatType !== "channel" && conversationType !== "channel") {
        return;
      }

      const conversationId = normalizeConversationId(ctx.conversationId);
      if (!conversationId) {
        api.logger.warn("msteams-channel-archive: missing conversationId for channel message");
        return;
      }

      await store.archiveMessage({
        conversationId,
        messageId: readString(metadata?.messageId),
        replyToId: readString(metadata?.replyToId),
        threadId: readString(metadata?.threadId),
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
        content: event.content,
        rawBody: event.content,
        chatType,
        conversationType,
        tenantId: readString(providerMetadata?.tenantId),
        teamId: readString(providerMetadata?.teamId),
        teamName: readString(providerMetadata?.teamName),
        channelId:
          readString(providerMetadata?.channelId) ??
          readString(metadata?.nativeChannelId) ??
          undefined,
        channelName: readString(metadata?.channelName),
        senderId: readString(metadata?.senderId),
        senderName: readString(metadata?.senderName),
        mediaPaths: readStringArray(metadata?.mediaPaths),
        // Keep empty MIME slots so mediaTypes stays index-aligned with mediaPaths.
        mediaTypes: readStringArray(metadata?.mediaTypes, { preserveEmpty: true }),
      });
    });

    api.on("channel_deleted", async (event, ctx) => {
      if (ctx.channelId !== "msteams") {
        return;
      }
      const metadata = readRecord(event.metadata);
      const provider = readString(metadata?.provider);
      if (provider && provider !== "msteams") {
        return;
      }
      const conversationId =
        normalizeConversationId(event.conversationId) ??
        normalizeConversationId(ctx.conversationId);
      if (!conversationId) {
        api.logger.warn(
          "msteams-channel-archive: missing conversationId for deleted channel event",
        );
        return;
      }
      await store.pruneConversation(conversationId);
    });
  },
};

export default plugin;
