import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WhatsAppQaScenarioImplementation } from "./whatsapp-live.contracts.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  callWhatsAppGatewaySendConcurrently,
  writeWhatsAppQaWorkspaceFixture,
} from "./whatsapp-live.gateway.js";
import {
  sendWhatsAppQaMediaAndObserve,
  runWhatsAppOutboundMediaChecks,
  WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
  WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER,
  WHATSAPP_QA_ONE_PIXEL_PNG,
  createWhatsAppQaAudioOggOpusBuffer,
  createWhatsAppQaPdfBuffer,
  runWhatsAppStructuredInboundChecks,
} from "./whatsapp-live.media.js";
import {
  requireWhatsAppTriggerMessageId,
  waitForScenarioObservedMessage,
  waitForWhatsAppSutReactionToTrigger,
} from "./whatsapp-live.observations.js";
import { createWhatsAppMessageScenario } from "./whatsapp-live.scenario-builders.js";

function createWhatsAppOutboundPollScenario(
  target: "dm" | "group",
): WhatsAppQaScenarioImplementation {
  const group = target === "group";
  return createWhatsAppMessageScenario({
    posture: "direct-gateway",
    ...(group ? { requiresGroupJid: true } : {}),
    marker: `WHATSAPP_QA_${group ? "GROUP_" : ""}OUTBOUND_POLL`,
    buildRun: (token) => {
      const question = `${token} choose one`;
      return {
        afterReply: async (_reply, context) => {
          const pollStartedAt = new Date();
          await callWhatsAppGatewayPoll(context, {
            label: group ? "group-poll" : "poll",
            options: ["alpha", "beta"],
            question,
          });
          const poll = await waitForScenarioObservedMessage(context, {
            observedAfter: pollStartedAt,
            match: (message) =>
              message.kind === "poll" &&
              message.poll?.question === question &&
              message.poll.options.includes("alpha") &&
              message.poll.options.includes("beta"),
          });
          return `${group ? "group " : ""}poll observed with ${poll.poll?.options.length ?? 0} options`;
        },
        input: `${group ? "openclawqa reply" : "Reply"} with only this exact marker before ${group ? "group " : ""}outbound poll check: ${token}`,
        target,
      };
    },
  });
}

export const whatsappCapabilityScenarios = {
  whatsappQaOutboundDocumentPreservesFilenameScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    marker: "WHATSAPP_QA_DOCUMENT_FILE",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
          buffer: createWhatsAppQaPdfBuffer(),
          fileName: `whatsapp-qa-report-${token}.pdf`,
        });
        const documentStartedAt = new Date();
        await callWhatsAppGatewaySend(context, {
          forceDocument: true,
          label: "document-filename",
          mediaUrl: documentPath,
          message: `${token}_CAPTION`,
        });
        const document = await waitForScenarioObservedMessage(context, {
          observedAfter: documentStartedAt,
          match: (message) =>
            message.kind === "media" &&
            message.hasMedia === true &&
            message.text.includes(`${token}_CAPTION`) &&
            message.mediaFileName === `whatsapp-qa-report-${token}.pdf`,
        });
        return `document ${document.mediaFileName ?? "<missing filename>"} preserved`;
      },
      input: `Reply with only this exact marker before document filename check: ${token}`,
    }),
  }),

  whatsappQaOutboundSendSerializationScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    marker: "WHATSAPP_QA_SERIAL_SEND",
    buildRun: (token) => {
      const markers = Array.from({ length: 5 }, (_, index) => `${token}_${index + 1}`);
      return {
        afterReply: async (_reply, context) => {
          const sendsStartedAt = new Date();
          await callWhatsAppGatewaySendConcurrently(
            context,
            markers.map((marker, index) => ({
              label: `parallel-${index + 1}`,
              message: marker,
            })),
          );
          await Promise.all(
            markers.map((marker) =>
              waitForScenarioObservedMessage(context, {
                observedAfter: sendsStartedAt,
                match: (message) => message.kind === "text" && message.text.includes(marker),
              }),
            ),
          );
          return `gateway parallel send delivered ${markers.length}/${markers.length} messages`;
        },
        input: `Reply with only this exact marker before parallel send checks: ${token}`,
      };
    },
  }),

  whatsappQaOutboundPollScenario: createWhatsAppOutboundPollScenario("dm"),

  whatsappQaGroupOutboundMediaScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    requiresGroupJid: true,
    marker: "WHATSAPP_QA_GROUP_OUTBOUND_MEDIA",
    buildRun: (token) => ({
      afterReply: async (_reply, context) =>
        await runWhatsAppOutboundMediaChecks(context, token, "group"),
      input: `openclawqa reply with only this exact marker before group outbound media checks: ${token}`,
      target: "group",
    }),
  }),

  whatsappQaGroupOutboundAudioScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    requiresGroupJid: true,
    marker: "WHATSAPP_QA_GROUP_OUTBOUND_AUDIO",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        const audioPath = await writeWhatsAppQaWorkspaceFixture(context, {
          buffer: createWhatsAppQaAudioOggOpusBuffer({ variant: "group-trigger" }),
          fileName: `whatsapp-qa-group-audio-${token}.ogg`,
        });
        await sendWhatsAppQaMediaAndObserve(context, {
          kind: "audio",
          label: "group-audio",
          mediaUrl: audioPath,
          message: `${token}_AUDIO`,
        });
        return "gateway send delivered audio media to the group";
      },
      input: `openclawqa reply with only this exact marker before group outbound audio check: ${token}`,
      target: "group",
    }),
  }),

  whatsappQaGroupOutboundPollScenario: createWhatsAppOutboundPollScenario("group"),

  whatsappQaMessageActionsScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    configOverrides: {
      actions: true,
    },
    marker: "WHATSAPP_QA_ACTIONS",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        const triggerMessageId = requireWhatsAppTriggerMessageId(context);
        const reactionStartedAt = new Date();
        await callWhatsAppGatewayMessageAction(context, {
          action: "react",
          label: "react",
          params: {
            emoji: "👍",
            messageId: triggerMessageId,
          },
        });
        await waitForWhatsAppSutReactionToTrigger(context, {
          expectation: { emoji: "👍" },
          observedAfter: reactionStartedAt,
        });

        const uploadStartedAt = new Date();
        await callWhatsAppGatewayMessageAction(context, {
          action: "upload-file",
          label: "upload-file",
          params: {
            buffer: WHATSAPP_QA_ONE_PIXEL_PNG.toString("base64"),
            caption: `${token}_UPLOAD`,
            contentType: "image/png",
            filename: "whatsapp-qa-upload.png",
          },
        });
        await waitForScenarioObservedMessage(context, {
          observedAfter: uploadStartedAt,
          match: (message) =>
            message.kind === "media" &&
            message.mediaType?.startsWith("image/") === true &&
            message.text.includes(`${token}_UPLOAD`),
        });
        return "message.action react and upload-file observed";
      },
      input: `Reply with only this exact marker before action checks: ${token}`,
    }),
  }),

  whatsappQaInboundStructuredMessagesScenario: createWhatsAppMessageScenario({
    posture: "user-path",
    marker: "WHATSAPP_QA_STRUCTURED",
    buildRun: (token) => {
      const locationToken = `${token}_LOCATION`;
      const contactToken = `${token}_CONTACT`;
      const stickerToken = `${token}_STICKER`;
      const locationCoordinateText = "37.774900, -122.419400";
      return {
        afterReply: async (_reply, context) => {
          const waitForStructuredReply = async (
            label: string,
            observedAfter: Date,
            expectedToken: string,
          ) => {
            try {
              return await waitForScenarioObservedMessage(context, {
                observedAfter,
                timeoutMs: 60_000,
                match: (message) => message.text.includes(expectedToken),
                diagnosticChecks: [
                  {
                    label: "containsExpectedToken",
                    match: (message) => message.text.includes(expectedToken),
                  },
                ],
              });
            } catch (error) {
              throw new Error(
                `timed out waiting for WhatsApp structured ${label} reply (${expectedToken}): ${formatErrorMessage(error)}`,
                { cause: error },
              );
            }
          };

          await runWhatsAppStructuredInboundChecks({
            contactToken,
            documentToken: `${token}_DOCUMENT`,
            driver: context.driver,
            driverPhoneE164: context.driverPhoneE164,
            locationToken,
            stickerToken,
            target: context.target,
            waitForStructuredReply,
          });
          return "document, location, contact, and sticker elicited replies";
        },
        input:
          `When a later WhatsApp location message shows ${locationCoordinateText}, ` +
          `reply with only this WhatsApp location marker: ${locationToken}. ` +
          `When a later WhatsApp contact message appears, ` +
          `reply with only this WhatsApp contact marker: ${contactToken}. ` +
          `When a later WhatsApp sticker message appears, ` +
          `reply with only this WhatsApp sticker marker: ${stickerToken}. ` +
          `Reply with only this exact marker before structured inbound checks: ${token}`,
      };
    },
  }),

  whatsappQaGroupAudioGatingScenario: {
    posture: "user-path",
    configOverrides: {
      audioPreflight: true,
    },
    requiresGroupJid: true,
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER,
      quietInput: "",
      quietSendMode: {
        fileName: "whatsapp-qa-group-audio-quiet.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      quietWindowMs: 5_000,
      sendMode: {
        fileName: "whatsapp-qa-group-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer({
          variant: "group-trigger",
        }),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "group",
    }),
  },
} satisfies Record<string, WhatsAppQaScenarioImplementation>;
