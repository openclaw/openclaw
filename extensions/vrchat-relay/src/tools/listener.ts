import type { OSCMessage } from "../osc/types.js";
import { getOSCClient, resetOSCClient } from "../osc/client.js";

interface ListenerState {
  isRunning: boolean;
  messageCount: number;
  startTime?: Date;
}

const listenerState: ListenerState = {
  isRunning: false,
  messageCount: 0,
};

const recentMessages: OSCMessage[] = [];
const MAX_STORED_MESSAGES = 100;

/**
 * Start OSC listener to receive messages from VRChat
 */
export function startOSCListener(): { success: boolean; port: number; error?: string } {
  try {
    const client = getOSCClient();

    if (client.isListening()) {
      return { success: false, port: 0, error: "OSC listener is already running" };
    }

    client.startListener((message) => {
      listenerState.messageCount++;

      // Store recent messages
      recentMessages.push(message);
      if (recentMessages.length > MAX_STORED_MESSAGES) {
        recentMessages.shift();
      }
    });

    listenerState.isRunning = true;
    listenerState.startTime = new Date();

    return { success: true, port: 9001 };
  } catch (error) {
    return {
      success: false,
      port: 0,
      error: error instanceof Error ? error.message : "Unknown error starting OSC listener",
    };
  }
}

/**
 * Stop OSC listener
 */
export function stopOSCListener(): { success: boolean; error?: string } {
  try {
    const client = getOSCClient();
    client.stopListener();

    listenerState.isRunning = false;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error stopping OSC listener",
    };
  }
}

/**
 * Get OSC listener status
 */
export function getListenerStatus(): {
  isRunning: boolean;
  port: number;
  messageCount: number;
  startTime?: string;
} {
  return {
    isRunning: listenerState.isRunning,
    port: 9001,
    messageCount: listenerState.messageCount,
    startTime: listenerState.startTime?.toISOString(),
  };
}

/**
 * Get recent OSC messages
 */
export function getRecentMessages(count: number = 10): OSCMessage[] {
  return recentMessages.slice(-Math.min(count, MAX_STORED_MESSAGES));
}

/**
 * Reset OSC client and clear state
 */
export function resetOSC(): { success: boolean } {
  resetOSCClient();
  listenerState.isRunning = false;
  listenerState.messageCount = 0;
  listenerState.startTime = undefined;
  recentMessages.length = 0;

  return { success: true };
}
