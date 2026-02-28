import WebSocket from "ws";

/** Safe display name pattern — alphanumeric, underscores, dots, hyphens only. */
const SAFE_DISPLAY_NAME = /^[\w.-]+$/;

/** Max reconnect delay: 5 minutes */
const MAX_RECONNECT_MS = 300_000;

/** Connection timeout: 10 seconds */
const CONNECTION_TIMEOUT_MS = 10_000;

export type SimplexMessage = {
  contactId: string;
  contactName: string;
  text: string;
  messageId?: string;
  timestamp?: string;
  chatType?: "direct" | "group";
  groupId?: string;
  groupName?: string;
};

export type SimplexBusOptions = {
  wsUrl: string;
  onMessage: (msg: SimplexMessage) => Promise<void>;
  onError: (error: Error, context: string) => void;
  onConnect: () => void;
  onDisconnect: (code: number, reason: string) => void;
  reconnectMs?: number;
};

export type SimplexBusHandle = {
  sendMessage: (contactId: string, text: string) => Promise<void>;
  sendToGroup: (groupId: string, text: string) => Promise<void>;
  close: () => void;
  isConnected: () => boolean;
  getContactId: (displayName: string) => Promise<string | null>;
  getGroupId: (displayName: string) => Promise<string | null>;
};

/**
 * Start a SimpleX WebSocket bus.
 *
 * Connects to the simplex-chat CLI WebSocket server and forwards
 * incoming DMs to the callback. Outbound messages are sent via
 * the returned handle.
 */
export function startSimplexBus(options: SimplexBusOptions): SimplexBusHandle {
  let ws: WebSocket | null = null;
  let connected = false;
  let shouldReconnect = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
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

  function connect() {
    // Clear any existing connection timer
    if (connectionTimer) {
      clearTimeout(connectionTimer);
      connectionTimer = null;
    }

    try {
      ws = new WebSocket(options.wsUrl);

      // Connection timeout
      connectionTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          options.onError(new Error("Connection timeout"), "connect_timeout");
          if (shouldReconnect) {
            const delay = getReconnectDelay();
            reconnectTimer = setTimeout(connect, delay);
          }
        }
      }, CONNECTION_TIMEOUT_MS);

      ws.on("open", () => {
        connected = true;
        reconnectAttempts = 0; // Reset on successful connection
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
        options.onConnect();
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
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
        options.onDisconnect(code, reason.toString());
        if (shouldReconnect) {
          const delay = getReconnectDelay();
          reconnectTimer = setTimeout(connect, delay);
        }
      });

      ws.on("error", (err) => {
        // Don't log ECONNREFUSED as error - it's expected when CLI isn't running
        const errMsg = err.message || String(err);
        if (!errMsg.includes("ECONNREFUSED")) {
          options.onError(err instanceof Error ? err : new Error(String(err)), "websocket");
        }
        // Connection will be retried via close handler
      });
    } catch (err) {
      options.onError(err instanceof Error ? err : new Error(String(err)), "connect");
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
      if (parsed.resp?.type === "newChatItems" || parsed.resp?.type === "chatItemUpdated") {
        const chatItems = parsed.resp?.chatItems ?? [parsed.resp?.chatItem];
        for (const item of chatItems) {
          if (!item) continue;

          const chatInfo = item.chatInfo;
          const chatItem = item.chatItem;

          // Determine chat type
          const isDirect = chatInfo?.type === "direct";
          const isGroup = chatInfo?.type === "group";

          if (!isDirect && !isGroup) continue;

          // Only process incoming messages (not our own)
          const dir = chatItem?.chatDir;
          if (isDirect && dir?.type !== "directRcv") continue;
          if (isGroup && dir?.type !== "groupRcv") continue;

          const content = chatItem?.content;
          
          // Handle different message content types
          let text = "";
          if (content?.msgContent?.type === "text") {
            text = content.msgContent.text;
          } else if (content?.text) {
            text = content.text;
          } else if (content?.type === "rcvMsgContent" && content?.msgContent?.text) {
            text = content.msgContent.text;
          }
          
          if (!text) continue;

          let contactId = "";
          let contactName = "";
          
          if (isDirect) {
            const contact = chatInfo.contact;
            contactId = String(contact?.contactId ?? contact?.localDisplayName);
            contactName = contact?.localDisplayName ?? contact?.displayName ?? "unknown";
          } else if (isGroup) {
            const group = chatInfo.group;
            contactId = String(group?.groupId ?? group?.localDisplayName);
            contactName = group?.localDisplayName ?? group?.displayName ?? "unknown";
          }

          const msg: SimplexMessage = {
            contactId,
            contactName,
            text,
            messageId: chatItem.meta?.itemId ? String(chatItem.meta.itemId) : undefined,
            timestamp: chatItem.meta?.itemTs,
            chatType: isGroup ? "group" : "direct",
            groupId: isGroup ? contactId : undefined,
            groupName: isGroup ? contactName : undefined,
          };

          options.onMessage(msg).catch((err) => {
            options.onError(err instanceof Error ? err : new Error(String(err)), "message_handler");
          });
        }
      }

      // Handle contact request events
      if (parsed.resp?.type === "contactRequest" || parsed.resp?.type === "contactConnecting") {
        // Auto-accept contact requests (pairing is handled at OpenClaw level)
        const contactReq = parsed.resp?.contactRequest;
        // Validate display name to prevent command injection via crafted names
        if (contactReq?.localDisplayName && SAFE_DISPLAY_NAME.test(contactReq.localDisplayName)) {
          sendCommand(`/ac ${contactReq.localDisplayName}`).catch(() => {});
        }
      }

      // Handle new group invitations
      if (parsed.resp?.type === "newGroupInvitation") {
        const groupInvite = parsed.resp?.groupInvitation;
        if (groupInvite?.groupInfo?.localDisplayName) {
          // Auto-accept group invitations
          const groupName = groupInvite.groupInfo.localDisplayName;
          sendCommand(`/aic ${groupName}`).catch(() => {});
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
          chatType: "direct",
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

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingCommands.has(corrId)) {
          pendingCommands.delete(corrId);
          reject(new Error(`Command timed out: ${command}`));
        }
      }, 30000);
    });
  }

  // Start connection
  connect();

  return {
    sendMessage: async (contactId: string, text: string) => {
      // SimpleX CLI command to send a message: @contactName message
      await sendCommand(`@${contactId} ${text}`);
    },

    sendToGroup: async (groupId: string, text: string) => {
      // SimpleX CLI command to send to a group: #groupId message
      await sendCommand(`#${groupId} ${text}`);
    },

    close: () => {
      shouldReconnect = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (connectionTimer) clearTimeout(connectionTimer);
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
