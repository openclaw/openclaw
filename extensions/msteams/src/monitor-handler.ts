import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { buildFileInfoCard, parseFileConsentInvoke, uploadToConsentUrl } from "./file-consent.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};

// ---- Shared helpers for adaptive card action handling ----

const INVOKES_KEY = "__openclaw_pending_card_invokes";
const MAX_PENDING_INVOKES = 50;

type PendingCardInvoke = { actionData: unknown; timestamp: number };

/**
 * Push an adaptive card action into the global invoke queue so any interested
 * plugin (e.g. copilot-studio) can drain it.  Caps the queue size to prevent
 * unbounded growth if invokes are never consumed.
 */
function pushPendingCardInvoke(actionData: unknown): void {
  const g = globalThis as unknown as Record<string, PendingCardInvoke[] | undefined>;
  if (!g[INVOKES_KEY]) g[INVOKES_KEY] = [];
  const queue = g[INVOKES_KEY];
  // Drop oldest entries if the queue is full.
  while (queue.length >= MAX_PENDING_INVOKES) {
    queue.shift();
  }
  queue.push({ actionData, timestamp: Date.now() });
}

/**
 * Build a synthetic user message from adaptive card action data.
 * Uses a fixed message to avoid interpolating untrusted input.
 */
function buildSyntheticActionText(): string {
  return "I approved the permission request. Please proceed with the action.";
}

/**
 * Handle fileConsent/invoke activities for large file uploads.
 */
async function handleFileConsentInvoke(
  context: MSTeamsTurnContext,
  log: MSTeamsMonitorLogger,
): Promise<boolean> {
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }

  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug?.("invalid file consent invoke", { value: activity.value });
    return false;
  }

  const uploadId =
    typeof consentResponse.context?.uploadId === "string"
      ? consentResponse.context.uploadId
      : undefined;

  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    const pendingFile = getPendingUpload(uploadId);
    if (pendingFile) {
      log.debug?.("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length,
      });

      try {
        // Upload file to the provided URL
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType,
        });

        // Send confirmation card
        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType,
        });

        await context.sendActivity({
          type: "message",
          attachments: [fileInfoCard],
        });

        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId,
        });
      } catch (err) {
        log.debug?.("file upload failed", { uploadId, error: String(err) });
        await context.sendActivity(`File upload failed: ${String(err)}`);
      } finally {
        removePendingUpload(uploadId);
      }
    } else {
      log.debug?.("pending file not found for consent", { uploadId });
      await context.sendActivity(
        "The file upload request has expired. Please try sending the file again.",
      );
    }
  } else {
    // User declined
    log.debug?.("user declined file consent", { uploadId });
    removePendingUpload(uploadId);
  }

  return true;
}

/**
 * Handle adaptive card action invokes (user clicked a button on an adaptive card).
 * Stores the action data in a global queue so any plugin (e.g. copilot-studio)
 * can pick it up and continue the conversation.
 */
function handleAdaptiveCardInvoke(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): boolean {
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "adaptiveCard/action") {
    return false;
  }

  const actionData = activity.value;
  deps.log.info("adaptive card invoke received", {
    action:
      typeof actionData === "object" && actionData !== null
        ? (actionData as Record<string, unknown>).action
        : "unknown",
    from: activity.from?.id,
  });

  pushPendingCardInvoke(actionData);

  return true;
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;

      if (ctx.activity?.type === "invoke") {
        // Handle file consent invokes
        if (ctx.activity?.name === "fileConsent/invoke") {
          const handled = await handleFileConsentInvoke(ctx, deps.log);
          if (handled) {
            await ctx.sendActivity({ type: "invokeResponse", value: { status: 200 } });
            return;
          }
        }

        // Handle adaptive card action invokes (e.g. consent card button clicks)
        if (ctx.activity?.name === "adaptiveCard/action") {
          const handled = handleAdaptiveCardInvoke(ctx, deps);
          if (handled) {
            // Send 200 invoke response so Teams knows we handled it
            await ctx.sendActivity({
              type: "invokeResponse",
              value: { status: 200, body: {} },
            });
            // Route the invoke as a user message so the agent can follow up.
            const syntheticText = buildSyntheticActionText();
            // Mutate activity properties directly — same approach as onMessage.
            const savedType = ctx.activity.type;
            const savedName = ctx.activity.name;
            const savedActivityText = ctx.activity.text;
            ctx.activity.type = "message";
            ctx.activity.name = undefined;
            ctx.activity.text = syntheticText;
            try {
              await handleTeamsMessage(ctx);
            } catch (err) {
              deps.runtime.error?.(`msteams adaptive card invoke handler failed: ${String(err)}`);
            } finally {
              ctx.activity.type = savedType;
              ctx.activity.name = savedName;
              ctx.activity.text = savedActivityText;
            }
            return;
          }
        }
      }

      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      const ctx = context as MSTeamsTurnContext;
      const activity = ctx.activity;

      // Detect Action.Submit from adaptive cards: empty text + activity.value present.
      // Some cards use Action.Submit which sends a regular message with no text but
      // data in activity.value (unlike Action.Execute which sends an invoke activity).
      if (!activity.text?.trim() && activity.value != null && typeof activity.value === "object") {
        deps.log.info("adaptive card Action.Submit received", {
          from: activity.from?.id,
          valueKeys: Object.keys(activity.value as Record<string, unknown>),
        });

        pushPendingCardInvoke(activity.value);

        const syntheticText = buildSyntheticActionText();

        // Mutate activity.text directly on the original context. We can't
        // replace ctx.activity (getter-only) and Proxy approaches break SDK
        // internals (getConversationReference). But activity.text is a plain
        // data property we can safely mutate and restore.
        const savedText = activity.text;
        activity.text = syntheticText;
        try {
          await handleTeamsMessage(ctx);
        } finally {
          activity.text = savedText;
        }
      } else {
        await handleTeamsMessage(ctx);
      }
    } catch (err) {
      deps.runtime.error?.(`msteams handler failed: ${String(err)}`);
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const activity = ctx.activity;
    const membersAdded = activity?.membersAdded ?? [];
    for (const member of membersAdded) {
      if (member.id !== activity?.recipient?.id) {
        deps.log.debug?.("member added", { member: member.id });
        // Don't send welcome message - let the user initiate conversation.
      }
    }

    // Save the conversation reference on install so proactive messaging
    // (e.g. cron announcements) works even before the user sends their
    // first message.
    const conversation = activity?.conversation;
    const from = activity?.from;
    const agent = activity?.recipient;
    if (conversation?.id && from?.id && agent?.id) {
      const conversationId = normalizeMSTeamsConversationId(conversation.id);
      deps.conversationStore
        .upsert(conversationId, {
          activityId: activity.id,
          user: { id: from.id, name: from.name, aadObjectId: from.aadObjectId },
          agent,
          bot: { id: agent.id, name: agent.name },
          conversation: {
            id: conversationId,
            conversationType: conversation.conversationType,
            tenantId: conversation.tenantId,
          },
          channelId: activity.channelId,
          serviceUrl: activity.serviceUrl,
          locale: activity.locale,
        })
        .catch((err) => {
          deps.log.debug?.("failed to save install conversation reference", {
            error: String(err),
          });
        });
      deps.log.debug?.("saved conversation reference on install", { conversationId });
    }

    await next();
  });

  return handler;
}
