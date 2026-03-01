/**
 * SimpleX Chat WebSocket Bus
 *
 * Connects to a simplex-chat CLI instance running as a WebSocket server.
 * The CLI is started with: simplex-chat -p <port>
 *
 * Protocol: JSON-based command/response over WebSocket.
 * Commands: https://github.com/simplex-chat/simplex-chat/blob/stable/docs/CLI.md
 *
 * Inbound messages arrive as ChatResponse events.
 * Outbound messages are sent as ChatCommand strings.
 *
 * Supported message types:
 * - Direct messages (DM): @contactName message
 * - Group messages: #groupName message
 */

import fs from "fs";
import path from "path";
import WebSocket from "ws";

/** Safe display name pattern — alphanumeric, underscores, dots, hyphens only. */
const SAFE_DISPLAY_NAME = /^[\w.-]+$/;

/** File path validation: must be absolute, no path traversal */
const FILE_PATH_PATTERN = /^\/(?:[^\/\0]+)*$/;

/** Allowed image extensions */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

/** Allowed voice extensions */
const VOICE_EXTENSIONS = [".m4a", ".mp3", ".ogg", ".wav"];

/** Max reconnect delay: 5 minutes */
const MAX_RECONNECT_MS = 300_000;

/** Heartbeat interval: 30 seconds */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Connection timeout: 10 seconds */
const CONNECTION_TIMEOUT_MS = 10_000;

/** Command timeout: 30 seconds */
const COMMAND_TIMEOUT_MS = 30_000;

/** TLS relay error patterns */
const TLS_ERROR_PATTERNS = [
  /tls/i,
  /certificate/i,
  /handshake/i,
  /relay/i,
  /connection refused/i,
  /timeout/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
];

export type SimplexMessage = {
  contactId: string;
  contactName: string;
  text: string;
  messageId?: string;
  timestamp?: string;
  /** true if this is a group message */
  isGroup?: boolean;
  /** group ID for group messages */
  groupId?: string;
  /** group name for group messages */
  groupName?: string;
  /** File received (rcvFileComplete) */
  fileReceived?: {
    fileId: string;
    filePath?: string;
    fileName?: string;
    fileSize?: number;
    mediaType?: "image" | "voice" | "file";
  };
  /** Voice message (received as .m4a file) */
  isVoice?: boolean;
};

export type SimplexBusOptions = {
  wsUrl: string;
  onMessage: (msg: SimplexMessage) => Promise<void>;
  onError: (error: Error, context: string) => void;
  onConnect: () => void;
  onDisconnect: (code: number, reason: string) => void;
  /** Called when a TLS/relay error is detected (for logging/alerting) */
  onTlsError?: (error: Error) => void;
  reconnectMs?: number;
};

export type SimplexBusHandle = {
  sendMessage: (contactId: string, text: string) => Promise<void>;
  sendGroupMessage: (groupId: string, text: string) => Promise<void>;
  sendFile: (contactId: string, filePath: string) => Promise<void>;
  sendGroupFile: (groupId: string, filePath: string) => Promise<void>;
  sendImage: (contactId: string, imagePath: string) => Promise<void>;
  sendVoice: (contactId: string, audioPath: string) => Promise<void>;
  receiveFile: (fileId: string) => Promise<{ filePath: string; fileName: string } | null>;
  close: () => void;
  isConnected: () => boolean;
  getContactId: (displayName: string) => Promise<string | null>;
  getGroupId: (displayName: string) => Promise<string | null>;
};

/**
 * Check if an error message indicates a TLS/relay failure.
 */
function isTlsRelayError(message: string): boolean {
  return TLS_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Start a SimpleX WebSocket bus.
 *
 * Connects to the simplex-chat CLI WebSocket server and forwards
 * incoming DMs and group messages to the callback. Outbound messages
 * are sent via the returned handle.
 */
export function startSimplexBus(options: SimplexBusOptions): SimplexBusHandle {
  let ws: WebSocket | null = null;
  let connected = false;
  let shouldReconnect = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  const baseReconnectMs = options.reconnectMs ?? 5000;

  // Pending command responses
  const pendingCommands = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; command: string }
  >();
  let commandCounter = 0;

  function getReconnectDelay(): number {
    // Exponential backoff: base * 2^attempts, capped at MAX_RECONNECT_MS
    const delay = Math.min(baseReconnectMs * Math.pow(2, reconnectAttempts), MAX_RECONNECT_MS);
    reconnectAttempts++;
    return delay;
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
  }

  function clearPendingCommands(error: Error) {
    for (const [corrId, pending] of pendingCommands) {
      pending.reject(error);
    }
    pendingCommands.clear();
  }

  function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    heartbeatInterval = setInterval(() => {
      if (ws && connected && ws.readyState === WebSocket.OPEN) {
        // Send a ping to detect stale connections
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function handleTlsError(error: Error, context: string) {
    const message = error.message || context;
    if (isTlsRelayError(message)) {
      options.onTlsError?.(error);
      options.onError(error, `tls_relay:${context}`);
    } else {
      options.onError(error, context);
    }
  }

  function connect() {
    clearTimers();

    try {
      ws = new WebSocket(options.wsUrl);

      // Connection timeout
      connectionTimeout = setTimeout(() => {
        if (!connected) {
          const err = new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
          options.onError(err, "connection_timeout");
          ws?.terminate();
        }
      }, CONNECTION_TIMEOUT_MS);

      ws.on("open", () => {
        connected = true;
        reconnectAttempts = 0; // Reset on successful connection
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        startHeartbeat();
        options.onConnect();
      });

      ws.on("pong", () => {
        // Heartbeat response received - connection is alive
      });

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const raw = data.toString();
          handleResponse(raw);
        } catch (err) {
          options.onError(err instanceof Error ? err : new Error(String(err)), "message_parse");
        }
      });

      ws.on("close", (code, reason) => {
        connected = false;
        clearTimers();
        // Reject pending commands with connection error
        clearPendingCommands(new Error(`WebSocket closed: ${code} ${reason}`));
        options.onDisconnect(code, reason.toString());
        if (shouldReconnect) {
          const delay = getReconnectDelay();
          reconnectTimer = setTimeout(connect, delay);
        }
      });

      ws.on("error", (err) => {
        handleTlsError(err, "websocket_error");
      });
    } catch (err) {
      handleTlsError(err instanceof Error ? err : new Error(String(err)), "connect");
      // Reject pending commands
      clearPendingCommands(new Error("Failed to connect"));
      if (shouldReconnect) {
        const delay = getReconnectDelay();
        reconnectTimer = setTimeout(connect, delay);
      }
    }
  }

  function handleResponse(raw: string) {
    // SimpleX CLI outputs line-delimited responses
    // Format varies: could be JSON or plain text depending on the command
    // New message events look like: contactName> message text
    // Or in JSON mode: {"resp": {"type": "newChatItems", ...}}

    try {
      const parsed = JSON.parse(raw);

      // Check for pending command response
      if (parsed.corrId && pendingCommands.has(parsed.corrId)) {
        const pending = pendingCommands.get(parsed.corrId);
        pendingCommands.delete(parsed.corrId);
        // Reject if the response contains an error
        if (
          parsed.resp?.type === "chatCmdError" ||
          parsed.resp?.type === "chatError" ||
          parsed.resp?.chatError
        ) {
          pending?.reject(
            new Error(
              `SimpleX command error: ${JSON.stringify(parsed.resp?.chatError ?? parsed.resp)}`,
            ),
          );
        } else {
          pending?.resolve(parsed);
        }
        return;
      }

      // Handle incoming message events
      // Response types: newChatItems, chatItemUpdated, messageDelivery, messageError
      if (parsed.resp?.type === "newChatItems" || parsed.resp?.type === "chatItemUpdated") {
        const chatItems = parsed.resp?.chatItems ?? [parsed.resp?.chatItem];
        for (const item of chatItems) {
          if (!item) continue;

          const chatInfo = item.chatInfo;
          const chatItem = item.chatItem;

          // Handle direct messages (DM)
          if (chatInfo?.type === "direct") {
            const contact = chatInfo.contact;
            if (!contact) continue;

            // Only process incoming messages (not our own)
            const dir = chatItem?.chatDir;
            if (dir?.type !== "directRcv") continue;

            const content = chatItem?.content;

            const senderProfile = chatItem?.memberProfile ?? chatItem?.senderProfile;
            const senderName =
              senderProfile?.displayName ?? senderProfile?.localDisplayName ?? "unknown";

            // Check for voice messages
            const isVoiceMessage =
              content?.type === "voice" || content?.msgContent?.type === "voice";

            if (isVoiceMessage) {
              const msg: SimplexMessage = {
                contactId: String(contact.contactId ?? contact.localDisplayName),
                contactName: contact.localDisplayName ?? contact.displayName ?? "unknown",
                text: "[Voice message]", // Placeholder - downstream should handle transcription
                messageId: chatItem.meta?.itemId ? String(chatItem.meta.itemId) : undefined,
                timestamp: chatItem.meta?.itemTs,
                isGroup: false,
                isVoice: true,
              };

              options.onMessage(msg).catch((err) => {
                options.onError(
                  err instanceof Error ? err : new Error(String(err)),
                  "message_handler",
                );
              });
              continue;
            }

            if (content?.type !== "rcvMsgContent") {
              // Also handle text messages with msgContent.type
              if (content?.msgContent?.type !== "text" && !content?.text) continue;
            }

            const text = content?.text ?? content?.msgContent?.text ?? "";
            if (!text) continue;

            const msg: SimplexMessage = {
              contactId: String(contact.contactId ?? contact.localDisplayName),
              contactName: contact.localDisplayName ?? contact.displayName ?? "unknown",
              text,
              messageId: chatItem.meta?.itemId ? String(chatItem.meta.itemId) : undefined,
              timestamp: chatItem.meta?.itemTs,
              isGroup: false,
            };

            options.onMessage(msg).catch((err) => {
              options.onError(
                err instanceof Error ? err : new Error(String(err)),
                "message_handler",
              );
            });
          }

          // Handle group messages
          if (chatInfo?.type === "group" || chatInfo?.type === "groupV2") {
            const groupInfo = chatInfo.groupInfo ?? chatInfo.group;
            if (!groupInfo) continue;

            // Only process incoming messages (not our own)
            const dir = chatItem?.chatDir;
            if (dir?.type !== "groupRcv" && dir?.type !== "directRcv") continue;

            const content = chatItem?.content;

            const senderProfile = chatItem?.memberProfile ?? chatItem?.senderProfile;
            const senderName =
              senderProfile?.displayName ?? senderProfile?.localDisplayName ?? "unknown";

            // Check for voice messages (type === 'voice')
            const isVoiceMessage =
              content?.type === "voice" || content?.msgContent?.type === "voice";

            // For voice messages, we need to get the file info
            if (isVoiceMessage) {
              const msg: SimplexMessage = {
                contactId: String(dir?.memberId ?? senderProfile?.memberId ?? "unknown"),
                contactName: senderName,
                text: "[Voice message]", // Placeholder - downstream should handle transcription
                messageId: chatItem.meta?.itemId ? String(chatItem.meta.itemId) : undefined,
                timestamp: chatItem.meta?.itemTs,
                isGroup: true,
                groupId: String(groupInfo.groupId ?? groupInfo.localDisplayName ?? "unknown"),
                groupName: groupInfo.localDisplayName ?? groupInfo.displayName ?? "unknown",
                isVoice: true,
                // Voice files are received via rcvFileComplete event, so we need to correlate
                fileReceived: undefined, // Will be set when file event arrives
              };

              options.onMessage(msg).catch((err) => {
                options.onError(
                  err instanceof Error ? err : new Error(String(err)),
                  "message_handler",
                );
              });
              continue;
            }

            // Text messages
            if (content?.type !== "rcvMsgContent") {
              if (content?.msgContent?.type !== "text" && !content?.text) continue;
            }

            const text = content?.text ?? content?.msgContent?.text ?? "";
            if (!text) continue;

            const msg: SimplexMessage = {
              contactId: String(dir?.memberId ?? senderProfile?.memberId ?? "unknown"),
              contactName: senderName,
              text,
              messageId: chatItem.meta?.itemId ? String(chatItem.meta.itemId) : undefined,
              timestamp: chatItem.meta?.itemTs,
              isGroup: true,
              groupId: String(groupInfo.groupId ?? groupInfo.localDisplayName ?? "unknown"),
              groupName: groupInfo.localDisplayName ?? groupInfo.displayName ?? "unknown",
            };

            options.onMessage(msg).catch((err) => {
              options.onError(
                err instanceof Error ? err : new Error(String(err)),
                "message_handler",
              );
            });
          }
        }
      }

      // Handle message delivery confirmation
      if (parsed.resp?.type === "messageDelivery") {
        // Message delivery confirmation - no action needed (success path)
      }

      // Handle message errors
      if (parsed.resp?.type === "messageError" || parsed.resp?.type === "error") {
        const errorMsg = parsed.resp?.error ?? parsed.resp?.message ?? JSON.stringify(parsed.resp);
        options.onError(new Error(errorMsg), "message_error");
      }

      // Handle file received events (rcvFileComplete)
      // SimpleX sends this when a file is received from a contact
      if (parsed.resp?.type === "rcvFileComplete") {
        const fileInfo = parsed.resp;
        const fileId = fileInfo?.fileId;
        const fileName = fileInfo?.fileName;
        const fileSize = fileInfo?.fileSize;
        const contact = fileInfo?.contact;

        // Determine media type from filename extension
        let mediaType: "image" | "voice" | "file" = "file";
        if (fileName) {
          const ext = fileName.toLowerCase();
          if (
            ext.endsWith(".jpg") ||
            ext.endsWith(".jpeg") ||
            ext.endsWith(".png") ||
            ext.endsWith(".gif") ||
            ext.endsWith(".webp")
          ) {
            mediaType = "image";
          } else if (
            ext.endsWith(".m4a") ||
            ext.endsWith(".mp3") ||
            ext.endsWith(".ogg") ||
            ext.endsWith(".wav")
          ) {
            mediaType = "voice";
          }
        }

        // Emit file received message
        const contactId = contact?.localDisplayName ?? contact?.displayName ?? "unknown";
        const msg: SimplexMessage = {
          contactId: String(contactId),
          contactName: contact?.localDisplayName ?? contact?.displayName ?? "unknown",
          text: `[File received: ${fileName || fileId}]`,
          messageId: fileId ? String(fileId) : undefined,
          isGroup: false,
          fileReceived: {
            fileId: String(fileId ?? ""),
            fileName,
            fileSize,
            mediaType,
          },
          isVoice: mediaType === "voice",
        };

        options.onMessage(msg).catch((err) => {
          options.onError(err instanceof Error ? err : new Error(String(err)), "file_handler");
        });
      }

      // Handle file sent confirmation (sndFileComplete)
      if (parsed.resp?.type === "sndFileComplete") {
        const fileInfo = parsed.resp;
        const fileId = fileInfo?.fileId;
        const fileName = fileInfo?.fileName;
        // Log file sent success - could emit event for tracking
        options.onError(new Error(`File sent: ${fileName || fileId}`), "file_sent");
      }

      // Handle contact request events
      if (parsed.resp?.type === "contactRequest" || parsed.resp?.type === "contactConnecting") {
        // Auto-accept contact requests (pairing is handled at OpenClaw level)
        const contactReq = parsed.resp?.contactRequest ?? parsed.resp?.contact;
        // Validate display name to prevent command injection via crafted names
        if (contactReq?.localDisplayName && SAFE_DISPLAY_NAME.test(contactReq.localDisplayName)) {
          sendCommand(`/ac ${contactReq.localDisplayName}`).catch(() => {});
        }
      }

      // Handle group invitation events
      if (parsed.resp?.type === "groupInvitation" || parsed.resp?.type === "groupMemberNew") {
        const groupInv = parsed.resp?.groupInvitation ?? parsed.resp?.groupInfo;
        if (groupInv?.localDisplayName && SAFE_DISPLAY_NAME.test(groupInv.localDisplayName)) {
          // Auto-accept group invitations
          sendCommand(`/gjoin ${groupInv.localDisplayName}`).catch(() => {});
        }
      }
    } catch {
      // Not JSON — might be plain text output from CLI
      // Parse "contactName> message text" format
      const match = raw.match(/^(.+?)> (.+)$/);
      if (match) {
        const msg: SimplexMessage = {
          contactId: match[1].trim(),
          contactName: match[1].trim(),
          text: match[2],
          isGroup: false,
        };
        options.onMessage(msg).catch((err) => {
          options.onError(err instanceof Error ? err : new Error(String(err)), "message_handler");
        });
      }
    }
  }

  async function sendCommand(command: string): Promise<unknown> {
    // Check connection state before attempting to send
    if (!ws || !connected || ws.readyState !== WebSocket.OPEN) {
      throw new Error("SimpleX WebSocket not connected");
    }

    const corrId = `cmd_${++commandCounter}`;
    const payload = JSON.stringify({ corrId, cmd: command });

    return new Promise((resolve, reject) => {
      // Set up timeout before sending
      const timeoutId = setTimeout(() => {
        if (pendingCommands.has(corrId)) {
          pendingCommands.delete(corrId);
          reject(new Error(`Command timed out (${COMMAND_TIMEOUT_MS}ms): ${command}`));
        }
      }, COMMAND_TIMEOUT_MS);

      try {
        ws!.send(payload, (err) => {
          if (err) {
            clearTimeout(timeoutId);
            pendingCommands.delete(corrId);
            reject(err);
            return;
          }
          // Command sent successfully, now wait for response
          pendingCommands.set(corrId, { resolve, reject, command });
        });
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // Validation helper: validate file path
  function validateFilePath(filePath: string): void {
    // Must be absolute path
    if (!path.isAbsolute(filePath)) {
      throw new Error(`File path must be absolute: ${filePath}`);
    }
    // Check for path traversal (..)
    const normalized = path.normalize(filePath);
    if (normalized.includes("..")) {
      throw new Error(`Path traversal not allowed: ${filePath}`);
    }
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
  }

  // Helper: check if file is an image by extension
  function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
  }

  // Helper: check if file is a voice message by extension
  function isVoiceFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return VOICE_EXTENSIONS.includes(ext);
  }

  // Start connection
  connect();

  return {
    sendMessage: async (contactId: string, text: string) => {
      // SimpleX CLI command to send a message: @contactName message
      // Escape @ in contactId to prevent command injection
      const safeContactId = contactId.replace(/[@#]/g, "");
      await sendCommand(`@${safeContactId} ${text}`);
    },

    sendGroupMessage: async (groupId: string, text: string) => {
      // SimpleX CLI command to send a group message: #groupName message
      // Escape # in groupId to prevent command injection
      const safeGroupId = groupId.replace(/[@#]/g, "");
      await sendCommand(`#${safeGroupId} ${text}`);
    },

    sendFile: async (contactId: string, filePath: string) => {
      // Validate file path
      validateFilePath(filePath);
      // SimpleX CLI command to send a file: /file @ContactName /absolute/path/to/file
      const safeContactId = contactId.replace(/[@#]/g, "");
      await sendCommand(`/file @${safeContactId} ${filePath}`);
    },

    sendGroupFile: async (groupId: string, filePath: string) => {
      // Validate file path
      validateFilePath(filePath);
      // SimpleX CLI command to send a file to group: /file #GroupName /absolute/path/to/file
      const safeGroupId = groupId.replace(/[@#]/g, "");
      await sendCommand(`/file #${safeGroupId} ${filePath}`);
    },

    sendImage: async (contactId: string, imagePath: string) => {
      // Validate file path and check it's an image
      validateFilePath(imagePath);
      if (!isImageFile(imagePath)) {
        throw new Error(
          `Not a valid image file: ${imagePath}. Allowed: ${IMAGE_EXTENSIONS.join(", ")}`,
        );
      }
      // Send as file (SimpleX handles images as files)
      const safeContactId = contactId.replace(/[@#]/g, "");
      await sendCommand(`/file @${safeContactId} ${imagePath}`);
    },

    sendVoice: async (contactId: string, audioPath: string) => {
      // Validate file path and check it's a voice file
      validateFilePath(audioPath);
      if (!isVoiceFile(audioPath)) {
        throw new Error(
          `Not a valid voice file: ${audioPath}. Allowed: ${VOICE_EXTENSIONS.join(", ")}`,
        );
      }
      // Send as file (SimpleX sends voice as .m4a files)
      const safeContactId = contactId.replace(/[@#]/g, "");
      await sendCommand(`/file @${safeContactId} ${audioPath}`);
    },

    receiveFile: async (fileId: string): Promise<{ filePath: string; fileName: string } | null> => {
      // Initiate file reception: /freceive <fileId>
      try {
        await sendCommand(`/freceive ${fileId}`);

        // Poll for file to be available in the database (max 60 seconds)
        // In a real implementation, we'd check the SQLite DB for rcv_complete status
        // For now, return null to indicate the file needs to be retrieved
        // The caller should check the DB for file_path after this returns
        return null;
      } catch (err) {
        console.error(`Failed to initiate file reception: ${err}`);
        return null;
      }
    },

    close: () => {
      shouldReconnect = false;
      clearTimers();
      // Reject pending commands before closing
      clearPendingCommands(new Error("Bus closing"));
      if (ws) {
        ws.close();
        ws = null;
      }
      connected = false;
    },

    isConnected: () => connected,

    getContactId: async (displayName: string): Promise<string | null> => {
      try {
        const resp = (await sendCommand("/contacts")) as {
          resp?: {
            contacts?: Array<{
              localDisplayName?: string;
              displayName?: string;
              contactId?: number | string;
            }>;
          };
        };
        const contacts = resp.resp?.contacts ?? [];
        const match = contacts.find(
          (c) => c.localDisplayName === displayName || c.displayName === displayName,
        );
        return match?.contactId != null ? String(match.contactId) : null;
      } catch {
        return null;
      }
    },

    getGroupId: async (displayName: string): Promise<string | null> => {
      try {
        const resp = (await sendCommand("/groups")) as {
          resp?: {
            groups?: Array<{
              localDisplayName?: string;
              displayName?: string;
              groupId?: number | string;
            }>;
          };
        };
        const groups = resp.resp?.groups ?? [];
        const match = groups.find(
          (g) => g.localDisplayName === displayName || g.displayName === displayName,
        );
        return match?.groupId != null ? String(match.groupId) : null;
      } catch {
        return null;
      }
    },
  };
}
