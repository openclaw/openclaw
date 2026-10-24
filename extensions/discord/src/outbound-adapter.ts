import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createDiscordActionGate } from "./accounts.js";
import { formatDiscordApprovalDisplayValue } from "./approval-message-safety.js";
import { resolveDiscordAttachedOutboundTarget } from "./channel.conversation.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import {
  discordInboundEventDelivery,
  notifyDiscordInboundEventOutboundPayloadSuccess,
} from "./inbound-event-delivery.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  buildDiscordPresentationPayload,
  DISCORD_PRESENTATION_CAPABILITIES,
  resolveDiscordComponentSpec,
} from "./outbound-components.js";
import { sendDiscordOutboundPayload } from "./outbound-payload.js";
import {
  createDiscordOutboundSendContext,
  loadDiscordSendRuntime,
  resolveDiscordDeliveryOptions,
} from "./outbound-send-context.js";
import { resolveDiscordReplyReference } from "./reply-reference.js";
import { canFallbackDiscordWebhookSend } from "./retry.js";
import {
  createDiscordSendReceiptFromResults,
  toDiscordOutboundDeliveryResult,
} from "./send.receipt.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;
// Shared planning owns explicit per-send limits; Discord's sender resolves account config/defaults.
const DISCORD_PRECHUNK_MAX_LINES = Number.MAX_SAFE_INTEGER;
const DISCORD_VIDEO_MEDIA_EXTENSIONS = [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"];
const log = createSubsystemLogger("discord/outbound");
const loadDiscordThreadBindings = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.js"),
);
const loadDiscordComponentSendRuntime = createLazyRuntimeModule(
  () => import("./send.components.js"),
);

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit, ctx) =>
    chunkDiscordTextWithMode(text, {
      maxChars: limit,
      maxLines: ctx?.formatting?.maxLinesPerMessage ?? DISCORD_PRECHUNK_MAX_LINES,
    }),
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  pollMaxOptions: 10,
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  presentationCapabilities: DISCORD_PRESENTATION_CAPABILITIES,
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
  renderPresentation: buildDiscordPresentationPayload,
  resolveTarget: ({ to, allowFrom }) => normalizeDiscordOutboundTarget(to, allowFrom),
  sendPayload: async (ctx) =>
    await sendDiscordOutboundPayload({
      ctx,
      fallbackAdapter: discordOutbound,
    }),
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async (ctx) => {
      // Execute Webhook cannot create native replies; use the bot message endpoint.
      if (!ctx.silent && !resolveDiscordReplyReference(ctx)) {
        try {
          const threadId = normalizeOptionalStringifiedId(ctx.threadId) ?? "";
          if (threadId) {
            const { getThreadBindingManager } = await loadDiscordThreadBindings();
            const binding = getThreadBindingManager(ctx.accountId ?? undefined)?.getByThreadId(
              threadId,
            );
            if (binding?.webhookId && binding.webhookToken) {
              const username =
                normalizeOptionalString(ctx.identity?.name) ||
                normalizeOptionalString(binding.label) ||
                binding.agentId ||
                "";
              const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
              const webhookResult = await sendWebhookMessageDiscord(ctx.text, {
                webhookId: binding.webhookId,
                webhookToken: binding.webhookToken,
                accountId: binding.accountId,
                threadId: binding.threadId,
                cfg: ctx.cfg,
                username: truncateUtf16Safe(username, 80) || undefined,
                avatarUrl: normalizeOptionalString(ctx.identity?.avatarUrl),
                tableMode: ctx.formatting?.tableMode,
                chunking: {
                  maxChars: ctx.formatting?.textLimit,
                  maxLines: ctx.formatting?.maxLinesPerMessage,
                },
                ...resolveDiscordDeliveryOptions(ctx),
              });
              if (webhookResult) {
                return toDiscordOutboundDeliveryResult(webhookResult);
              }
            }
          }
        } catch (error) {
          if (!canFallbackDiscordWebhookSend(error)) {
            throw error;
          }
          // Falling back to the plain bot send is intended (persona delivery is
          // best-effort), but the failure must stay operator-visible: a broken
          // webhook binding otherwise degrades every reply silently.
          log.warn("discord webhook persona send failed; falling back to bot send", { error });
        }
      }
      const prepared = await createDiscordOutboundSendContext(ctx);
      return toDiscordOutboundDeliveryResult(
        await prepared.send(prepared.target, ctx.text, { verbose: false, ...prepared.options() }),
      );
    },
    sendMedia: async (ctx) => {
      const prepared = await createDiscordOutboundSendContext(ctx);
      const { send, target } = prepared;
      const reply = prepared.resolveReply();
      if (ctx.audioAsVoice && ctx.mediaUrl) {
        return toDiscordOutboundDeliveryResult(
          await prepared.sendVoice(target, ctx.mediaUrl, prepared.voiceOptions(reply)),
        );
      }
      const options = { verbose: false, ...prepared.options(reply) };
      const mediaOptions = {
        verbose: false,
        ...prepared.mediaOptions(ctx.mediaUrl, reply),
      };
      const trimmed = ctx.text.trim() && ctx.mediaUrl?.trim();
      if (trimmed) {
        let path: string;
        try {
          const { pathname } = new URL(trimmed);
          path = pathname.slice(pathname.lastIndexOf("/") + 1);
          // Decode only the filename; malformed escapes in earlier path segments are irrelevant.
          try {
            path = decodeURIComponent(path);
          } catch {
            // A malformed escape leaves the original filename available for extension detection.
          }
        } catch {
          path = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
        }
        const normalized = normalizeLowercaseStringOrEmpty(path);
        if (DISCORD_VIDEO_MEDIA_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
          const captionResult = await send(target, ctx.text, options);
          // Forum sends create their thread on the first message; the video belongs in that thread.
          const mediaTarget = captionResult.receipt?.threadId
            ? `channel:${captionResult.receipt.threadId}`
            : target;
          const mediaResult = await send(mediaTarget, "", {
            ...mediaOptions,
            reply: options.reply?.scope === "all" ? options.reply : undefined,
          });
          const threadId = captionResult.receipt?.threadId;
          return toDiscordOutboundDeliveryResult({
            ...(threadId ? captionResult : mediaResult),
            receipt: createDiscordSendReceiptFromResults({
              results: [captionResult, mediaResult],
              threadId,
            }),
          });
        }
      }
      return toDiscordOutboundDeliveryResult(await send(target, ctx.text, mediaOptions));
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      content,
      accountId,
      threadId,
      silent,
      sessionKey,
      inboundEventKind,
      onPlatformSendDispatch,
      assertDirectAdapterHandoff,
    }) => {
      if (!createDiscordActionGate({ cfg, accountId })("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const outboundTo = resolveDiscordAttachedOutboundTarget({ to, threadId });
      const result = await (
        await loadDiscordSendRuntime()
      ).sendPollDiscord(outboundTo, poll, {
        accountId: accountId ?? undefined,
        content,
        threadId: threadId ?? undefined,
        silent: silent ?? undefined,
        cfg,
        onPlatformSendDispatch,
        assertPlatformSendAuthorized: assertDirectAdapterHandoff,
      });
      discordInboundEventDelivery.notify({
        sessionKey,
        inboundEventKind,
        to: outboundTo,
        accountId,
      });
      return result;
    },
  }),
  adoptTargetFromDelivery: ({ result }) => {
    const threadId = normalizeOptionalStringifiedId(result.receipt?.threadId);
    return threadId ? { threadId } : null;
  },
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    notifyDiscordInboundEventOutboundPayloadSuccess({
      payload,
      to: resolveDiscordAttachedOutboundTarget({ to: target.to, threadId: target.threadId }),
      accountId: target.accountId,
    });
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const result = results.find(
      (candidate) => candidate.channel === "discord" && candidate.messageId,
    );
    const componentSpec = questionId ? await resolveDiscordComponentSpec(payload) : undefined;
    if (questionId && result && componentSpec) {
      const to = resolveDiscordAttachedOutboundTarget({ to: target.to, threadId: target.threadId });
      const channelId = result.target?.kind === "channel" ? result.target.id : to;
      questionGatewayRuntime.registerChannelDelivery({
        questionId,
        deliveryId: `discord:${target.accountId ?? "default"}:${channelId}:${result.messageId}`,
        finalize: async (statusLine) => {
          const { editDiscordComponentMessage } = await loadDiscordComponentSendRuntime();
          await editDiscordComponentMessage(
            to,
            result.messageId,
            {
              ...componentSpec,
              blocks: [
                ...(componentSpec.blocks ?? []).filter((block) => block.type !== "actions"),
                // Same markdown-inert display escaping approvals use; raw
                // option labels must not become live Discord markup/mentions.
                { type: "text", text: `-# ${formatDiscordApprovalDisplayValue(statusLine)}` },
              ],
              modal: undefined,
            },
            { cfg, accountId: target.accountId ?? undefined },
          );
        },
      });
    }
    const threadId = normalizeOptionalStringifiedId(target.threadId);
    if (!threadId) {
      return;
    }
    const { getThreadBindingManager } = await loadDiscordThreadBindings();
    const manager = getThreadBindingManager(target.accountId ?? undefined);
    if (!manager?.getByThreadId(threadId)) {
      return;
    }
    await manager.touchThread({ threadId });
  },
};
