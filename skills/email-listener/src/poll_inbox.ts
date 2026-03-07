/**
 * Email Listener Skill - IMAP Polling Module
 *
 * Handles connecting to IMAP server and polling for new emails.
 */

import Imap from "imap-simple";
import type { ImapSimple } from "imap-simple";
import type { EmailListenerConfig, ParsedEmail } from "./types.js";
import { logger } from "./logger.js";
import { parseEmail } from "./parse_email.js";

let imapConnection: ImapSimple | null = null;
let lastUid = 0;

/**
 * Connect to IMAP server
 */
export async function connect(config: EmailListenerConfig["imap"]): Promise<ImapSimple> {
  logger.info("Connecting to IMAP server", { host: config.host, port: config.port });

  const imapConfig = {
    imap: {
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.secure,
      tlsOptions: {
        rejectUnauthorized: false,
      },
      authTimeout: 30000,
    },
  };

  try {
    imapConnection = await Imap.connect(imapConfig);
    logger.info("Connected to IMAP server successfully");
    return imapConnection;
  } catch (error) {
    logger.error("Failed to connect to IMAP server", { error: String(error) });
    throw error;
  }
}

/**
 * Disconnect from IMAP server
 */
export async function disconnect(): Promise<void> {
  if (imapConnection) {
    try {
      imapConnection.end();
      logger.info("Disconnected from IMAP server");
    } catch (error) {
      logger.warn("Error disconnecting from IMAP", { error: String(error) });
    } finally {
      imapConnection = null;
    }
  }
}

/**
 * Check if connected to IMAP
 */
export function isConnected(): boolean {
  return imapConnection !== null && imapConnection.state === "authenticated";
}

/**
 * Open the INBOX folder
 */
async function openInbox(): Promise<void> {
  if (!imapConnection) {
    throw new Error("Not connected to IMAP server");
  }

  try {
    await imapConnection.openBox("INBOX", false);
    logger.debug("Opened INBOX");
  } catch (error) {
    logger.error("Failed to open INBOX", { error: String(error) });
    throw error;
  }
}

/**
 * Poll for new emails since last check
 */
export async function pollInbox(config: EmailListenerConfig["imap"]): Promise<ParsedEmail[]> {
  // Connect if not connected
  if (!isConnected()) {
    await connect(config);
  }

  if (!imapConnection) {
    throw new Error("IMAP connection not available");
  }

  await openInbox();

  // Search for new messages since last UID
  const searchCriteria: string[] = ["UNSEEN"];

  if (lastUid > 0) {
    // Also get seen messages that are newer than our last check
    // Use UID range to get messages after lastUid
    searchCriteria.push("UID");
    searchCriteria.push(`${lastUid + 1}:*`);
  }

  try {
    const messages = await imapConnection.search(searchCriteria, {
      bodies: ["HEADER", "TEXT"],
      markSeen: false,
    });

    logger.info("Found new messages", { count: messages.length });

    const parsedEmails: ParsedEmail[] = [];

    for (const message of messages) {
      try {
        const parsed = parseEmail(message);
        parsedEmails.push(parsed);

        // Update lastUid
        if (parsed.messageId) {
          // Get the UID for this message
          const uid = message.attributes.uid;
          if (uid && uid > lastUid) {
            lastUid = uid;
          }
        }
      } catch (error) {
        logger.warn("Failed to parse email", { error: String(error) });
      }
    }

    return parsedEmails;
  } catch (error) {
    logger.error("Failed to search INBOX", { error: String(error) });

    // Try to reconnect on error
    await disconnect();
    throw error;
  }
}

/**
 * Mark email as seen
 */
export async function markAsSeen(messageId: string): Promise<void> {
  if (!imapConnection) {
    throw new Error("Not connected to IMAP server");
  }

  try {
    // Get the message by ID and mark as seen
    const messages = await imapConnection.search([["HEADER", "Message-ID", messageId]], {
      bodies: [],
    });

    if (messages.length > 0) {
      await imapConnection.setFlags(messages[0].attributes.uid, ["\\Seen"]);
      logger.debug("Marked email as seen", { messageId });
    }
  } catch (error) {
    logger.warn("Failed to mark email as seen", { messageId, error: String(error) });
  }
}

/**
 * Reset the polling state (for testing)
 */
export function resetPollingState(): void {
  lastUid = 0;
}

/**
 * Get current polling state
 */
export function getPollingState(): { lastUid: number } {
  return { lastUid };
}

/**
 * Move email to trash folder
 */
export async function moveToTrash(uids: number[]): Promise<number> {
  if (!imapConnection) {
    throw new Error("Not connected to IMAP server");
  }

  if (uids.length === 0) {
    return 0;
  }

  try {
    await openInbox();
    // Move messages to Trash folder
    await imapConnection.moveMessages(uids, "Trash");
    logger.info("Moved emails to trash", { count: uids.length });
    return uids.length;
  } catch (error) {
    logger.error("Failed to move emails to trash", { uids: uids.length, error: String(error) });
    throw error;
  }
}

/**
 * Delete emails permanently
 */
export async function deleteEmails(uids: number[]): Promise<number> {
  if (!imapConnection) {
    throw new Error("Not connected to IMAP server");
  }

  if (uids.length === 0) {
    return 0;
  }

  try {
    await openInbox();
    // Add Deleted flag to mark for deletion
    await imapConnection.setFlags(uids, ["\\Deleted"]);
    // Expunge to permanently remove
    await imapConnection.addFlags(uids, ["\\Deleted"], () => {});
    logger.info("Permanently deleted emails", { count: uids.length });
    return uids.length;
  } catch (error) {
    logger.error("Failed to delete emails", { uids: uids.length, error: String(error) });
    throw error;
  }
}

/**
 * Get all processed UIDs from INBOX (emails that have been seen)
 * This is used for cleanup to find old emails
 */
export async function getProcessedEmailUids(): Promise<number[]> {
  if (!imapConnection) {
    throw new Error("Not connected to IMAP server");
  }

  try {
    await openInbox();
    // Get all SEEN messages (processed emails)
    const messages = await imapConnection.search(["SEEN"], {
      bodies: [],
    });

    const uids = messages.map((msg) => msg.attributes.uid as number);
    logger.debug("Found processed emails", { count: uids.length });
    return uids;
  } catch (error) {
    logger.error("Failed to get processed email UIDs", { error: String(error) });
    throw error;
  }
}
