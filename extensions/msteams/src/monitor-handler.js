import { buildFileInfoCard, parseFileConsentInvoke, uploadToConsentUrl } from "./file-consent.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
async function handleFileConsentInvoke(context, log) {
  const expiredUploadMessage = "The file upload request has expired. Please try sending the file again.";
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }
  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug?.("invalid file consent invoke", { value: activity.value });
    return false;
  }
  const uploadId = typeof consentResponse.context?.uploadId === "string" ? consentResponse.context.uploadId : void 0;
  const pendingFile = getPendingUpload(uploadId);
  if (pendingFile) {
    const pendingConversationId = normalizeMSTeamsConversationId(pendingFile.conversationId);
    const invokeConversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    if (!invokeConversationId || pendingConversationId !== invokeConversationId) {
      log.info("file consent conversation mismatch", {
        uploadId,
        expectedConversationId: pendingConversationId,
        receivedConversationId: invokeConversationId || void 0
      });
      if (consentResponse.action === "accept") {
        await context.sendActivity(expiredUploadMessage);
      }
      return true;
    }
  }
  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    if (pendingFile) {
      log.debug?.("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length
      });
      try {
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType
        });
        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType
        });
        await context.sendActivity({
          type: "message",
          attachments: [fileInfoCard]
        });
        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId
        });
      } catch (err) {
        log.debug?.("file upload failed", { uploadId, error: String(err) });
        await context.sendActivity(`File upload failed: ${String(err)}`);
      } finally {
        removePendingUpload(uploadId);
      }
    } else {
      log.debug?.("pending file not found for consent", { uploadId });
      await context.sendActivity(expiredUploadMessage);
    }
  } else {
    log.debug?.("user declined file consent", { uploadId });
    removePendingUpload(uploadId);
  }
  return true;
}
function registerMSTeamsHandlers(handler, deps) {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context) => {
      const ctx = context;
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
        await ctx.sendActivity({ type: "invokeResponse", value: { status: 200 } });
        try {
          await withRevokedProxyFallback({
            run: async () => await handleFileConsentInvoke(ctx, deps.log),
            onRevoked: async () => true,
            onRevokedLog: () => {
              deps.log.debug?.(
                "turn context revoked during file consent invoke; skipping delayed response"
              );
            }
          });
        } catch (err) {
          deps.log.debug?.("file consent handler error", { error: String(err) });
        }
        return;
      }
      return originalRun.call(handler, context);
    };
  }
  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context);
    } catch (err) {
      deps.runtime.error?.(`msteams handler failed: ${String(err)}`);
    }
    await next();
  });
  handler.onMembersAdded(async (context, next) => {
    const membersAdded = context.activity?.membersAdded ?? [];
    for (const member of membersAdded) {
      if (member.id !== context.activity?.recipient?.id) {
        deps.log.debug?.("member added", { member: member.id });
      }
    }
    await next();
  });
  return handler;
}
export {
  registerMSTeamsHandlers
};
