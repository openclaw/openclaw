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

import WebSocket from "ws";

/** Safe display name pattern — alphanumeric, underscores, dots, hyphens only. */
const SAFE_DISPLAY_NAME = /^[\w.-]+$/;

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
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
        pending?.resolve(parsed);
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
              options.onError(err instanceof Error ? err : new Error(String(err)), "message_handler");
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
            if (content?.type !== "rcvMsgContent") {
              if (content?.msgContent?.type !== "text" && !content?.text) continue;
            }

            const text = content?.text ?? content?.msgContent?.text ?? "";
            if (!text) continue;

            const senderProfile = chatItem?.memberProfile ?? chatItem?.senderProfile;
            const senderName = senderProfile?.displayName ?? senderProfile?.localDisplayName ?? "unknown";

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
              options.onError(err instanceof Error ? err : new Error(String(err)), "message_handler");
            });
          }
        }
      }

      // Handle message delivery confirmation
      if (parsed.resp?.type === "messageDelivery") {
        const msgId = parsed.resp?.msgId;
        // Message was delivered - could emit event for tracking
        options.onError(new Error(`Message delivered: ${msgId}`), "delivery");
      }

      // Handle message errors
      if (parsed.resp?.type === "messageError" || parsed.resp?.type === "error") {
        const errorMsg = parsed.resp?.error ?? parsed.resp?.message ?? JSON.stringify(parsed.resp);
        options.onError(new Error(errorMsg), "message_error");
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
    if (!ws || !connected) {
      throw new Error("SimpleX WebSocket not connected");
    }

    const corrId = `cmd_${++commandCounter}`;
    const payload = JSON.stringify({ corrId, cmd: command });

    return new Promise((resolve, reject) => {
      pendingCommands.set(corrId, { resolve, reject });
      ws!.send(payload, (err) => {
        if (err) {
          pendingCommands.delete(corrId);
          reject(err);
        }
      });

      // Timeout after COMMAND_TIMEOUT_MS
      setTimeout(() => {
        if (pendingCommands.has(corrId)) {
          pendingCommands.delete(corrId);
          reject(new Error(`Command timed out (${COMMAND_TIMEOUT_MS}ms): ${command}`));
        }
      }, COMMAND_TIMEOUT_MS);
    });
  }

  // Start connection
  connect();

  return {
    sendMessage: async (contactId: string, text: string) => {
      // SimpleX CLI command to send a message: @contactName message
      await sendCommand(`@${contactId} ${text}`);
    },

    sendGroupMessage: async (groupId: string, text: string) => {
      // SimpleX CLI command to send a group message: #groupName message
      await sendCommand(`#${groupId} ${text}`);
    },

    close: () => {
      shouldReconnect = false;
      clearTimers();
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
