import type { WhatsAppQaScenarioImplementation } from "./whatsapp-live.contracts.js";
import { waitForNoWhatsAppReply } from "./whatsapp-live.driver.js";
import { callWhatsAppGatewaySend } from "./whatsapp-live.gateway.js";
import {
  runWhatsAppOutboundMediaChecks,
  WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
  WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER,
  WHATSAPP_QA_ONE_PIXEL_PNG,
  createWhatsAppQaAudioOggOpusBuffer,
} from "./whatsapp-live.media.js";
import {
  matchesWhatsAppSutReactionToTrigger,
  requireWhatsAppTriggerMessageId,
  waitForScenarioObservedMessage,
  waitForWhatsAppQuotedMessage,
  waitForWhatsAppSutReactionToTrigger,
} from "./whatsapp-live.observations.js";
import { createWhatsAppMessageScenario } from "./whatsapp-live.scenario-builders.js";

function createWhatsAppAgentActionScenario(target: "dm" | "group", action: "react" | "upload") {
  const group = target === "group";
  return createWhatsAppMessageScenario({
    posture: "user-path",
    configOverrides: { actions: true },
    ...(group ? { requiresGroupJid: true } : {}),
    marker: `WHATSAPP_QA_${group ? "GROUP_" : ""}AGENT_${action.toUpperCase()}`,
    buildRun: (token) => ({
      expectReply: false,
      quietWindowMs: 8_000,
      target,
      ...(action === "react"
        ? {
            afterSend: async (context) => {
              const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
                expectation: { emoji: "👍" },
                timeoutMs: 60_000,
              });
              return `${group ? "group " : ""}agent message reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
            },
            allowQuietWindowMessage: (message, context) =>
              matchesWhatsAppSutReactionToTrigger(message, context, { emoji: "👍" }),
            input:
              `${group ? "openclawqa react" : "React"} to this WhatsApp ${group ? "group " : ""}message with thumbs up for QA action check ${token}. ` +
              "Do not send any visible text reply after the reaction.",
          }
        : {
            afterSend: async (context) => {
              const media = await waitForScenarioObservedMessage(context, {
                observedAfter: context.requestStartedAt,
                timeoutMs: 60_000,
                match: (message) =>
                  message.kind === "media" &&
                  message.hasMedia === true &&
                  message.mediaType?.startsWith("image/") === true &&
                  message.text.includes(token),
              });
              return `${group ? "group " : ""}agent upload-file media ${media.mediaType ?? "<unknown>"} observed`;
            },
            allowQuietWindowMessage: (message) =>
              message.kind === "media" &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(token),
            input:
              `${group ? "openclawqa use" : "Use"} the WhatsApp message tool upload-file action to send a PNG with caption ${token}. ` +
              "Do not send any visible text reply after the upload.",
          }),
    }),
  });
}

export const whatsappUserPathScenarios = {
  whatsappQaAgentMessageActionReactScenario: createWhatsAppAgentActionScenario("dm", "react"),

  whatsappQaGroupAgentMessageActionReactScenario: createWhatsAppAgentActionScenario(
    "group",
    "react",
  ),

  whatsappQaAgentMessageActionUploadFileScenario: createWhatsAppAgentActionScenario("dm", "upload"),

  whatsappQaGroupAgentMessageActionUploadFileScenario: createWhatsAppAgentActionScenario(
    "group",
    "upload",
  ),

  whatsappQaInboundReactionNoTriggerScenario: createWhatsAppMessageScenario({
    posture: "user-path",
    marker: "WHATSAPP_QA_INBOUND_REACTION",
    buildRun: (token) => ({
      afterReply: async (reply, context) => {
        if (!reply.messageId) {
          throw new Error("WhatsApp SUT reply did not include a message id to react to.");
        }
        const reactionStartedAt = new Date();
        await context.driver.sendReaction(context.target, reply.messageId, "❤️", {
          fromMe: false,
        });
        await waitForNoWhatsAppReply({
          driver: context.driver,
          observedAfter: reactionStartedAt,
          sutPhoneE164: context.sutPhoneE164,
          target: "dm",
          windowMs: 5_000,
        });
        return "driver reaction to SUT message did not trigger a fresh reply";
      },
      input: `Reply with only this exact marker before inbound reaction check: ${token}`,
    }),
  }),

  whatsappQaReplyContextIsolationScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    marker: "WHATSAPP_QA_REPLY_ISOLATION",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        requireWhatsAppTriggerMessageId(context);
        const quotedStartedAt = new Date();
        await callWhatsAppGatewaySend(context, {
          label: "quoted",
          message: `${token}_QUOTED`,
          replyToId: context.sent.messageId,
        });
        await waitForWhatsAppQuotedMessage(context, {
          observedAfter: quotedStartedAt,
          textMarker: `${token}_QUOTED`,
          quotedMessageId: context.sent.messageId,
          diagnosticLabels: ["textMarker", "quotedMessageIdMatchesTrigger"],
        });

        const freshStartedAt = new Date();
        await callWhatsAppGatewaySend(context, {
          label: "fresh",
          message: `${token}_FRESH`,
        });
        const fresh = await waitForScenarioObservedMessage(context, {
          observedAfter: freshStartedAt,
          match: (message) => message.text.includes(`${token}_FRESH`),
        });
        if (fresh.quoted?.messageId) {
          throw new Error(
            `expected fresh WhatsApp send without quote metadata, got quoted message ${fresh.quoted.messageId}`,
          );
        }
        return "quoted send and fresh send used independent reply context";
      },
      input: `Reply with only this exact marker before reply isolation checks: ${token}`,
    }),
  }),

  whatsappQaInboundImageCaptionScenario: createWhatsAppMessageScenario({
    posture: "user-path",
    marker: "WHATSAPP_QA_IMAGE",
    buildRun: (token) => ({
      input: `This image caption asks you to reply with only this exact marker: ${token}`,
      sendMode: {
        fileName: "whatsapp-qa.png",
        kind: "media",
        mediaBuffer: WHATSAPP_QA_ONE_PIXEL_PNG,
        mediaType: "image/png",
      },
    }),
  }),

  whatsappQaAudioPreflightScenario: {
    posture: "user-path",
    configOverrides: {
      audioPreflight: true,
    },
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER,
      sendMode: {
        fileName: "whatsapp-qa-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "dm",
    }),
  },

  whatsappQaOutboundMediaMatrixScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    marker: "WHATSAPP_QA_OUTBOUND_MEDIA",
    buildRun: (token) => ({
      afterReply: async (_reply, context) =>
        await runWhatsAppOutboundMediaChecks(context, token, "dm"),
      input: `Reply with only this exact marker before outbound media checks: ${token}`,
    }),
  }),
} satisfies Record<string, WhatsAppQaScenarioImplementation>;
