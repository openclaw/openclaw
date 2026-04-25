import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { readDiscordComponentSpec, type DiscordComponentMessageSpec } from "./components.js";
import { createDiscordPayloadSendContext } from "./outbound-send-context.js";

type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type DiscordSharedInteractiveModule = typeof import("./shared-interactive.js");

let discordComponentSendPromise: Promise<DiscordComponentSendFn> | undefined;
let discordSharedInteractivePromise: Promise<DiscordSharedInteractiveModule> | undefined;

async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  discordComponentSendPromise ??= import("./send.components.js").then(
    (module) => module.sendDiscordComponentMessage,
  );
  return await (
    await discordComponentSendPromise
  )(...args);
}

function loadDiscordSharedInteractive(): Promise<DiscordSharedInteractiveModule> {
  discordSharedInteractivePromise ??= import("./shared-interactive.js");
  return discordSharedInteractivePromise;
}

function hasApprovalChannelData(payload: { channelData?: unknown }): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }
  return Boolean((channelData as { execApproval?: unknown }).execApproval);
}

function neutralizeDiscordApprovalMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

export function normalizeDiscordApprovalPayload<
  T extends {
    text?: string;
    channelData?: unknown;
  },
>(payload: T): T {
  return hasApprovalChannelData(payload) && payload.text
    ? {
        ...payload,
        text: neutralizeDiscordApprovalMentions(payload.text),
      }
    : payload;
}

export async function buildDiscordPresentationPayload(params: {
  payload: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]["payload"];
  presentation: Parameters<
    NonNullable<ChannelOutboundAdapter["renderPresentation"]>
  >[0]["presentation"];
}): Promise<typeof params.payload | null> {
  const componentSpec = (await loadDiscordSharedInteractive()).buildDiscordPresentationComponents(
    params.presentation,
  );
  if (!componentSpec) {
    return null;
  }
  return {
    ...params.payload,
    channelData: {
      ...params.payload.channelData,
      discord: {
        ...(params.payload.channelData?.discord as Record<string, unknown> | undefined),
        presentationComponents: componentSpec,
      },
    },
  };
}

function resolveDiscordComponentSpec(
  payload: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"],
): Promise<DiscordComponentMessageSpec | undefined> {
  const discordData = payload.channelData?.discord as
    | { components?: unknown; presentationComponents?: DiscordComponentMessageSpec }
    | undefined;
  const rawComponentSpec =
    discordData?.presentationComponents ?? readDiscordComponentSpec(discordData?.components);
  if (rawComponentSpec) {
    return Promise.resolve(
      rawComponentSpec.text
        ? rawComponentSpec
        : {
            ...rawComponentSpec,
            text: payload.text?.trim() ? payload.text : undefined,
          },
    );
  }
  if (!payload.interactive) {
    return Promise.resolve(undefined);
  }
  return loadDiscordSharedInteractive().then((module) => {
    const interactiveSpec = module.buildDiscordInteractiveComponents(payload.interactive);
    if (!interactiveSpec) {
      return undefined;
    }
    return interactiveSpec.text
      ? interactiveSpec
      : {
          ...interactiveSpec,
          text: payload.text?.trim() ? payload.text : undefined,
        };
  });
}

export async function sendDiscordOutboundPayload(params: {
  ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
  fallbackAdapter: ChannelOutboundAdapter;
}): Promise<Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>> {
  const ctx = params.ctx;
  const payload = normalizeDiscordApprovalPayload({
    ...ctx.payload,
    text: ctx.payload.text ?? "",
  });
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const sendContext = await createDiscordPayloadSendContext(ctx);

  if (payload.audioAsVoice && mediaUrls.length > 0) {
    let lastResult = await sendContext.withRetry(
      async () =>
        await sendContext.sendVoice(sendContext.target, mediaUrls[0], {
          cfg: ctx.cfg,
          replyTo: sendContext.resolveReplyTo(),
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
        }),
    );
    if (payload.text?.trim()) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, payload.text, {
            verbose: false,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, "", {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    }
    return attachChannelToResult("discord", lastResult);
  }

  const componentSpec = await resolveDiscordComponentSpec(payload);
  if (!componentSpec) {
    return await sendTextMediaPayload({
      channel: "discord",
      ctx: {
        ...ctx,
        payload,
      },
      adapter: params.fallbackAdapter,
    });
  }

  const result = await sendPayloadMediaSequenceOrFallback({
    text: payload.text ?? "",
    mediaUrls,
    fallbackResult: { messageId: "", channelId: sendContext.target },
    sendNoMedia: async () =>
      await sendContext.withRetry(
        async () =>
          await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      ),
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendContext.withRetry(
          async () =>
            await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              mediaUrl,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              replyTo: sendContext.resolveReplyTo(),
              accountId: ctx.accountId ?? undefined,
              silent: ctx.silent ?? undefined,
              cfg: ctx.cfg,
              ...sendContext.formatting,
            }),
        );
      }
      return await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    },
  });
  return attachChannelToResult("discord", result);
}
