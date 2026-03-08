import { getOSCClient } from "../osc/client.js";

export interface ChatboxSendParams {
  message: string;
  sendImmediately?: boolean;
}

/**
 * Send a message to VRChat chatbox
 */
export function sendChatboxMessage(params: ChatboxSendParams): {
  success: boolean;
  error?: string;
} {
  try {
    const { message, sendImmediately = true } = params;

    if (!message || message.trim() === "") {
      return { success: false, error: "Message cannot be empty" };
    }

    if (message.length > 144) {
      return { success: false, error: "Message exceeds 144 character limit for VRChat chatbox" };
    }

    const client = getOSCClient();
    client.sendChatbox(message, sendImmediately);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending chatbox message",
    };
  }
}

export interface SetTypingParams {
  typing: boolean;
}

/**
 * Set typing indicator in VRChat chatbox
 */
export function setChatboxTyping(params: SetTypingParams): { success: boolean; error?: string } {
  try {
    const { typing } = params;
    const client = getOSCClient();
    client.setTyping(typing);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error setting typing indicator",
    };
  }
}
