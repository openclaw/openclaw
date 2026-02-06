import { prepareImageForMsgItem } from "./image-processor.js";
import { logger } from "./logger.js";

/**
 * Streaming state manager for WeCom responses.
 */

/** WeCom enforces a 20480-byte UTF-8 content limit per stream response. */
const MAX_STREAM_BYTES = 20480;

/** Truncate content to MAX_STREAM_BYTES if it exceeds the limit. */
function enforceByteLimit(content) {
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes <= MAX_STREAM_BYTES) {
    return content;
  }
  logger.warn("Stream content exceeds byte limit, truncating", { bytes: contentBytes });
  // Truncate at byte boundary, then trim any broken trailing multi-byte char.
  const buf = Buffer.from(content, "utf8").subarray(0, MAX_STREAM_BYTES);
  return buf.toString("utf8");
}

class StreamManager {
  constructor() {
    // streamId -> { content, finished, updatedAt, feedbackId, msgItem, pendingImages }
    this.streams = new Map();
    this._cleanupInterval = null;
  }

  /**
   * Start periodic cleanup lazily to avoid import-time side effects.
   */
  startCleanup() {
    if (this._cleanupInterval) {
      return;
    }
    this._cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
    // Do not keep the process alive for this timer.
    this._cleanupInterval.unref?.();
  }

  stopCleanup() {
    if (!this._cleanupInterval) {
      return;
    }
    clearInterval(this._cleanupInterval);
    this._cleanupInterval = null;
  }

  /**
   * Create a new stream session.
   * @param {string} streamId - Stream id
   * @param {object} options - Optional settings
   * @param {string} options.feedbackId - Optional feedback tracking id
   */
  createStream(streamId, options = {}) {
    this.startCleanup();
    logger.debug("Creating stream", { streamId, feedbackId: options.feedbackId });
    this.streams.set(streamId, {
      content: "",
      finished: false,
      updatedAt: Date.now(),
      feedbackId: options.feedbackId || null,
      msgItem: [],
      pendingImages: [],
    });
    return streamId;
  }

  /**
   * Update stream content (replace mode).
   * @param {string} streamId - Stream id
   * @param {string} content - Message content (max 20480 bytes in UTF-8)
   * @param {boolean} finished - Whether stream is completed
   * @param {object} options - Optional settings
   * @param {Array} options.msgItem - Mixed media list (supported when finished=true)
   */
  updateStream(streamId, content, finished = false, options = {}) {
    this.startCleanup();
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn("Stream not found for update", { streamId });
      return false;
    }

    content = enforceByteLimit(content);

    stream.content = content;
    stream.finished = finished;
    stream.updatedAt = Date.now();

    // Mixed media items are only valid for finished responses.
    if (finished && options.msgItem && options.msgItem.length > 0) {
      stream.msgItem = options.msgItem.slice(0, 10);
    }

    logger.debug("Stream updated", {
      streamId,
      contentLength: content.length,
      finished,
      hasMsgItem: stream.msgItem.length > 0,
    });

    return true;
  }

  /**
   * Append content to an existing stream.
   */
  appendStream(streamId, chunk) {
    this.startCleanup();
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn("Stream not found for append", { streamId });
      return false;
    }

    stream.content = enforceByteLimit(stream.content + chunk);
    stream.updatedAt = Date.now();

    logger.debug("Stream appended", {
      streamId,
      chunkLength: chunk.length,
      totalLength: stream.content.length,
    });

    return true;
  }

  /**
   * Replace stream content if it currently contains only the placeholder,
   * otherwise append normally.
   * @param {string} streamId - Stream id
   * @param {string} chunk - New content to write
   * @param {string} placeholder - The placeholder text to detect and replace
   * @returns {boolean} Whether the operation succeeded
   */
  replaceIfPlaceholder(streamId, chunk, placeholder) {
    this.startCleanup();
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn("Stream not found for replaceIfPlaceholder", { streamId });
      return false;
    }

    if (stream.content.trim() === placeholder.trim()) {
      stream.content = enforceByteLimit(chunk);
      stream.updatedAt = Date.now();
      logger.debug("Stream placeholder replaced", {
        streamId,
        newContentLength: stream.content.length,
      });
      return true;
    }

    // Normal append behavior.
    stream.content = enforceByteLimit(stream.content + chunk);
    stream.updatedAt = Date.now();
    logger.debug("Stream appended (no placeholder)", {
      streamId,
      chunkLength: chunk.length,
      totalLength: stream.content.length,
    });
    return true;
  }

  /**
   * Queue image for inclusion when stream finishes
   * @param {string} streamId - Stream id
   * @param {string} imagePath - Absolute image path
   * @returns {boolean} Whether enqueue succeeded
   */
  queueImage(streamId, imagePath) {
    this.startCleanup();
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn("Stream not found for queueImage", { streamId });
      return false;
    }

    stream.pendingImages.push({
      path: imagePath,
      queuedAt: Date.now(),
    });

    logger.debug("Image queued for stream", {
      streamId,
      imagePath,
      totalQueued: stream.pendingImages.length,
    });

    return true;
  }

  /**
   * Process all pending images and build msgItem array
   * @param {string} streamId - Stream id
   * @returns {Promise<Array>} msg_item entries
   */
  async processPendingImages(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.pendingImages.length === 0) {
      return [];
    }

    logger.debug("Processing pending images", {
      streamId,
      count: stream.pendingImages.length,
    });

    const msgItems = [];

    for (const img of stream.pendingImages) {
      try {
        // Limit to 10 images per WeCom API spec
        if (msgItems.length >= 10) {
          logger.warn("Stream exceeded 10 image limit, truncating", {
            streamId,
            total: stream.pendingImages.length,
            processed: msgItems.length,
          });
          break;
        }

        const processed = await prepareImageForMsgItem(img.path);
        msgItems.push({
          msgtype: "image",
          image: {
            base64: processed.base64,
            md5: processed.md5,
          },
        });

        logger.debug("Image processed successfully", {
          streamId,
          imagePath: img.path,
          format: processed.format,
          size: processed.size,
        });
      } catch (error) {
        logger.error("Failed to process image for stream", {
          streamId,
          imagePath: img.path,
          error: error.message,
        });
        // Keep going even when one image fails.
      }
    }

    logger.info("Completed processing images for stream", {
      streamId,
      processed: msgItems.length,
      pending: stream.pendingImages.length,
    });

    return msgItems;
  }

  /**
   * Mark the stream as finished and process queued images.
   */
  async finishStream(streamId) {
    this.startCleanup();
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn("Stream not found for finish", { streamId });
      return false;
    }

    if (stream.finished) {
      return true;
    }

    // Process pending images before finalizing the stream.
    if (stream.pendingImages.length > 0) {
      stream.msgItem = await this.processPendingImages(streamId);
      stream.pendingImages = [];
    }

    stream.finished = true;
    stream.updatedAt = Date.now();

    logger.info("Stream finished", {
      streamId,
      contentLength: stream.content.length,
      imageCount: stream.msgItem.length,
    });

    return true;
  }

  /**
   * Get current stream state.
   */
  getStream(streamId) {
    return this.streams.get(streamId);
  }

  /**
   * Check whether a stream exists.
   */
  hasStream(streamId) {
    return this.streams.has(streamId);
  }

  /**
   * Delete a stream.
   */
  deleteStream(streamId) {
    const deleted = this.streams.delete(streamId);
    if (deleted) {
      logger.debug("Stream deleted", { streamId });
    }
    return deleted;
  }

  /**
   * Remove streams that were inactive for over 10 minutes.
   */
  cleanup() {
    const now = Date.now();
    const timeout = 10 * 60 * 1000;
    let cleaned = 0;

    for (const [streamId, stream] of this.streams.entries()) {
      if (now - stream.updatedAt > timeout) {
        this.streams.delete(streamId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info("Cleaned up expired streams", { count: cleaned });
    }
  }

  /**
   * Get in-memory stream stats.
   */
  getStats() {
    const total = this.streams.size;
    let finished = 0;
    let active = 0;

    for (const stream of this.streams.values()) {
      if (stream.finished) {
        finished++;
      } else {
        active++;
      }
    }

    return { total, finished, active };
  }
}

// Shared singleton instance used by the plugin runtime.
export const streamManager = new StreamManager();
