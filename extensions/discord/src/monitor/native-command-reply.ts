import type { APIEmbed, APIMessageTopLevelComponent } from "discord-api-types/v10";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { renderPresentationForDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { registerDiscordComponentEntries } from "../components-registry.js";
import { buildDiscordComponentMessage } from "../components.js";
import {
  hasDiscordV2Components,
  type BaseComponentInteraction,
  type CommandInteraction,
  type MessagePayloadFile,
  type TopLevelComponents,
} from "../internal/discord.js";
import {
  buildDiscordPresentationPayload,
  DISCORD_PRESENTATION_CAPABILITIES,
  resolveDiscordComponentSpec,
} from "../outbound-components.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";

export const DISCORD_EMPTY_VISIBLE_REPLY_WARNING = "⚠️ Command produced no visible reply.";

/** Retain visible component text, not interaction IDs or option values. */
export function formatDiscordCommandComponents(
  components: readonly (TopLevelComponents | APIMessageTopLevelComponent)[],
): string {
  const text: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (
        (key === "content" || key === "label" || key === "description" || key === "placeholder") &&
        typeof field === "string"
      ) {
        text.push(field);
      } else if ((key === "components" || key === "options") && Array.isArray(field)) {
        field.forEach(visit);
      }
    }
  };
  components.forEach((component) =>
    visit("serialize" in component ? component.serialize() : component),
  );
  return text.join("\n");
}

export function resolveDiscordInteractionReplyOptions(
  params: Pick<DiscordCommandArgContext, "cfg" | "discordConfig" | "accountId">,
) {
  return {
    textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, {
      fallbackLimit: 2000,
    }),
    maxLinesPerMessage: resolveDiscordMaxLinesPerMessage(params),
    chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId),
  };
}

function isDiscordUnknownInteraction(error: unknown): boolean {
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
  return /Unknown interaction/i.test(err.rawBody?.message ?? "");
}

function resolveDiscordInteractionMessageParts(payload: ReplyPayload) {
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[]; embeds?: APIEmbed[] }
    | undefined;
  const { components, embeds } = discordData ?? {};
  return {
    components: Array.isArray(components) && components.length > 0 ? components : undefined,
    embeds: Array.isArray(embeds) && embeds.length > 0 ? embeds : undefined,
  };
}

export function hasRenderableReplyPayload(payload: ReplyPayload): boolean {
  const { components, embeds } = resolveDiscordInteractionMessageParts(payload);
  return hasOutboundReplyContent(payload) || Boolean(components || embeds);
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

export async function settleDiscordInteractionWithoutVisibleReply(
  interaction: CommandInteraction | BaseComponentInteraction,
): Promise<void> {
  // Only slash-command defers create Discord's visible loading response. Component
  // defers own an existing message, so deleting their original response would erase UI.
  if (interaction.responseState !== "deferred") {
    return;
  }
  await safeDiscordInteractionCall("interaction delete deferred reply", () =>
    interaction.deleteReply(),
  );
}

export async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | BaseComponentInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  componentRoute?: { accountId: string; agentId: string; sessionKey: string };
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  chunkMode: "length" | "newline";
  onDelivered?: (text: string) => Promise<void>;
}): Promise<boolean> {
  const { interaction, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const nativeParts = resolveDiscordInteractionMessageParts(params.payload);
  // Keep attachments and authored native parts on their existing delivery path.
  const preserveNativeParts =
    resolveSendableOutboundReplyParts(params.payload).hasMedia ||
    Boolean(nativeParts.components || nativeParts.embeds);
  const payload = await renderPresentationForDelivery(
    {
      presentationCapabilities: DISCORD_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted) =>
        preserveNativeParts
          ? null
          : buildDiscordPresentationPayload({
              payload: adapted,
              presentation: adapted.presentation,
            }),
    },
    params.payload,
  );
  const componentSpec = preserveNativeParts
    ? undefined
    : await resolveDiscordComponentSpec(payload);
  const componentBuild = componentSpec
    ? buildDiscordComponentMessage({ spec: componentSpec, ...params.componentRoute })
    : undefined;
  const reply = resolveSendableOutboundReplyParts(payload);
  const messageParts = resolveDiscordInteractionMessageParts(payload);
  const firstMessageComponents = componentBuild?.components ?? messageParts.components;
  const firstMessageEmbeds = messageParts.embeds;
  const hasFirstMessageParts = Boolean(firstMessageComponents || firstMessageEmbeds);

  // Interaction acknowledgement/defer state is not delivery for this payload. Only a
  // successful native send in this invocation can make a later expiry partial.
  let payloadDelivered = false;
  const deliveredText: string[] | undefined = params.onDelivered ? [] : undefined;
  const sendMessage = async (content: string, files?: MessagePayloadFile[]) => {
    const firstMessage = !payloadDelivered;
    const components = firstMessage ? firstMessageComponents : undefined;
    const embeds = firstMessage ? firstMessageEmbeds : undefined;
    const hasV2 = hasDiscordV2Components(components);
    const payloadLocal = {
      ...(content && !hasV2 ? { content } : {}),
      ...(components ? { components } : {}),
      ...(embeds && !hasV2 ? { embeds } : {}),
      ...(params.responseEphemeral !== undefined ? { ephemeral: params.responseEphemeral } : {}),
      ...(files?.length ? { files } : {}),
    };
    try {
      const result = await safeDiscordInteractionCall("interaction send", async () => {
        const sent =
          await interaction[!preferFollowUp && !payloadDelivered ? "reply" : "followUp"](
            payloadLocal,
          );
        payloadDelivered = true;
        if (firstMessage && componentBuild) {
          // Initial callbacks need not return a message; callback input supplies its ID later.
          const messageId =
            sent && typeof sent === "object" && "id" in sent && typeof sent.id === "string"
              ? sent.id
              : undefined;
          await registerDiscordComponentEntries({
            entries: componentBuild.entries,
            modals: componentBuild.modals,
            messageId,
          });
        }
      });
      if (result === null) {
        throw new PlatformMessageNotDispatchedError(
          "Discord interaction expired before message dispatch",
          { cause: new Error("Unknown interaction") },
        );
      }
      if (deliveredText) {
        if (payloadLocal.content) {
          deliveredText.push(payloadLocal.content);
        }
        if (payloadLocal.components) {
          deliveredText.push(formatDiscordCommandComponents(payloadLocal.components));
        }
        for (const embed of payloadLocal.embeds ?? []) {
          deliveredText.push(
            [
              embed.title,
              embed.description,
              embed.author?.name,
              ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
              embed.footer?.text,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
    } catch (error) {
      if (!payloadDelivered) {
        throw error;
      }
      throw createChannelPartialDeliveryError(error, { visibleReplySent: true });
    }
  };

  const files = reply.hasMedia
    ? await Promise.all(
        reply.mediaUrls.map(async (url) => {
          const loaded = await loadWebMedia(url, {
            localRoots: params.mediaLocalRoots,
          });
          return {
            name: loaded.fileName ?? "upload",
            data: loaded.buffer,
            contentType: loaded.contentType,
          };
        }),
      )
    : undefined;

  if (!files && !reply.hasText && !hasFirstMessageParts) {
    return false;
  }
  const chunks = resolveTextChunksWithFallback(
    reply.text,
    chunkDiscordTextWithMode(reply.text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
      chunkMode,
    }),
  );
  if (chunks.length === 0) {
    chunks.push("");
  }
  for (const [index, chunk] of chunks.entries()) {
    const chunkFiles = index === 0 ? files : undefined;
    if (!chunk.trim() && !chunkFiles && (payloadDelivered || !hasFirstMessageParts)) {
      continue;
    }
    await sendMessage(chunk, chunkFiles);
  }
  if (payloadDelivered && params.onDelivered) {
    await params.onDelivered(deliveredText?.filter(Boolean).join("\n") ?? "");
  }
  return payloadDelivered;
}
