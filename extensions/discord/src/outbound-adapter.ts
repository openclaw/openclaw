import type { OutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkDiscordTextWithMode } from "./chunk.js";
import type { DiscordComponentMessageSpec } from "./components.js";
import { withDiscordDeliveryRetry } from "./delivery-retry.js";
import { notifyDiscordInboundEventOutboundPayloadSuccess } from "./inbound-event-delivery.js";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  buildDiscordPresentationPayload,
  editDiscordComponentMessageLazy,
  resolveDiscordComponentSpec,
} from "./outbound-components.js";
import { sendDiscordOutboundPayload } from "./outbound-payload.js";
import {
  loadDiscordSendRuntime,
  resolveDiscordFormattingOptions,
  resolveDiscordOutboundTarget,
  type DiscordSendFn,
  type DiscordVoiceSendFn,
} from "./outbound-send-context.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE =
  /<\s*(system-reminder|previous_response)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE =
  /<\s*(?:system-reminder|previous_response)\b[^>]*\/\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE =
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*>/gi;
const CODEX_CONTROL_DELIVERY_RESOLVERS_KEY = Symbol.for("openclaw.codex.controlDeliveryResolvers");

type CodexControlDeliveryResolver = () => Promise<void> | void;

function getCodexControlDeliveryResolvers(): Map<string, CodexControlDeliveryResolver> {
  return resolveGlobalMap<string, CodexControlDeliveryResolver>(
    CODEX_CONTROL_DELIVERY_RESOLVERS_KEY,
  );
}

function stripDiscordInternalRuntimeScaffolding(text: string): string {
  return text
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
}

function readCodexUserInputControlToken(payload: ReplyPayload): string | undefined {
  const codexData = payload.channelData?.codex;
  if (!codexData || typeof codexData !== "object" || Array.isArray(codexData)) {
    return undefined;
  }
  const token = (codexData as { userInputControlToken?: unknown }).userInputControlToken;
  return typeof token === "string" && token.trim() ? token : undefined;
}

function disablePresentationControls(presentation: MessagePresentation): MessagePresentation {
  return {
    ...presentation,
    blocks: presentation.blocks.map((block) => {
      if (block.type === "buttons") {
        return {
          ...block,
          buttons: block.buttons.map((button) => ({ ...button, disabled: true })),
        };
      }
      if (block.type === "select") {
        return {
          ...block,
          options: block.options.map((option) => ({ ...option })),
        };
      }
      return block;
    }),
  };
}

function disableCodexUserInputControlPayload(payload: ReplyPayload): ReplyPayload {
  const discordData = payload.channelData?.discord;
  const presentationComponents =
    discordData && typeof discordData === "object" && !Array.isArray(discordData)
      ? (discordData as { presentationComponents?: DiscordComponentMessageSpec })
          .presentationComponents
      : undefined;
  if (presentationComponents) {
    return {
      ...payload,
      channelData: {
        ...payload.channelData,
        discord: {
          ...(discordData as Record<string, unknown>),
          presentationComponents: disableDiscordComponentControls(presentationComponents),
        },
      },
    };
  }
  if (payload.presentation) {
    return {
      ...payload,
      presentation: disablePresentationControls(payload.presentation),
    };
  }
  return payload;
}

function disableDiscordComponentControls(
  spec: DiscordComponentMessageSpec,
): DiscordComponentMessageSpec {
  return {
    ...spec,
    blocks: spec.blocks?.map((block) => {
      if (block.type === "actions") {
        return {
          ...block,
          buttons: block.buttons?.map((button) => ({ ...button, disabled: true })),
        };
      }
      if (block.type === "section" && block.accessory?.type === "button") {
        return {
          ...block,
          accessory: {
            ...block.accessory,
            button: { ...block.accessory.button, disabled: true },
          },
        };
      }
      return block;
    }),
  };
}

function registerCodexUserInputControlDelivery(params: {
  cfg: OpenClawConfig;
  target: { to: string; accountId?: string; threadId?: string | number | null };
  payload: ReplyPayload;
  results: readonly { messageId?: string }[];
}): void {
  const token = readCodexUserInputControlToken(params.payload);
  const messageId = params.results.find((result) => result.messageId)?.messageId;
  if (!token || !messageId) {
    return;
  }
  getCodexControlDeliveryResolvers().set(token, async () => {
    const disabledPayload = disableCodexUserInputControlPayload(params.payload);
    const renderedPayload = disabledPayload.presentation
      ? ((await buildDiscordPresentationPayload({
          payload: disabledPayload,
          presentation: disabledPayload.presentation,
        })) ?? disabledPayload)
      : disabledPayload;
    const spec = await resolveDiscordComponentSpec(renderedPayload);
    if (!spec) {
      return;
    }
    await editDiscordComponentMessageLazy(
      resolveDiscordOutboundTarget({
        to: params.target.to,
        threadId: params.target.threadId,
      }),
      messageId,
      spec,
      {
        cfg: params.cfg,
        accountId: params.target.accountId,
      },
    );
  });
}

type DiscordThreadBindingsModule = typeof import("./monitor/thread-bindings.js");

let discordThreadBindingsPromise: Promise<DiscordThreadBindingsModule> | undefined;

function loadDiscordThreadBindings(): Promise<DiscordThreadBindingsModule> {
  discordThreadBindingsPromise ??= import("./monitor/thread-bindings.js");
  return discordThreadBindingsPromise;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = normalizeOptionalString(params.identity?.name);
  const fallbackUsername = normalizeOptionalString(params.binding.label) ?? params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = normalizeOptionalString(params.identity?.avatarUrl);
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return null;
  }
  const { getThreadBindingManager } = await loadDiscordThreadBindings();
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit, ctx) =>
    chunkDiscordTextWithMode(text, {
      maxChars: limit,
      maxLines: ctx?.formatting?.maxLinesPerMessage,
    }),
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  sanitizeText: ({ text }) => stripDiscordInternalRuntimeScaffolding(text),
  pollMaxOptions: 10,
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
    limits: {
      actions: {
        maxActions: 25,
        maxActionsPerRow: 5,
        maxRows: 5,
        maxLabelLength: 80,
        supportsDisabled: true,
      },
      selects: {
        maxOptions: 25,
        maxLabelLength: 100,
        maxValueBytes: 100,
      },
      text: {
        maxLength: DISCORD_TEXT_CHUNK_LIMIT,
        encoding: "characters",
        markdownDialect: "discord-markdown",
      },
    },
  },
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      poll: true,
      payload: true,
      silent: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  renderPresentation: async ({ payload, presentation }) => {
    return await buildDiscordPresentationPayload({
      payload,
      presentation,
    });
  },
  resolveTarget: ({ to, allowFrom }) => normalizeDiscordOutboundTarget(to, allowFrom),
  sendPayload: async (ctx) =>
    await sendDiscordOutboundPayload({
      ctx,
      fallbackAdapter: discordOutbound,
    }),
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
      silent,
      formatting,
    }) => {
      if (!silent) {
        const webhookResult = await maybeSendDiscordWebhookText({
          cfg,
          text,
          threadId,
          accountId,
          identity,
          replyToId,
        }).catch(() => null);
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
      return await withDiscordDeliveryRetry({
        cfg,
        accountId,
        fn: async () =>
          await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
            verbose: false,
            replyTo: replyToId ?? undefined,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
            cfg,
            ...resolveDiscordFormattingOptions({ formatting }),
          }),
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      audioAsVoice,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
      formatting,
    }) => {
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
      const target = resolveDiscordOutboundTarget({ to, threadId });
      const formattingOptions = resolveDiscordFormattingOptions({ formatting });
      if (audioAsVoice && mediaUrl) {
        const sendVoice =
          resolveOutboundSendDep<DiscordVoiceSendFn>(deps, "discordVoice") ??
          (await loadDiscordSendRuntime()).sendVoiceMessageDiscord;
        return await withDiscordDeliveryRetry({
          cfg,
          accountId,
          fn: async () =>
            await sendVoice(target, mediaUrl, {
              cfg,
              replyTo: replyToId ?? undefined,
              accountId: accountId ?? undefined,
              silent: silent ?? undefined,
            }),
        });
      }
      if (text.trim() && mediaUrl && isLikelyDiscordVideoMedia(mediaUrl)) {
        await withDiscordDeliveryRetry({
          cfg,
          accountId,
          fn: async () =>
            await send(target, text, {
              verbose: false,
              replyTo: replyToId ?? undefined,
              accountId: accountId ?? undefined,
              silent: silent ?? undefined,
              cfg,
              ...formattingOptions,
            }),
        });
        return await withDiscordDeliveryRetry({
          cfg,
          accountId,
          fn: async () =>
            await send(target, "", {
              verbose: false,
              mediaUrl,
              mediaAccess,
              mediaLocalRoots,
              mediaReadFile,
              accountId: accountId ?? undefined,
              silent: silent ?? undefined,
              cfg,
              ...formattingOptions,
            }),
        });
      }
      return await withDiscordDeliveryRetry({
        cfg,
        accountId,
        fn: async () =>
          await send(target, text, {
            verbose: false,
            mediaUrl,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
            replyTo: replyToId ?? undefined,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
            cfg,
            ...formattingOptions,
          }),
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await withDiscordDeliveryRetry({
        cfg,
        accountId,
        fn: async () =>
          await (
            await loadDiscordSendRuntime()
          ).sendPollDiscord(resolveDiscordOutboundTarget({ to, threadId }), poll, {
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
            cfg,
          }),
      }),
  }),
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    notifyDiscordInboundEventOutboundPayloadSuccess({
      payload,
      to: resolveDiscordOutboundTarget({ to: target.to, threadId: target.threadId }),
      accountId: target.accountId,
    });
    registerCodexUserInputControlDelivery({
      cfg,
      target: {
        to: target.to,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      },
      payload,
      results,
    });
    const threadId = normalizeOptionalStringifiedId(target.threadId);
    if (!threadId) {
      return;
    }
    const { getThreadBindingManager } = await loadDiscordThreadBindings();
    const manager = getThreadBindingManager(target.accountId ?? undefined);
    if (!manager?.getByThreadId(threadId)) {
      return;
    }
    manager.touchThread({ threadId });
  },
};
