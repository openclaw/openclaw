import { getOSCClient } from "../osc/client.js";
import { logInfo, logSkip, logError } from "./audit.js";
import { checkPermission } from "./permissions.js";
import { rateLimiters } from "./rate-limiter.js";

export interface ChatboxSendParams {
  message: string;
  sendImmediately?: boolean;
  sfx?: boolean;
  typingDelayMs?: number;
}

// NFC Normalize text for VRChat compatibility
function normalizeText(text: string): string {
  // Normalize to NFC form
  let normalized = text.normalize("NFC");

  // Limit to 144 characters
  if (normalized.length > 144) {
    normalized = normalized.substring(0, 144);
  }

  // Limit to 9 lines
  const lines = normalized.split("\n");
  if (lines.length > 9) {
    normalized = lines.slice(0, 9).join("\n");
  }

  return normalized;
}

/**
 * Send a message to VRChat chatbox with proper typing flow
 */
export async function sendChatboxMessage(
  params: ChatboxSendParams,
): Promise<{ success: boolean; error?: string; trimmed?: boolean }> {
  const permission = checkPermission("chatbox_send");

  if (!permission.allowed) {
    logSkip("chatbox_send", permission.message || "Permission denied", {
      level: permission.level,
    });
    return { success: false, error: permission.message };
  }

  // Check rate limit
  const rateLimit = rateLimiters.chatbox.allowAction();
  if (!rateLimit.allowed) {
    const error = rateLimit.jailTimeRemaining
      ? `Rate limit exceeded. Jail time: ${Math.ceil(rateLimit.jailTimeRemaining / 1000)}s`
      : "Rate limit exceeded";

    logSkip("chatbox_send", error, { remaining: rateLimit.remaining });
    return { success: false, error };
  }

  try {
    const { message, sendImmediately = true, sfx = true, typingDelayMs = 1200 } = params;

    if (!message || message.trim() === "") {
      return { success: false, error: "Message cannot be empty" };
    }

    // Normalize message
    const normalized = normalizeText(message);
    const wasTrimmed = normalized.length !== message.length;

    const client = getOSCClient();

    // Step 1: Set typing indicator
    client.setTyping(true);

    // Step 2: Wait for typing delay
    await new Promise((resolve) => setTimeout(resolve, typingDelayMs));

    // Step 3: Send message with SFX flag
    // OSC format: /chatbox/input s b n (message, immediate, sfx)
    client.send("/chatbox/input", [normalized, sendImmediately, sfx]);

    // Step 4: Clear typing indicator
    client.setTyping(false);

    logInfo("chatbox_send", {
      messageLength: normalized.length,
      wasTrimmed,
      sendImmediately,
      sfx,
      remaining: rateLimit.remaining,
    });

    return {
      success: true,
      trimmed: wasTrimmed,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("chatbox_send", errorMessage, { messageLength: params.message.length });
    return { success: false, error: errorMessage };
  }
}

/**
 * Set typing indicator only
 */
export function setChatboxTyping(typing: boolean): { success: boolean; error?: string } {
  const permission = checkPermission("chatbox_typing");

  if (!permission.allowed) {
    logSkip("chatbox_typing", permission.message || "Permission denied");
    return { success: false, error: permission.message };
  }

  try {
    const client = getOSCClient();
    client.setTyping(typing);

    logInfo("chatbox_typing", { typing });
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logError("chatbox_typing", errorMessage, { typing });
    return { success: false, error: errorMessage };
  }
}

/**
 * Get chatbox rate limit status
 */
export function getChatboxRateLimitStatus(): {
  allowed: boolean;
  remaining: number;
  inJail: boolean;
  jailTimeRemaining: number;
} {
  const status = rateLimiters.chatbox.getStatus();
  return {
    allowed: !status.inJail && status.tokens > 0,
    remaining: status.tokens,
    inJail: status.inJail,
    jailTimeRemaining: status.jailTimeRemaining,
  };
}
