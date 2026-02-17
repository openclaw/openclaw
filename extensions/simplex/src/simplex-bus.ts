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
 */

import WebSocket from "ws";

export type SimplexMessage = {
  contactId: string;
  contactName: string;
  text: string;
  messageId?: string;
  timestamp?: string;
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
  close: () => void;
  isConnected: () => boolean;
  getContactId: (displayName: string) => Promise<string | null>;
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
  const reconnectMs = options.reconnectMs ?? 5000;

  // Pending command responses
  const pendingCommands = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let commandCounter = 0;

  function connect() {
    try {
      ws = new WebSocket(options.wsUrl);

      ws.on("open", () => {
        connected = true;
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
        options.onDisconnect(code, reason.toString());
        if (shouldReconnect) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
      });

      ws.on("error", (err) => {
        options.onError(err instanceof Error ? err : new Error(String(err)), "websocket");
      });
    } catch (err) {
      options.onError(err instanceof Error ? err : new Error(String(err)), "connect");
      if (shouldReconnect) {
        reconnectTimer = setTimeout(connect, reconnectMs);
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

          // Only process direct messages from contacts
          if (chatInfo?.type !== "direct") continue;

          const contact = chatInfo.contact;
          if (!contact) continue;

          // Only process incoming messages (not our own)
          const dir = chatItem?.chatDir;
          if (dir?.type !== "directRcv") continue;

          const content = chatItem?.content;
          if (content?.type !== "sndMsgContent" && content?.type !== "rcvMsgContent") {
            // Also handle text messages
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
          };

          options.onMessage(msg).catch((err) => {
            options.onError(
              err instanceof Error ? err : new Error(String(err)),
              "message_handler",
            );
          });
        }
      }

      // Handle contact request events
      if (parsed.resp?.type === "contactRequest" || parsed.resp?.type === "contactConnecting") {
        // Auto-accept contact requests (pairing is handled at OpenClaw level)
        const contactReq = parsed.resp?.contactRequest;
        if (contactReq) {
          sendCommand(`/ac ${contactReq.localDisplayName}`).catch(() => {});
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

    close: () => {
      shouldReconnect = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
  };
}
