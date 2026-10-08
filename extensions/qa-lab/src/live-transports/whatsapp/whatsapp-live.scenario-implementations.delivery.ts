import { randomUUID } from "node:crypto";
import type {
  WhatsAppQaApprovalScenarioRun,
  WhatsAppQaScenarioImplementation,
} from "./whatsapp-live.contracts.js";
import { callWhatsAppGatewaySend } from "./whatsapp-live.gateway.js";
import {
  requireWhatsAppTriggerMessageId,
  waitForScenarioObservedMessage,
  waitForWhatsAppSutReactionSequenceToTrigger,
  waitForWhatsAppSutReactionToTrigger,
} from "./whatsapp-live.observations.js";
import { createWhatsAppMessageScenario } from "./whatsapp-live.scenario-builders.js";

function createWhatsAppApprovalScenario(
  marker: string,
  run: Omit<WhatsAppQaApprovalScenarioRun, "kind" | "token">,
): WhatsAppQaScenarioImplementation {
  return {
    posture: "native-approval",
    configOverrides: {
      approvals: { exec: true, ...(run.approvalKind === "plugin" ? { plugin: true } : {}) },
    },
    ...(run.target === "group" ? { requiresGroupJid: true } : {}),
    buildRun: () => ({
      ...run,
      kind: "approval",
      token: `WHATSAPP_QA_${marker}_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  };
}

export const whatsappDeliveryScenarios = {
  whatsappQaReplyDeliveryShapeScenario: createWhatsAppMessageScenario({
    posture: "direct-gateway",
    marker: "WHATSAPP_QA_REPLY_SHAPE",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        const quotedTriggerMessageId = requireWhatsAppTriggerMessageId(context);
        const chunkStartedAt = new Date();
        const longText = `${token}_LONG_BEGIN\n${"A".repeat(4_500)}\n${token}_LONG_END`;
        await callWhatsAppGatewaySend(context, {
          label: "long-reply",
          message: longText,
          replyToId: quotedTriggerMessageId,
        });
        const firstChunk = await waitForScenarioObservedMessage(context, {
          observedAfter: chunkStartedAt,
          diagnosticChecks: [
            {
              label: "longBeginMarker",
              match: (message) => message.text.includes(`${token}_LONG_BEGIN`),
            },
            {
              label: "quotesTrigger",
              match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
            },
          ],
          match: (message) =>
            message.text.includes(`${token}_LONG_BEGIN`) &&
            message.quoted?.messageId === quotedTriggerMessageId,
        });
        const secondChunk = await waitForScenarioObservedMessage(context, {
          observedAfter: chunkStartedAt,
          diagnosticChecks: [
            {
              label: "longEndMarker",
              match: (message) => message.text.includes(`${token}_LONG_END`),
            },
            {
              label: "quotesTrigger",
              match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
            },
          ],
          match: (message) =>
            message.messageId !== firstChunk.messageId &&
            message.text.includes(`${token}_LONG_END`) &&
            message.quoted?.messageId === quotedTriggerMessageId,
        });
        return `long reply chunked across ${firstChunk.messageId ?? "<first>"} and ${secondChunk.messageId ?? "<second>"}`;
      },
      input: `Reply with only this exact marker before reply-shape checks: ${token}`,
    }),
  }),

  whatsappQaStreamFinalMessageAccountingScenario: {
    posture: "user-path",
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      expectedJoinedSutTextIncludes: ["WHATSAPP-LONG-FINAL-BEGIN", "WHATSAPP-LONG-FINAL-END"],
      expectedSutMessageCount: 2,
      input: "WhatsApp long final QA check. Use the scripted long final response.",
      matchText: "WHATSAPP-LONG-FINAL-BEGIN",
      settleMs: 4_000,
      target: "dm",
    }),
  },

  whatsappQaApprovalExecDenyNativeScenario: createWhatsAppApprovalScenario("EXEC_DENY", {
    approvalKind: "exec",
    decision: "deny",
  }),

  whatsappQaStatusReactionsScenario: createWhatsAppMessageScenario({
    posture: "user-path",
    configOverrides: {
      statusReactions: true,
    },
    marker: "WHATSAPP_QA_STATUS_REACTION",
    buildRun: (token) => ({
      afterSend: async (context) => {
        const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
          expectation: { anyEmoji: true },
          timeoutMs: 30_000,
        });
        return `status reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
      },
      input: `Reply with only this exact marker after normal processing: ${token}`,
    }),
  }),

  whatsappQaStatusReactionLifecycleScenario: createWhatsAppMessageScenario({
    posture: "user-path",
    configOverrides: {
      statusReactions: true,
    },
    marker: "WHATSAPP_QA_STATUS_LIFECYCLE",
    buildRun: (token) => ({
      afterReply: async (_reply, context) => {
        const reactions = await waitForWhatsAppSutReactionSequenceToTrigger(context, {
          emojis: ["👀", "✅"],
          observedAfter: context.requestStartedAt,
          timeoutMs: 60_000,
        });
        for (const reaction of reactions) {
          context.recordObservedMessage(reaction);
        }
        return `status reaction lifecycle observed ${reactions
          .map((reaction) => reaction.reaction?.emoji ?? "<unknown>")
          .join(" -> ")}`;
      },
      input: `Reply with only this exact marker after normal processing: ${token}`,
    }),
  }),

  whatsappQaGroupAllowlistBlockScenario: {
    posture: "user-path",
    configOverrides: {
      blockGroupSender: true,
      groupPolicy: "allowlist",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const quietToken = `WHATSAPP_QA_GROUP_BLOCK_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: false,
        input: `openclawqa blocked group should not reply with ${quietToken}`,
        matchText: quietToken,
        target: "group",
      };
    },
  },

  whatsappQaApprovalExecNativeScenario: createWhatsAppApprovalScenario("EXEC_APPROVAL", {
    approvalKind: "exec",
    decision: "allow-once",
  }),

  whatsappQaApprovalExecReactionNativeScenario: createWhatsAppApprovalScenario(
    "EXEC_REACTION_APPROVAL",
    { approvalKind: "exec", decision: "allow-once", decisionMode: "reaction" },
  ),

  whatsappQaApprovalExecGroupReactionNativeScenario: createWhatsAppApprovalScenario(
    "GROUP_EXEC_REACTION_APPROVAL",
    { approvalKind: "exec", decision: "allow-once", decisionMode: "reaction", target: "group" },
  ),

  whatsappQaApprovalPluginNativeScenario: createWhatsAppApprovalScenario("PLUGIN_APPROVAL", {
    approvalKind: "plugin",
    decision: "allow-once",
  }),
} satisfies Record<string, WhatsAppQaScenarioImplementation>;
