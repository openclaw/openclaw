import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { DispatchTelegramMessageParams } from "./bot-message-dispatch.types.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import { resolveStickerVisionSupport } from "./sticker-vision.js";

function includeStickerDescription(params: {
  body: string | undefined;
  formattedDescription: string;
}): string {
  if (!params.body?.trim()) {
    return params.formattedDescription;
  }
  if (params.body.includes(params.formattedDescription)) {
    return params.body;
  }
  return `${params.formattedDescription}\n${params.body}`;
}

export async function prepareTelegramSticker(params: {
  cfg: DispatchTelegramMessageParams["cfg"];
  context: TelegramMessageContext;
}) {
  const { context } = params;
  const sticker = context.ctxPayload.Sticker;
  const stickerFact = context.ctxPayload.media?.find((media) => media.kind === "sticker");
  const stickerPath =
    stickerFact?.path ??
    (!stickerFact && context.ctxPayload.StickerMediaIncluded
      ? context.ctxPayload.media?.[0]?.path
      : undefined);
  if (!sticker?.fileId || !sticker.fileUniqueId || !stickerPath) {
    return;
  }
  const agentDir = resolveAgentDir(params.cfg, context.route.agentId);
  const stickerSupportsVision = await resolveStickerVisionSupport({
    cfg: params.cfg,
    agentId: context.route.agentId,
  });
  const description =
    sticker.cachedDescription ||
    (await describeStickerImage({
      imagePath: stickerPath,
      cfg: params.cfg,
      agentDir,
      agentId: context.route.agentId,
    }));
  if (!description) {
    return;
  }
  const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
    .filter(Boolean)
    .join(" ");
  const formattedDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
  sticker.cachedDescription = description;
  if (!stickerSupportsVision) {
    context.ctxPayload.Body = includeStickerDescription({
      body: context.ctxPayload.Body,
      formattedDescription,
    });
    // Reply finalization projects BodyForAgent from the canonical agent text.
    context.ctxPayload.agentText = includeStickerDescription({
      body: context.ctxPayload.agentText ?? context.ctxPayload.BodyForAgent,
      formattedDescription,
    });
    context.ctxPayload.BodyForAgent = context.ctxPayload.agentText;
    context.ctxPayload.SkipStickerMediaUnderstanding = true;
  }
  await cacheSticker({
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    emoji: sticker.emoji,
    setName: sticker.setName,
    description,
    cachedAt: new Date().toISOString(),
    receivedFrom: context.ctxPayload.From,
  });
  logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
}
