import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { THINKING_PLACEHOLDER } from "./constants.js";
import {
  activeStreamHistory,
  activeStreams,
  lastStreamByKey,
  messageBuffers,
} from "./state.js";

export function getMessageStreamKey(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const prefix = message.accountId ? `${message.accountId}:` : "";
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  if (chatType === "group" && chatId) {
    return `${prefix}${chatId}`;
  }
  return `${prefix}${message.fromUser || ""}`;
}

export function registerActiveStream(streamKey, streamId) {
  if (!streamKey || !streamId) {
    return;
  }

  const history = activeStreamHistory.get(streamKey) ?? [];
  const deduped = history.filter((id) => id !== streamId);
  deduped.push(streamId);
  activeStreamHistory.set(streamKey, deduped);
  activeStreams.set(streamKey, streamId);
  lastStreamByKey.set(streamKey, streamId);
}

export function unregisterActiveStream(streamKey, streamId) {
  if (!streamKey || !streamId) {
    return;
  }

  const history = activeStreamHistory.get(streamKey);
  if (!history || history.length === 0) {
    if (activeStreams.get(streamKey) === streamId) {
      activeStreams.delete(streamKey);
    }
    return;
  }

  const remaining = history.filter((id) => id !== streamId);
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
    return;
  }

  activeStreamHistory.set(streamKey, remaining);
  activeStreams.set(streamKey, remaining[remaining.length - 1]);
}

export function resolveActiveStream(streamKey) {
  if (!streamKey) {
    return null;
  }

  const history = activeStreamHistory.get(streamKey);
  if (!history || history.length === 0) {
    activeStreams.delete(streamKey);
    return null;
  }

  const remaining = history.filter((id) => streamManager.hasStream(id));
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
    return null;
  }

  activeStreamHistory.set(streamKey, remaining);
  const latest = remaining[remaining.length - 1];
  activeStreams.set(streamKey, latest);
  lastStreamByKey.set(streamKey, latest);
  return latest;
}

/**
 * Resolve a usable stream id for a sender/group.
 * Prefer active history; if that is temporarily empty, fall back to the latest
 * known stream id for the same key (when it still exists).
 */
export function resolveRecoverableStream(streamKey) {
  const activeId = resolveActiveStream(streamKey);
  if (activeId) {
    return activeId;
  }
  if (!streamKey) {
    return null;
  }
  const recentId = lastStreamByKey.get(streamKey);
  if (!recentId) {
    return null;
  }
  if (!streamManager.hasStream(recentId)) {
    return null;
  }
  return recentId;
}

export function clearBufferedMessagesForStream(streamKey, reason) {
  const buffer = messageBuffers.get(streamKey);
  if (!buffer) {
    return 0;
  }

  messageBuffers.delete(streamKey);
  clearTimeout(buffer.timer);

  const notice = reason || "消息已被高优先级指令中断。";
  let drained = 0;
  for (const bufferedStreamId of buffer.streamIds || []) {
    if (!bufferedStreamId) {
      continue;
    }
    drained += 1;
    streamManager.replaceIfPlaceholder(
      bufferedStreamId,
      notice,
      THINKING_PLACEHOLDER,
    );
    streamManager
      .finishStream(bufferedStreamId)
      .then(() => {
        unregisterActiveStream(streamKey, bufferedStreamId);
      })
      .catch((err) => {
        logger.warn("WeCom: failed finishing buffered stream", {
          streamKey,
          streamId: bufferedStreamId,
          error: err?.message || String(err),
        });
      });
  }

  return drained;
}

/**
 * Handle stream error: replace placeholder with error message, finish stream, unregister.
 */
export async function handleStreamError(streamId, streamKey, errorMessage) {
  if (!streamId) {
    return;
  }
  const stream = streamManager.getStream(streamId);
  if (stream && !stream.finished) {
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(
        streamId,
        errorMessage,
        THINKING_PLACEHOLDER,
      );
    }
    await streamManager.finishStream(streamId);
  }
  unregisterActiveStream(streamKey, streamId);
}
