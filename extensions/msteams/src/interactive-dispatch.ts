import {
  ACTION_APPROVAL_INTERACTIVE_DATA_KEY,
  type ActionApprovalDecision,
} from "openclaw/plugin-sdk/action-approval-runtime";
import {
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsInteractiveHandlerContext = {
  channel: "msteams";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderName?: string;
  threadId?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "adaptive-card";
    data: string;
    namespace: string;
    payload: string;
    activityId?: string;
    replyToId?: string;
    value?: unknown;
    actionData?: Record<string, unknown>;
    decisionHint?: ActionApprovalDecision;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: { text: string }) => Promise<void>;
    editMessage: (params: { text?: string; card?: Record<string, unknown> }) => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type MSTeamsInteractiveHandlerRegistration = PluginInteractiveRegistration<
  MSTeamsInteractiveHandlerContext,
  "msteams"
>;

export type MSTeamsInteractiveDispatchContext = Omit<
  MSTeamsInteractiveHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: {
    value?: unknown;
    actionData?: Record<string, unknown>;
    decisionHint?: ActionApprovalDecision;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInteractiveDataCandidate(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().includes(":") ? value.trim() : undefined;
}

export function extractMSTeamsAdaptiveCardInteractiveData(value: unknown): {
  data: string;
  actionData?: Record<string, unknown>;
  decisionHint?: ActionApprovalDecision;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const actionValue = isRecord(value.action) ? value.action : undefined;
  const actionData = isRecord(actionValue?.data) ? actionValue.data : undefined;
  const candidates: unknown[] = [
    value[ACTION_APPROVAL_INTERACTIVE_DATA_KEY],
    actionData?.[ACTION_APPROVAL_INTERACTIVE_DATA_KEY],
  ];
  for (const candidate of candidates) {
    const resolved = readInteractiveDataCandidate(candidate);
    if (!resolved) {
      continue;
    }
    const decisionHint =
      typeof actionData?.decision === "string" &&
      ["approve", "deny", "revise"].includes(actionData.decision.trim().toLowerCase())
        ? (actionData.decision.trim().toLowerCase() as ActionApprovalDecision)
        : undefined;
    return {
      data: resolved,
      ...(actionData ? { actionData } : {}),
      ...(decisionHint ? { decisionHint } : {}),
    };
  }
  return null;
}

export async function dispatchMSTeamsPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  ctx: MSTeamsInteractiveDispatchContext;
  turnContext: Pick<MSTeamsTurnContext, "activity" | "sendActivity" | "updateActivity">;
  onMatched?: () => Promise<void> | void;
}) {
  const activityId = params.turnContext.activity.replyToId ?? params.turnContext.activity.id;
  return await dispatchPluginInteractiveHandler<MSTeamsInteractiveHandlerRegistration>({
    channel: "msteams",
    data: params.data,
    dedupeId: params.interactionId,
    onMatched: params.onMatched,
    invoke: ({ registration, namespace, payload }) =>
      registration.handler({
        ...params.ctx,
        channel: "msteams",
        interaction: {
          kind: "adaptive-card",
          data: params.data,
          namespace,
          payload,
          activityId: params.turnContext.activity.id,
          replyToId: params.turnContext.activity.replyToId,
          value: params.ctx.interaction.value,
          actionData: params.ctx.interaction.actionData,
          decisionHint: params.ctx.interaction.decisionHint,
        },
        respond: {
          acknowledge: async () => {},
          reply: async ({ text }: { text: string }) => {
            await params.turnContext.sendActivity({
              type: "message",
              text,
            });
          },
          editMessage: async ({
            text,
            card,
          }: {
            text?: string;
            card?: Record<string, unknown>;
          }) => {
            if (!activityId) {
              return;
            }
            const activityUpdate: Record<string, unknown> = {
              id: activityId,
              type: "message",
            };
            if (typeof text === "string") {
              activityUpdate.text = text;
            }
            if (card) {
              activityUpdate.attachments = [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: card,
                },
              ];
            }
            if (!("text" in activityUpdate) && !("attachments" in activityUpdate)) {
              activityUpdate.text = "";
            }
            await params.turnContext.updateActivity(activityUpdate);
          },
        },
        ...createInteractiveConversationBindingHelpers({
          registration,
          senderId: params.ctx.senderId,
          conversation: {
            channel: "msteams",
            accountId: params.ctx.accountId,
            conversationId: params.ctx.conversationId,
            parentConversationId: params.ctx.parentConversationId,
            threadId: params.ctx.threadId,
          },
        }),
      }),
  });
}
