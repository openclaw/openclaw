import { readFile, access, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { agentSendText, agentUploadMedia, agentSendMedia } from "./agent-api.js";
import { THINKING_PLACEHOLDER } from "./constants.js";
import { parseResponseUrlResult } from "./response-url.js";
import { resolveAgentConfig, responseUrls, streamContext } from "./state.js";
import { resolveActiveStream } from "./stream-utils.js";
import { resolveAgentWorkspaceDirLocal } from "./workspace-template.js";

// WeCom upload API rejects files smaller than 5 bytes (error 40006).
const WECOM_MIN_FILE_SIZE = 5;

/**
 * Resolve sandbox /workspace/… paths to the host-side equivalent.
 * Inside the sandbox container, /workspace is mounted from
 * ~/.openclaw/workspace-{agentId} on the host.  Any path starting with
 * /workspace/ is transparently rewritten when an agentId is available.
 */
function resolveHostPath(filePath, effectiveAgentId) {
  if (effectiveAgentId && filePath.startsWith("/workspace/")) {
    const relative = filePath.slice("/workspace/".length);
    const hostPath = join(resolveAgentWorkspaceDirLocal(effectiveAgentId), relative);
    logger.debug("Resolved sandbox path to host path", {
      sandbox: filePath,
      host: hostPath,
    });
    return hostPath;
  }
  return filePath;
}

/** Allowed base directories for local file access. */
const ALLOWED_LOCAL_PREFIXES = ["/tmp/", "/var/tmp/"];

function isAllowedLocalPath(absPath, effectiveAgentId) {
  // Always allow workspace-scoped paths.
  if (effectiveAgentId) {
    const wsDir = resolveAgentWorkspaceDirLocal(effectiveAgentId);
    if (wsDir && absPath.startsWith(wsDir)) return true;
  }
  // Allow well-known temp directories.
  for (const prefix of ALLOWED_LOCAL_PREFIXES) {
    if (absPath.startsWith(prefix)) return true;
  }
  // Allow ~/.openclaw/ paths (media uploads, workspace dirs).
  const homeDir = process.env.HOME || "";
  if (homeDir && absPath.startsWith(join(homeDir, ".openclaw/"))) return true;
  return false;
}

function isAllowedRemoteUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Upload a local file and send via Agent DM.
 * If the file is smaller than WECOM_MIN_FILE_SIZE (WeCom rejects tiny files),
 * read the content and send as a text message instead.
 * Returns a user-facing hint string.
 */
async function uploadAndSendFile({ hostPath, filename, agent, senderId, streamId }) {
  const fileBuf = await readFile(hostPath);
  if (fileBuf.length < WECOM_MIN_FILE_SIZE) {
    // File too small for WeCom upload — send content inline as text.
    const content = fileBuf.toString("utf-8");
    await agentSendText({
      agent,
      toUser: senderId,
      text: `📄 ${filename}:\n${content}`,
    });
    logger.info("Sent tiny file as text via Agent DM", {
      streamId,
      filename,
      size: fileBuf.length,
    });
    return `📎 文件「${filename}」内容已通过私信发送给您`;
  }

  const uploadedId = await agentUploadMedia({
    agent,
    type: "file",
    buffer: fileBuf,
    filename,
  });
  await agentSendMedia({
    agent,
    toUser: senderId,
    mediaId: uploadedId,
    mediaType: "file",
  });
  logger.info("Sent file via Agent DM", {
    streamId,
    filename,
    size: fileBuf.length,
  });
  return `📎 文件「${filename}」已通过私信发送给您`;
}

export async function deliverWecomReply({ payload, senderId, streamId, agentId, responseKey }) {
  const text = payload.text || "";
  // responseKey is used for stream/response_url lookup:
  // - DM: senderId
  // - Group: chatId
  const deliveryKey = responseKey || senderId;
  // Resolve effective agentId from parameter or async context.
  const effectiveAgentId = agentId || streamContext.getStore()?.agentId;

  logger.debug("deliverWecomReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
    deliveryKey,
    agentId: effectiveAgentId,
  });

  // Handle absolute-path MEDIA lines manually; OpenClaw rejects these paths upstream.
  // Match both line-start (^MEDIA:) and inline (…MEDIA:) patterns.
  const mediaRegex = /(?:^|(?<=\s))MEDIA:\s*(.+?)$/gm;
  const mediaMatches = [];
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const mediaPath = match[1].trim();
    // Only intercept absolute filesystem paths.
    if (mediaPath.startsWith("/")) {
      mediaMatches.push({
        fullMatch: match[0],
        path: mediaPath,
      });
      logger.debug("Detected absolute path MEDIA line", {
        streamId,
        mediaPath,
        line: match[0],
      });
    }
  }

  // Queue absolute-path images; send non-image files via Agent DM.
  const mediaImageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp"]);
  let processedText = text;
  if (mediaMatches.length > 0 && streamId) {
    for (const media of mediaMatches) {
      // Resolve /workspace/ sandbox paths to host-side paths.
      const resolvedMediaPath = resolveHostPath(media.path, effectiveAgentId);
      if (!isAllowedLocalPath(resolvedMediaPath, effectiveAgentId)) {
        logger.warn("MEDIA line blocked: path outside allowed directories", {
          streamId,
          path: resolvedMediaPath,
        });
        processedText = processedText.replace(media.fullMatch, "⚠️ 文件路径不允许访问").trim();
        continue;
      }
      const mediaExt = resolvedMediaPath.split(".").pop()?.toLowerCase() || "";
      if (mediaImageExts.has(mediaExt)) {
        // Image: queue for delivery when stream finishes.
        const queued = streamManager.queueImage(streamId, resolvedMediaPath);
        if (queued) {
          processedText = processedText.replace(media.fullMatch, "").trim();
          logger.info("Queued absolute path image for stream", {
            streamId,
            imagePath: resolvedMediaPath,
          });
        }
      } else {
        // Non-image file: WeCom Bot stream API does not support files.
        // Send via Agent DM and replace the MEDIA line with a hint.
        const mediaFilename = basename(resolvedMediaPath);
        const agentCfgMedia = resolveAgentConfig();
        if (agentCfgMedia && senderId) {
          try {
            const hint = await uploadAndSendFile({
              hostPath: resolvedMediaPath,
              filename: mediaFilename,
              agent: agentCfgMedia,
              senderId,
              streamId,
            });
            processedText = processedText.replace(media.fullMatch, hint).trim();
            logger.info("Sent non-image file via Agent DM (MEDIA line)", {
              streamId,
              filename: mediaFilename,
              senderId,
            });
          } catch (mediaErr) {
            processedText = processedText
              .replace(media.fullMatch, `⚠️ 文件发送失败（${mediaFilename}）：${mediaErr.message}`)
              .trim();
            logger.error("Failed to send non-image file via Agent DM (MEDIA line)", {
              streamId,
              filename: mediaFilename,
              error: mediaErr.message,
            });
          }
        } else {
          // No agent configured or no sender — just strip the MEDIA line.
          processedText = processedText
            .replace(media.fullMatch, `⚠️ 无法发送文件 ${mediaFilename}（未配置 Agent API）`)
            .trim();
        }
      }
    }
  }

  // Handle payload.mediaUrl / payload.mediaUrls from OpenClaw core dispatcher.
  // These are local file paths or remote URLs that the LLM wants to deliver as media.
  const payloadMediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
  if (payloadMediaUrls.length > 0) {
    const payloadImageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
    for (const mediaPath of payloadMediaUrls) {
      // Normalize sandbox: prefix
      let absPath = mediaPath;
      if (absPath.startsWith("sandbox:")) {
        absPath = absPath.replace(/^sandbox:\/{0,2}/, "");
        if (!absPath.startsWith("/")) absPath = "/" + absPath;
      }
      // Resolve /workspace/ sandbox paths to host-side paths.
      absPath = resolveHostPath(absPath, effectiveAgentId);

      const isLocal = absPath.startsWith("/");

      // Validate path/URL before accessing.
      if (isLocal && !isAllowedLocalPath(absPath, effectiveAgentId)) {
        logger.warn("Payload media blocked: path outside allowed directories", {
          streamId,
          path: absPath,
        });
        continue;
      }
      if (!isLocal && !isAllowedRemoteUrl(mediaPath)) {
        logger.warn("Payload media blocked: invalid remote URL", {
          streamId,
          url: mediaPath.substring(0, 80),
        });
        continue;
      }

      const mediaFilename = isLocal
        ? basename(absPath)
        : basename(new URL(mediaPath).pathname) || "file";
      const ext = mediaFilename.split(".").pop()?.toLowerCase() || "";

      if (isLocal && payloadImageExts.has(ext) && streamId) {
        // Image: queue for delivery via stream msg_item when stream finishes.
        const queued = streamManager.queueImage(streamId, absPath);
        if (queued) {
          logger.info("Queued payload image for stream", {
            streamId,
            imagePath: absPath,
          });
        }
      } else {
        // Non-image file (or image without active stream): send via Agent DM.
        const agentCfgPayload = resolveAgentConfig();
        if (agentCfgPayload && senderId) {
          try {
            let fileBuf;
            if (isLocal) {
              fileBuf = await readFile(absPath);
            } else {
              const res = await fetch(mediaPath, {
                signal: AbortSignal.timeout(30_000),
              });
              if (!res.ok) throw new Error(`download failed: ${res.status}`);
              fileBuf = Buffer.from(await res.arrayBuffer());
            }

            // Determine upload type based on content type
            let uploadType = "file";
            if (payloadImageExts.has(ext)) uploadType = "image";

            // Check minimum file size for WeCom upload.
            if (fileBuf.length < WECOM_MIN_FILE_SIZE) {
              const content = fileBuf.toString("utf-8");
              await agentSendText({
                agent: agentCfgPayload,
                toUser: senderId,
                text: `📄 ${mediaFilename}:\n${content}`,
              });
              logger.info("Sent tiny payload media as text via Agent DM", {
                streamId,
                filename: mediaFilename,
                size: fileBuf.length,
              });
            } else {
              const uploadedId = await agentUploadMedia({
                agent: agentCfgPayload,
                type: uploadType,
                buffer: fileBuf,
                filename: mediaFilename,
              });
              await agentSendMedia({
                agent: agentCfgPayload,
                toUser: senderId,
                mediaId: uploadedId,
                mediaType: uploadType,
              });
            }

            // Add hint in stream text
            const hint = `📎 文件已通过私信发送给您：${mediaFilename}`;
            if (streamId && streamManager.hasStream(streamId)) {
              streamManager.appendStream(streamId, `\n\n${hint}`);
            } else {
              processedText = processedText ? `${processedText}\n\n${hint}` : hint;
            }
            logger.info("Sent payload media via Agent DM", {
              streamId,
              filename: mediaFilename,
              senderId,
            });
          } catch (payloadMediaErr) {
            logger.error("Failed to send payload media via Agent DM", {
              streamId,
              mediaPath: mediaPath.substring(0, 80),
              error: payloadMediaErr.message,
            });
            const errHint = `⚠️ 文件发送失败（${mediaFilename}）：${payloadMediaErr.message}`;
            if (streamId && streamManager.hasStream(streamId)) {
              streamManager.appendStream(streamId, `\n\n${errHint}`);
            } else {
              processedText = processedText ? `${processedText}\n\n${errHint}` : errHint;
            }
          }
        } else {
          const noAgentHint = `⚠️ 无法发送文件 ${mediaFilename}（未配置 Agent API）`;
          if (streamId && streamManager.hasStream(streamId)) {
            streamManager.appendStream(streamId, `\n\n${noAgentHint}`);
          } else {
            processedText = processedText ? `${processedText}\n\n${noAgentHint}` : noAgentHint;
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Auto-detect /workspace/… file paths in LLM reply text.
  // The sandbox container mounts /workspace → host ~/.openclaw/workspace-{agentId}.
  // When the LLM mentions a file path like "/workspace/report.pdf", we resolve
  // the host-side path, verify the file exists, and send it via Agent DM.
  // ──────────────────────────────────────────────────────────────────────────
  if (effectiveAgentId && processedText) {
    // Match /workspace/ paths (non-greedy: stop at whitespace, quotes, backticks,
    // angle brackets, parentheses, or end of string).
    const workspacePathRegex = /\/workspace\/[^\s"'`<>()]+/g;
    const detectedPaths = [];
    let wpMatch;
    while ((wpMatch = workspacePathRegex.exec(processedText)) !== null) {
      const rawPath = wpMatch[0]
        // Strip trailing punctuation that is likely not part of the filename.
        .replace(/[.,;:!?。，；：！？）》」』\]]+$/, "");
      if (rawPath.length > "/workspace/".length) {
        detectedPaths.push(rawPath);
      }
    }

    if (detectedPaths.length > 0) {
      const workspaceDir = resolveAgentWorkspaceDirLocal(effectiveAgentId);
      const agentCfgAuto = resolveAgentConfig();
      const imageExtsAuto = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);

      for (const wsPath of detectedPaths) {
        // /workspace/foo.pdf → hostDir/foo.pdf
        const relativePath = wsPath.replace(/^\/workspace\/?/, "");
        if (!relativePath) continue;
        const hostPath = join(workspaceDir, relativePath);
        const filename = basename(hostPath);
        const ext = filename.split(".").pop()?.toLowerCase() || "";

        // Skip image files — they are handled by the stream msg_item mechanism.
        if (imageExtsAuto.has(ext)) continue;

        // Check file existence on host.
        try {
          await access(hostPath);
        } catch {
          logger.debug("Auto-detect: workspace file not found on host, skipping", {
            wsPath,
            hostPath,
          });
          continue;
        }

        // File exists on host — send via Agent DM.
        if (agentCfgAuto && senderId) {
          try {
            const hint = await uploadAndSendFile({
              hostPath,
              filename,
              agent: agentCfgAuto,
              senderId,
              streamId,
            });
            // Replace the path mention in text with a delivery hint.
            // Also strip any preceding "MEDIA:" prefix if the LLM wrote "MEDIA:/workspace/…".
            const escapedPath = wsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const withMediaPrefix = new RegExp(`MEDIA:\\s*${escapedPath}`, "g");
            const replaced = processedText.replace(withMediaPrefix, hint);
            if (replaced !== processedText) {
              processedText = replaced;
            } else {
              processedText = processedText.replace(wsPath, hint);
            }
            logger.info("Auto-detect: sent workspace file via Agent DM", {
              streamId,
              wsPath,
              hostPath,
              filename,
              senderId,
            });
          } catch (autoErr) {
            processedText = processedText.replace(
              wsPath,
              `⚠️ 文件「${filename}」发送失败：${autoErr.message}`,
            );
            logger.error("Auto-detect: failed to send workspace file via Agent DM", {
              streamId,
              wsPath,
              hostPath,
              error: autoErr.message,
            });
          }
        }
      }
    }
  }

  // All outbound content is sent via stream updates.
  if (!processedText.trim()) {
    logger.debug("WeCom: empty block after processing, skipping stream update");
    return;
  }

  // Helper: append content with duplicate suppression and placeholder awareness.
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) {
      return false;
    }

    // If stream still has the placeholder, replace it entirely.
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(targetStreamId, content, THINKING_PLACEHOLDER);
      return true;
    }

    // Skip duplicate chunks (for example, block + final overlap).
    // Only check substring containment for chunks long enough to avoid
    // false positives (short replies like "好的" matching inside longer text).
    const trimmed = content.trim();
    if (trimmed.length >= 20 && stream.content.includes(trimmed)) {
      logger.debug("WeCom: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: trimmed.substring(0, 30),
      });
      return true;
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // Try async context first, then fallback to active stream map.
    const ctx = streamContext.getStore();
    const contextStreamId = ctx?.streamId;
    const activeStreamId = contextStreamId ?? resolveActiveStream(deliveryKey);

    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, processedText);
      logger.debug("WeCom stream appended (via context/activeStreams)", {
        streamId: activeStreamId,
        source: contextStreamId ? "asyncContext" : "activeStreams",
        contentLength: processedText.length,
      });
      return;
    }
    logger.warn("WeCom: no active stream for this message", {
      senderId,
      deliveryKey,
    });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WeCom: stream not found, attempting response_url fallback", {
      streamId,
      senderId,
    });

    // Layer 2: Fallback via response_url (stream closed, but response_url may still be valid)
    const saved = responseUrls.get(deliveryKey);
    if (saved && !saved.used && Date.now() < saved.expiresAt) {
      try {
        const response = await fetch(saved.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgtype: "text",
            text: { content: processedText },
          }),
        });
        const responseBody = await response.text().catch(() => "");
        const result = parseResponseUrlResult(response, responseBody);
        if (!result.accepted) {
          logger.error("WeCom: response_url fallback rejected (deliverWecomReply)", {
            senderId,
            deliveryKey,
            status: response.status,
            statusText: response.statusText,
            errcode: result.errcode,
            errmsg: result.errmsg,
            bodyPreview: result.bodyPreview,
          });
        } else {
          saved.used = true;
          logger.info("WeCom: sent via response_url fallback (deliverWecomReply)", {
            senderId,
            deliveryKey,
            status: response.status,
            errcode: result.errcode,
            contentPreview: processedText.substring(0, 50),
          });
          return;
        }
      } catch (err) {
        logger.error("WeCom: response_url fallback failed", {
          senderId,
          deliveryKey,
          error: err.message,
        });
      }
    }

    // Layer 3: Agent API fallback (stream closed + response_url unavailable)
    const agentConfig = resolveAgentConfig();
    if (agentConfig) {
      try {
        await agentSendText({
          agent: agentConfig,
          toUser: senderId,
          text: processedText,
        });
        logger.info("WeCom: sent via Agent API fallback (deliverWecomReply)", {
          senderId,
          contentPreview: processedText.substring(0, 50),
        });
        return;
      } catch (err) {
        logger.error("WeCom: Agent API fallback failed", {
          senderId,
          error: err.message,
        });
      }
    }
    logger.warn("WeCom: unable to deliver message (all layers exhausted)", {
      senderId,
      contentPreview: processedText.substring(0, 50),
    });
    return;
  }

  appendToStream(streamId, processedText);
  logger.debug("WeCom stream appended", {
    streamId,
    contentLength: processedText.length,
    to: senderId,
  });
}
