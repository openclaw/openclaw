import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  readDiscordComponentSpec,
  type DiscordComponentMessageSpec,
} from "../components.js";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
  TopLevelComponents,
} from "../internal/discord.js";
import { registerBuiltDiscordComponentMessage } from "../send.components.js";

export const DISCORD_EMPTY_VISIBLE_REPLY_WARNING = "⚠️ Command produced no visible reply.";

export function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10062 || err.rawBody?.code === 10062) {
    return true;
  }
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
    return true;
  }
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) {
    return true;
  }
  return false;
}

export function hasRenderableReplyPayload(payload: ReplyPayload): boolean {
  if (resolveSendableOutboundReplyParts(payload).hasContent) {
    return true;
  }
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] | DiscordComponentMessageSpec }
    | undefined;
  if (Array.isArray(discordData?.components) && discordData.components.length > 0) {
    return true;
  }
  if (readDiscordInteractionComponentSpec(payload)) {
    return true;
  }
  return false;
}

function readDiscordInteractionComponentSpec(
  payload: ReplyPayload,
): DiscordComponentMessageSpec | undefined {
  const discordData = payload.channelData?.discord as { components?: unknown } | undefined;
  return discordData?.components &&
    typeof discordData.components === "object" &&
    !Array.isArray(discordData.components)
    ? (readDiscordComponentSpec(discordData.components) ?? undefined)
    : undefined;
}

export async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      logVerbose(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
  }
}

export async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  chunkMode: "length" | "newline";
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const reply = resolveSendableOutboundReplyParts(payload);
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[] | DiscordComponentMessageSpec }
    | undefined;
  const componentSpec = readDiscordInteractionComponentSpec(payload);
  const componentBuildResult = componentSpec
    ? buildDiscordComponentMessage({
        spec: {
          ...componentSpec,
          text: componentSpec.text ?? (reply.text?.trim() ? reply.text : undefined),
        },
      })
    : undefined;
  let firstMessageComponents = componentBuildResult
    ? componentBuildResult.components
    : Array.isArray(discordData?.components) && discordData.components.length > 0
      ? discordData.components
      : undefined;
  const componentFlags = componentBuildResult
    ? buildDiscordComponentMessageFlags(componentBuildResult.components)
    : undefined;
  const chunkSourceText = componentBuildResult ? "" : reply.text;

  let firstMessageRegistered = false;
  const registerFirstMessageComponents = async (sendResult: unknown) => {
    if (firstMessageRegistered || !componentBuildResult) {
      return;
    }
    const messageId =
      sendResult &&
      typeof sendResult === "object" &&
      typeof (sendResult as { id?: unknown }).id === "string"
        ? (sendResult as { id: string }).id
        : typeof interaction.fetchReply === "function"
          ? await interaction
              .fetchReply()
              .then((replyResult) =>
                replyResult &&
                typeof replyResult === "object" &&
                typeof (replyResult as { id?: unknown }).id === "string"
                  ? (replyResult as { id: string }).id
                  : undefined,
              )
          : undefined;
    if (!messageId) {
      return;
    }
    registerBuiltDiscordComponentMessage({
      buildResult: componentBuildResult,
      messageId,
    });
    firstMessageRegistered = true;
  };

  let hasReplied = false;
  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
    components?: TopLevelComponents[],
  ) => {
    const contentPayload = content ? { content } : {};
    const messageComponentFlags = components ? componentFlags : undefined;
    const payload =
      files && files.length > 0
        ? {
            ...contentPayload,
            ...(components ? { components } : {}),
            ...(messageComponentFlags ? { flags: messageComponentFlags } : {}),
            ...(params.responseEphemeral !== undefined
              ? { ephemeral: params.responseEphemeral }
              : {}),
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : {
            ...contentPayload,
            ...(components ? { components } : {}),
            ...(messageComponentFlags ? { flags: messageComponentFlags } : {}),
            ...(params.responseEphemeral !== undefined
              ? { ephemeral: params.responseEphemeral }
              : {}),
          };
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        const sendResult = await interaction.reply(payload);
        await registerFirstMessageComponents(sendResult);
        hasReplied = true;
        firstMessageComponents = undefined;
        return;
      }
      const sendResult = await interaction.followUp(payload);
      await registerFirstMessageComponents(sendResult);
      hasReplied = true;
      firstMessageComponents = undefined;
    });
  };

  if (reply.hasMedia) {
    const media = await Promise.all(
      reply.mediaUrls.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots,
        });
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = resolveTextChunksWithFallback(
      chunkSourceText,
      chunkDiscordTextWithMode(chunkSourceText, {
        maxChars: textLimit,
        maxLines: maxLinesPerMessage,
        chunkMode,
      }),
    );
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media, firstMessageComponents);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await sendMessage(chunk);
    }
    return;
  }

  if (!reply.hasText && !firstMessageComponents) {
    return;
  }
  let chunks =
    chunkSourceText || firstMessageComponents
      ? resolveTextChunksWithFallback(
          chunkSourceText,
          chunkDiscordTextWithMode(chunkSourceText, {
            maxChars: textLimit,
            maxLines: maxLinesPerMessage,
            chunkMode,
          }),
        )
      : [];
  if (chunks.length === 0 && firstMessageComponents) {
    chunks = [""];
  }
  for (const chunk of chunks) {
    if (!chunk.trim() && !firstMessageComponents) {
      continue;
    }
    await sendMessage(chunk, undefined, firstMessageComponents);
  }
}
