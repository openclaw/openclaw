/**
 * Email Listener Skill - AgentMail Polling Module
 *
 * Handles polling Tim's AgentMail inbox for incoming emails.
 * Replaces traditional IMAP polling with AgentMail v0 API calls.
 */

import { logger } from "./logger.js";
import type { ParsedEmail } from "./types.js";

// Cache for inbox ID (email address) - 1 hour TTL
let inboxIdCache: { value: string; expiresAt: number } | null = null;
const INBOX_CACHE_TTL_MS = 3600000; // 1 hour

/**
 * Get AgentMail API key from environment
 */
function getApiKey(): string {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) {
    throw new Error("AGENTMAIL_API_KEY environment variable is not set");
  }
  return key;
}

/**
 * Get AgentMail inbox address from environment or use default
 */
function getInboxAddress(): string {
  return process.env.FRANKOS_EMAIL_AGENTMAIL_INBOX || "timsmail@agentmail.to";
}

/**
 * Get AgentMail API base URL
 */
function getApiBaseUrl(): string {
  return process.env.AGENTMAIL_API_URL || "https://api.agentmail.to";
}

/**
 * Get cached inbox ID or fetch from API
 */
async function getInboxId(inboxAddress: string): Promise<string> {
  const now = Date.now();

  // Return cached value if still valid
  if (inboxIdCache && inboxIdCache.expiresAt > now) {
    logger.debug("Using cached inbox ID", { inboxAddress });
    return inboxIdCache.value;
  }

  // Fetch inbox ID from API
  logger.debug("Fetching inbox ID from AgentMail API", { inboxAddress });

  const apiKey = getApiKey();
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/v0/inboxes`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`AgentMail API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const inboxes = Array.isArray(data) ? data : data.inboxes || [];

    // Find inbox matching our address
    const inbox = inboxes.find(
      (i: any) => (i.inbox_id || i.email_address || i.address || i.id) === inboxAddress
    );

    if (!inbox) {
      throw new Error(`Inbox not found in AgentMail: ${inboxAddress}`);
    }

    const inboxId = inbox.inbox_id || inbox.id || inboxAddress;

    // Cache the result
    inboxIdCache = {
      value: inboxId,
      expiresAt: now + INBOX_CACHE_TTL_MS,
    };

    logger.debug("Cached inbox ID", { inboxAddress, inboxId });
    return inboxId;
  } catch (error) {
    logger.error("Failed to fetch inbox ID from AgentMail", {
      error: String(error),
      inboxAddress,
    });
    throw error;
  }
}

/**
 * Poll AgentMail inbox for new messages
 */
export async function pollAgentMailInbox(): Promise<ParsedEmail[]> {
  const apiKey = getApiKey();
  const inboxAddress = getInboxAddress();
  const baseUrl = getApiBaseUrl();

  try {
    logger.debug("Polling AgentMail inbox", { inboxAddress });

    // Get inbox ID
    const inboxId = await getInboxId(inboxAddress);

    // Fetch messages from inbox
    const response = await fetch(`${baseUrl}/v0/inboxes/${inboxId}/messages`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`AgentMail API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const messages = Array.isArray(data) ? data : data.messages || [];

    logger.debug("Received messages from AgentMail", { count: messages.length });

    // Convert AgentMail messages to ParsedEmail format
    const emails = messages
      .filter((msg: any) => msg && msg.message_id)
      .map((msg: any) => parseAgentMailMessage(msg));

    return emails;
  } catch (error) {
    logger.error("Failed to poll AgentMail inbox", {
      error: String(error),
      inboxAddress,
    });
    throw error;
  }
}

/**
 * Parse AgentMail message into ParsedEmail format
 */
function parseAgentMailMessage(msg: any): ParsedEmail {
  // Extract sender info - AgentMail returns 'from' as a string like "Name <email@example.com>"
  let senderEmail = "unknown@example.com";
  let senderName = "Unknown Sender";

  const fromField = msg.from || msg.sender || "";

  if (typeof fromField === "string") {
    // Parse "Name <email@example.com>" format
    const emailMatch = fromField.match(/<(.+?)>/);
    if (emailMatch) {
      senderEmail = emailMatch[1];
      senderName = fromField.substring(0, fromField.indexOf("<")).trim() || senderEmail;
    } else if (fromField.includes("@")) {
      // Just an email address
      senderEmail = fromField;
      senderName = fromField;
    }
  } else if (typeof fromField === "object" && fromField !== null) {
    // Handle object format (for compatibility)
    senderEmail = fromField.email || fromField.address || "unknown@example.com";
    senderName = fromField.name || senderEmail;
  }

  // Extract subject and body
  const subject = msg.subject || "(no subject)";
  const body = msg.text || msg.body || msg.preview || "";

  // Parse date
  let timestamp = new Date();
  if (msg.date || msg.timestamp) {
    const dateToparse = msg.date || msg.timestamp;
    const parsed = new Date(dateToparse);
    if (!isNaN(parsed.getTime())) {
      timestamp = parsed;
    }
  }

  return {
    messageId: msg.message_id || msg.id || `<${Date.now()}-${Math.random()}>`,
    sender: senderEmail,
    senderName: senderName,
    subject: subject,
    body: body,
    timestamp: timestamp,
  };
}

/**
 * Send email via AgentMail API
 */
export async function sendEmailViaAgentMail(
  to: string,
  subject: string,
  body: string
): Promise<string> {
  const apiKey = getApiKey();
  const inboxAddress = getInboxAddress();
  const baseUrl = getApiBaseUrl();

  try {
    logger.debug("Sending email via AgentMail", { to, subject });

    // Get inbox ID
    const inboxId = await getInboxId(inboxAddress);

    // Send email via AgentMail API
    const response = await fetch(
      `${baseUrl}/v0/inboxes/${inboxId}/messages/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: to,
          subject: subject,
          text: body,
          // Add custom header to identify self-generated emails (feedback loop prevention)
          headers: {
            "X-AgentMail-Response": "true",
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`AgentMail API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const messageId = data.message_id || data.id || "unknown";

    logger.info("Email sent via AgentMail", {
      to,
      subject,
      messageId,
    });

    return messageId;
  } catch (error) {
    logger.error("Failed to send email via AgentMail", {
      error: String(error),
      to,
      subject,
    });
    throw error;
  }
}

/**
 * Health check for AgentMail connection
 */
export async function healthCheckAgentMail(): Promise<{
  healthy: boolean;
  message: string;
  timestamp: string;
}> {
  try {
    const apiKey = getApiKey();
    const inboxAddress = getInboxAddress();
    const baseUrl = getApiBaseUrl();

    // Try to fetch inboxes as a connectivity check
    const response = await fetch(`${baseUrl}/v0/inboxes`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const healthy = response.ok;
    const message = healthy
      ? `Connected to AgentMail (${inboxAddress})`
      : `AgentMail API error: ${response.status}`;

    return {
      healthy,
      message,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      healthy: false,
      message: `AgentMail connection failed: ${String(error)}`,
      timestamp: new Date().toISOString(),
    };
  }
}
