import * as fs from "fs";
import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import * as os from "os";
import * as path from "path";

interface EmailConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  };
  checkInterval?: number;
  allowedSenders?: string[];
}

interface EmailProcessorState {
  lastProcessedTimestamp: string; // ISO 8601 format
  processedMessageIds: string[]; // List of Message-IDs that have been processed
}

const STATE_FILE_PATH = path.join(os.homedir(), ".openclaw", "extensions", "email", "state.json");

let imapConnection: Imap | null = null;
let smtpTransporter: nodemailer.Transporter | null = null;
let currentConfig: EmailConfig | null = null;
let checkTimer: NodeJS.Timeout | null = null;
let isInboxOpen = false; // Track if inbox is currently open
let isProcessingEmails = false; // Prevent overlapping email processing
let messageHandler:
  | ((
      from: string,
      fromEmail: string,
      subject: string,
      body: string,
      messageId: string,
      uid: number,
    ) => Promise<void>)
  | null = null;
let allowedSenders: string[] = [];
let currentState: EmailProcessorState = {
  lastProcessedTimestamp: new Date(0).toISOString(), // Default to epoch
  processedMessageIds: [],
};

// Load state from file
function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, "utf-8");
      currentState = JSON.parse(data);
      console.log(
        `[EMAIL PLUGIN] Loaded state: lastProcessed=${currentState.lastProcessedTimestamp}, processedCount=${currentState.processedMessageIds.length}`,
      );
    } else {
      console.log("[EMAIL PLUGIN] No existing state file, starting fresh");
    }
  } catch (error) {
    console.error("[EMAIL PLUGIN] Error loading state file:", error);
    console.log("[EMAIL PLUGIN] Starting with empty state");
  }
}

// Save state to file
function saveState(): void {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(currentState, null, 2));
  } catch (error) {
    console.error("[EMAIL PLUGIN] Error saving state file:", error);
  }
}

// Check if a message has been processed
function isMessageProcessed(messageId: string): boolean {
  return currentState.processedMessageIds.includes(messageId);
}

// Mark a message ID as processed (without updating timestamp)
function markMessageIdAsProcessed(messageId: string): void {
  if (!currentState.processedMessageIds.includes(messageId)) {
    currentState.processedMessageIds.push(messageId);
    saveState();
  }
}

// Mark a message as processed and update timestamp
function markMessageAsProcessed(messageId: string): void {
  // Always update timestamp when processing completes
  currentState.lastProcessedTimestamp = new Date().toISOString();
  if (!currentState.processedMessageIds.includes(messageId)) {
    currentState.processedMessageIds.push(messageId);
  }
  saveState();
}

// Clean up old Message-IDs (keep only last 1000 to prevent file from growing too large)
function cleanupOldMessageIds(): void {
  if (currentState.processedMessageIds.length > 1000) {
    currentState.processedMessageIds = currentState.processedMessageIds.slice(-1000);
    saveState();
  }
}

function extractEmail(from: string): string {
  // Extract email from "Name <email>" format
  const emailMatch = from.match(/<([^>]+)>/);
  return emailMatch ? emailMatch[1].trim().toLowerCase() : from.trim().toLowerCase();
}

function isSenderAllowed(fromEmail: string): boolean {
  if (!allowedSenders || allowedSenders.length === 0) {
    return true; // No restrictions
  }
  return allowedSenders.some((allowed) => fromEmail === allowed.toLowerCase());
}

function createImapConnection(config: EmailConfig): Imap {
  return new Imap({
    user: config.imap.user,
    password: config.imap.password,
    host: config.imap.host,
    port: config.imap.port,
    tls: config.imap.secure,
  });
}

function createSmtpTransporter(config: EmailConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
  });
}

function openInbox(cb: (err: Error | null, box?: any) => void): void {
  if (!imapConnection) {
    cb(new Error("IMAP connection not initialized"));
    return;
  }
  imapConnection.openBox("INBOX", (err, box) => {
    if (!err) {
      isInboxOpen = true;
    }
    cb(err, box);
  });
}

function formatDateForImap(date: Date): string {
  // IMAP date format: 06-Feb-2026
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = String(date.getDate()).padStart(2, "0");
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function checkEmail(): void {
  if (!imapConnection) return;

  // Check if inbox is open before searching
  if (!isInboxOpen) {
    console.log("[EMAIL PLUGIN] Inbox not open, skipping check");
    return;
  }

  // Prevent overlapping email processing
  if (isProcessingEmails) {
    console.log("[EMAIL PLUGIN] Already processing emails, skipping check");
    return;
  }

  isProcessingEmails = true;

  // Search for emails SINCE the last processed timestamp
  // Add a small buffer (1 minute) to catch any edge cases
  const lastProcessedDate = new Date(currentState.lastProcessedTimestamp);
  const searchDate = new Date(lastProcessedDate.getTime() - 60000); // 1 minute buffer
  const dateStr = formatDateForImap(searchDate);

  console.log(
    `[EMAIL PLUGIN] Searching for emails since ${dateStr} (last processed: ${currentState.lastProcessedTimestamp})`,
  );

  imapConnection.search([["SINCE", dateStr]], (err: Error | null, results: number[]) => {
    if (err) {
      console.error("[EMAIL PLUGIN] Email search error:", err);
      isProcessingEmails = false;
      return;
    }

    if (!results || results.length === 0) {
      console.log("[EMAIL PLUGIN] No new emails found");
      isProcessingEmails = false;
      return;
    }

    console.log(`[EMAIL PLUGIN] Found ${results.length} email(s) since ${dateStr}`);

    const fetch = imapConnection!.fetch(results, { bodies: "", markSeen: false });

    fetch.on("message", (msg: any) => {
      let uid: number | null = null;

      // Capture the UID from message attributes
      msg.on("attributes", (attrs: any) => {
        uid = attrs.uid;
      });

      msg.on("body", async (stream: NodeJS.ReadableStream) => {
        try {
          const parsed = await simpleParser(stream);

          const from = parsed.from?.value?.[0]?.address || "";
          const fromEmail = extractEmail(from);
          const subject = parsed.subject || "";
          const body = parsed.text || parsed.html || "";
          const messageId = parsed.messageId || "";

          // Skip if already processed
          if (isMessageProcessed(messageId)) {
            console.log(`[EMAIL PLUGIN] Skipping already processed: ${messageId}`);
            return;
          }

          console.log(`[EMAIL PLUGIN] Checking: from=${fromEmail}, subject="${subject}"`);

          // Check if sender is allowed
          if (!isSenderAllowed(fromEmail)) {
            console.log(`[EMAIL PLUGIN] ✗ Ignoring email from unauthorized sender: ${fromEmail}`);
            if (allowedSenders.length > 0) {
              console.log(`[EMAIL PLUGIN] Allowed senders: ${allowedSenders.join(", ")}`);
            }
            return;
          }

          console.log(`[EMAIL PLUGIN] ✓ ACCEPTED email from: ${fromEmail}`);
          console.log(`[EMAIL PLUGIN] Subject: ${subject}`);
          console.log(`[EMAIL PLUGIN] Message-ID: ${messageId}`);
          console.log(`[EMAIL PLUGIN] UID: ${uid}`);
          console.log(`[EMAIL PLUGIN] Date: ${parsed.date?.toISOString()}`);

          // Mark message ID as processed immediately to prevent duplicate processing
          markMessageIdAsProcessed(messageId);

          // Call the handler (async)
          if (messageHandler && uid !== null) {
            try {
              await messageHandler(from, fromEmail, subject, body, messageId, uid);

              // Update timestamp after successful processing
              markMessageAsProcessed(messageId);

              // Mark email as \Seen after successful processing
              imapConnection!.addFlags(uid, ["\\Seen"], (err: Error | null) => {
                if (err) {
                  console.error(`[EMAIL PLUGIN] Failed to mark email as seen:`, err);
                } else {
                  console.log(`[EMAIL PLUGIN] ✓ Marked UID ${uid} as seen`);
                }
              });

              // Clean up old Message-IDs periodically
              cleanupOldMessageIds();
            } catch (error) {
              console.error(`[EMAIL PLUGIN] ✗ Error processing email from ${fromEmail}:`, error);
              // Remove from processed list so it can be retried
              const index = currentState.processedMessageIds.indexOf(messageId);
              if (index > -1) {
                currentState.processedMessageIds.splice(index, 1);
                saveState();
              }
            }
          }
        } catch (err) {
          console.error("[EMAIL PLUGIN] Email parse error:", err);
        }
      });
    });

    fetch.on("error", (err: Error) => {
      console.error("[EMAIL PLUGIN] Email fetch error:", err);
    });

    fetch.on("end", () => {
      console.log("[EMAIL PLUGIN] Email check complete");
      isProcessingEmails = false;
    });
  });
}

export function startEmail(
  config: EmailConfig,
  handler: (
    from: string,
    fromEmail: string,
    subject: string,
    body: string,
    messageId: string,
    uid: number,
  ) => Promise<void>,
): void {
  console.error("[EMAIL PLUGIN] startEmail called!");

  // Reset state flags in case this is a restart
  isInboxOpen = false;
  isProcessingEmails = false;

  // Load persistent state
  loadState();

  currentConfig = config;
  messageHandler = handler;
  allowedSenders = (config.allowedSenders || []).map((email) => email.trim().toLowerCase());

  // Log allowed senders configuration
  if (allowedSenders.length > 0) {
    console.error(
      `[EMAIL PLUGIN] Restricting to ${allowedSenders.length} allowed sender(s): ${allowedSenders.join(", ")}`,
    );
  } else {
    console.error(`[EMAIL PLUGIN] Accepting emails from all senders`);
  }

  imapConnection = createImapConnection(config);
  smtpTransporter = createSmtpTransporter(config);

  console.error(`[EMAIL PLUGIN] Connecting to IMAP server ${config.imap.host}:${config.imap.port}`);

  imapConnection.once("ready", () => {
    console.error("[EMAIL PLUGIN] IMAP connection ready!");
    openInbox((err) => {
      if (err) {
        console.error("Error opening inbox:", err);
        return;
      }

      // Initial check
      checkEmail();

      // Set up interval to check for new emails
      const interval = (config.checkInterval || 30) * 1000;
      checkTimer = setInterval(checkEmail, interval);
    });
  });

  imapConnection.once("error", (err) => {
    console.error("IMAP connection error:", err);
  });

  imapConnection.connect();
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<boolean> {
  if (!smtpTransporter) {
    console.error("SMTP transporter not initialized");
    return false;
  }

  try {
    const mailOptions: nodemailer.MailOptions = {
      from: currentConfig?.smtp.user,
      to: to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      text: body,
    };

    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = inReplyTo;
    }

    await smtpTransporter.sendMail(mailOptions);
    console.log(`Email sent to ${to}`);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
}

export function stopEmail(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  if (imapConnection) {
    imapConnection.end();
    imapConnection = null;
  }

  if (smtpTransporter) {
    smtpTransporter.close();
    smtpTransporter = null;
  }

  currentConfig = null;
  isInboxOpen = false;
  isProcessingEmails = false;
  messageHandler = null;
  allowedSenders = [];
  // Don't clear currentState, it should persist
}

export function getAllowedSenders(): string[] {
  return [...allowedSenders];
}

export function getState(): EmailProcessorState {
  return { ...currentState };
}
