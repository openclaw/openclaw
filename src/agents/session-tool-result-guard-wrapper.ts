import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

/**
 * Strip base64 image data from tool result content to reduce context bloat.
 * Browser screenshots are saved to disk and referenced via MEDIA: paths.
 * The model sees the full image in the immediate API response, but we don't
 * need to persist 1.2MB base64 blobs in the conversation history forever.
 */
function stripBase64ImagesFromToolResult(message: AgentMessage): AgentMessage {
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;

  if (toolResult.role !== "toolResult" || !toolResult.content) {
    return message;
  }

  if (!Array.isArray(toolResult.content)) {
    return message;
  }

  const strippedContent = toolResult.content.map((item) => {
    if (typeof item === "object" && item !== null && "type" in item && item.type === "image") {
      // Keep the image type marker and MEDIA path (from text content), but strip base64 data
      return {
        type: "image" as const,
        data: "", // Empty string instead of multi-MB base64
        mimeType: item.mimeType || "image/png",
      };
    }
    return item;
  });

  return {
    ...toolResult,
    content: strippedContent,
  };
}

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
    ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        return hookRunner.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
    : undefined;

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  // Compose the plugin hook (if exists) with base64 stripping
  const transformToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ): AgentMessage => {
    let transformed = message;

    // First apply plugin hooks if registered
    if (transform) {
      transformed = transform(message, meta);
    }

    // Then strip base64 images
    return stripBase64ImagesFromToolResult(transformed);
  };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transformToolResult,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
