/**
 * Zulip Message Monitor
 * 
 * Monitors incoming Zulip messages using the event queue API.
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import {
  createZulipClient,
  registerZulipEventQueue,
  getZulipEvents,
  deleteZulipEventQueue,
  fetchZulipMe,
  type ZulipClient,
  type ZulipMessage,
  type ZulipUser,
} from "./client.js";

export type ZulipMonitorParams = {
  email: string;
  apiKey: string;
  baseUrl: string;
  accountId: string;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
};

export type ZulipMonitorResult = {
  stop: () => Promise<void>;
};

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

export async function monitorZulipProvider(
  params: ZulipMonitorParams,
): Promise<ZulipMonitorResult> {
  const { email, apiKey, baseUrl, accountId, runtime, abortSignal, statusSink } = params;

  let client: ZulipClient | null = null;
  let queueId: string | null = null;
  let lastEventId = -1;
  let botUser: ZulipUser | null = null;
  let running = true;
  let reconnectDelay = RECONNECT_DELAY_MS;

  const log = (level: "info" | "warn" | "error", msg: string) => {
    const prefix = `[zulip:${accountId}]`;
    if (level === "error") {
      console.error(`${prefix} ${msg}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${msg}`);
    } else {
      console.log(`${prefix} ${msg}`);
    }
  };

  const updateStatus = (patch: Partial<{
    running: boolean;
    connected: boolean;
    lastError: string | null;
    lastConnectedAt: string | null;
    lastDisconnect: { at: string; reason: string } | null;
    lastInboundAt: string | null;
  }>) => {
    statusSink(patch);
  };

  const connect = async (): Promise<boolean> => {
    try {
      log("info", `connecting to ${baseUrl}...`);
      
      client = createZulipClient({ baseUrl, email, apiKey });
      
      // Fetch bot user info
      botUser = await fetchZulipMe(client);
      log("info", `authenticated as ${botUser.full_name} (${botUser.email})`);
      
      // Register event queue
      const queue = await registerZulipEventQueue(client, {
        event_types: ["message"],
        all_public_streams: true,
      });
      
      queueId = queue.queue_id;
      lastEventId = queue.last_event_id;
      
      log("info", `registered event queue: ${queueId}`);
      
      updateStatus({
        connected: true,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
      });
      
      reconnectDelay = RECONNECT_DELAY_MS; // Reset delay on successful connect
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log("error", `connection failed: ${errorMsg}`);
      updateStatus({
        connected: false,
        lastError: errorMsg,
        lastDisconnect: {
          at: new Date().toISOString(),
          reason: errorMsg,
        },
      });
      return false;
    }
  };

  const cleanup = async () => {
    if (client && queueId) {
      try {
        await deleteZulipEventQueue(client, queueId);
        log("info", "deleted event queue");
      } catch {
        // Ignore cleanup errors
      }
    }
    queueId = null;
    client = null;
  };

  const handleMessage = async (message: ZulipMessage) => {
    // Skip messages from self
    if (botUser && message.sender_id === botUser.user_id) {
      return;
    }

    const isDirectMessage = message.type === "private";
    const streamName = isDirectMessage ? null : String(message.display_recipient);
    const topic = message.subject;
    
    // Determine sender info
    const senderId = String(message.sender_id);
    const senderName = message.sender_full_name;

    // Build chat ID
    let chatId: string;
    let roomLabel: string;
    if (isDirectMessage) {
      // For DMs, use the recipient list as chat ID
      const recipients = Array.isArray(message.display_recipient)
        ? (message.display_recipient as ZulipUser[]).map(u => u.user_id).sort().join(",")
        : senderId;
      chatId = `dm:${recipients}`;
      roomLabel = "DM";
    } else {
      chatId = `stream:${streamName}:${topic || "general"}`;
      roomLabel = `#${streamName} > ${topic || "general"}`;
    }

    const bodyText = message.content;
    log("info", `message from ${senderName} in ${chatId}: ${bodyText.slice(0, 50)}...`);

    updateStatus({ lastInboundAt: new Date().toISOString() });

    // Build session key
    const sessionKey = `zulip:${accountId}:${chatId}`;

    // Route message using the OpenClaw system event pattern
    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Zulip DM from ${senderName}`
      : `Zulip message in ${roomLabel} from ${senderName}`;

    runtime.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `zulip:message:${chatId}:${message.id}`,
    });

    log("info", `routed message to session ${sessionKey}`);
  };

  const pollEvents = async (): Promise<void> => {
    if (!client || !queueId) {
      return;
    }

    try {
      const result = await getZulipEvents(client, {
        queue_id: queueId,
        last_event_id: lastEventId,
        dont_block: false,
      });

      for (const event of result.events) {
        lastEventId = Math.max(lastEventId, event.id);
        
        if (event.type === "message" && event.message) {
          await handleMessage(event.message);
        } else if (event.type === "heartbeat") {
          // Zulip sends heartbeat events to keep connection alive
          log("info", "heartbeat received");
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      // Check for queue expired/not found errors
      if (errorMsg.includes("BAD_EVENT_QUEUE_ID") || errorMsg.includes("queue_id")) {
        log("warn", "event queue expired, reconnecting...");
        await cleanup();
        throw err; // Trigger reconnect
      }
      
      throw err;
    }
  };

  const runLoop = async () => {
    updateStatus({ running: true });
    
    while (running && !abortSignal.aborted) {
      // Connect if needed
      if (!client || !queueId) {
        const connected = await connect();
        if (!connected) {
          log("info", `waiting ${reconnectDelay}ms before reconnect...`);
          await new Promise(r => setTimeout(r, reconnectDelay));
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          continue;
        }
      }

      // Poll for events
      try {
        await pollEvents();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log("error", `poll error: ${errorMsg}`);
        
        updateStatus({
          connected: false,
          lastError: errorMsg,
          lastDisconnect: {
            at: new Date().toISOString(),
            reason: errorMsg,
          },
        });
        
        await cleanup();
        
        log("info", `waiting ${reconnectDelay}ms before reconnect...`);
        await new Promise(r => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }

    await cleanup();
    updateStatus({ running: false, connected: false });
    log("info", "monitor stopped");
  };

  // Start the monitor loop
  const loopPromise = runLoop();

  // Handle abort signal
  abortSignal.addEventListener("abort", () => {
    running = false;
  });

  return {
    stop: async () => {
      running = false;
      await loopPromise;
    },
  };
}
