import { emitSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { isSensitiveImageRejectionError } from "../../embedded-agent-helpers/image-rejection-error.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";

export const IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE = "openclaw:image-rejection-recovery";

export const IMAGE_REJECTION_PLACEHOLDER =
  "[image data removed after the provider rejected a recent image as sensitive; " +
  "the original image is no longer included in prompt history]";

export const IMAGE_REJECTION_RECOVERY_MESSAGE =
  "System recovery: the previous model request failed because the provider rejected a recent " +
  "image block as sensitive. OpenClaw removed that image data from this session's prompt " +
  "history and kept the surrounding text context. Continue from the remaining text context; " +
  "do not assume the removed image is still visible.";

function replaceImageBlocksInMessage(message: AgentMessage): {
  message: AgentMessage;
  replacedImages: number;
} {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { message, replacedImages: 0 };
  }

  let replacedImages = 0;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    if ((block as { type?: unknown }).type !== "image") {
      return block;
    }
    replacedImages += 1;
    return { type: "text", text: IMAGE_REJECTION_PLACEHOLDER };
  }) as typeof content;

  if (replacedImages === 0) {
    return { message, replacedImages: 0 };
  }

  return {
    message: { ...message, content: nextContent } as AgentMessage,
    replacedImages,
  };
}

export function buildRecentImageRejectionRecoveryReplacements(params: {
  sessionManager: Pick<SessionManager, "getBranch">;
  maxMessagesToScan?: number;
}): { replacements: Array<{ entryId: string; message: AgentMessage }>; imageBlocks: number } {
  const branch = params.sessionManager.getBranch();
  const maxMessagesToScan = Math.max(1, params.maxMessagesToScan ?? 12);
  let scannedMessages = 0;

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") {
      continue;
    }
    scannedMessages += 1;
    const role = (entry.message as { role?: unknown }).role;
    if (role !== "toolResult" && role !== "user") {
      if (scannedMessages >= maxMessagesToScan) {
        break;
      }
      continue;
    }
    const replacement = replaceImageBlocksInMessage(entry.message);
    if (replacement.replacedImages > 0) {
      return {
        replacements: [{ entryId: entry.id, message: replacement.message }],
        imageBlocks: replacement.replacedImages,
      };
    }
    if (scannedMessages >= maxMessagesToScan) {
      break;
    }
  }

  return { replacements: [], imageBlocks: 0 };
}

export function recoverRecentSensitiveImageRejection(params: {
  sessionManager: SessionManager;
  rawError: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
}): { recovered: boolean; imageBlocks: number; rewrittenEntries: number; reason?: string } {
  if (!isSensitiveImageRejectionError(params.rawError)) {
    return {
      recovered: false,
      imageBlocks: 0,
      rewrittenEntries: 0,
      reason: "not sensitive image rejection",
    };
  }

  const plan = buildRecentImageRejectionRecoveryReplacements({
    sessionManager: params.sessionManager,
  });
  if (plan.replacements.length === 0) {
    return {
      recovered: false,
      imageBlocks: 0,
      rewrittenEntries: 0,
      reason: "no recent image block",
    };
  }

  const rewrite = rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements: plan.replacements,
  });
  if (!rewrite.changed) {
    return {
      recovered: false,
      imageBlocks: 0,
      rewrittenEntries: 0,
      reason: rewrite.reason ?? "rewrite did not change transcript",
    };
  }

  params.sessionManager.appendCustomMessageEntry(
    IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE,
    IMAGE_REJECTION_RECOVERY_MESSAGE,
    true,
    {
      runId: params.runId,
      sessionId: params.sessionId,
      imageBlocks: plan.imageBlocks,
      rewrittenEntries: rewrite.rewrittenEntries,
      errorClass: "sensitive_image_rejection",
    },
  );

  if (params.sessionFile) {
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  }

  log.warn(
    `[image-rejection-recovery] Removed ${plan.imageBlocks} image block(s) from recent ` +
      `session history after provider sensitive-image rejection ` +
      `runId=${params.runId ?? "unknown"} sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );

  return {
    recovered: true,
    imageBlocks: plan.imageBlocks,
    rewrittenEntries: rewrite.rewrittenEntries,
  };
}
