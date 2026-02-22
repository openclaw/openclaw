import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

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
  maxAttachmentSize?: number; // Maximum attachment size in bytes (default: 10MB)
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId?: string;
}

interface EmailProcessorState {
  lastProcessedTimestamp: string; // ISO 8601 format
  processedMessageIds: string[]; // List of Message-IDs that have been processed
  failedAttempts: Record<string, number>; // MessageId -> retry count
}

const MAX_RETRY_ATTEMPTS = 3;

function getStateFilePath(accountId: string): string {
  return path.join(os.homedir(), ".openclaw", "extensions", "email", `state-${accountId}.json`);
}

// Per-account runtime state
class EmailAccountRuntime {
  private accountId: string;
  private config: EmailConfig;
  private messageHandler: (
    from: string,
    fromEmail: string,
    subject: string,
    body: string,
    messageId: string,
    uid: number,
    attachments: EmailAttachment[],
  ) => Promise<void>;

  private imapConnection: Imap | null = null;
  private smtpTransporter: nodemailer.Transporter | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isInboxOpen = false;
  private allowedSenders: string[] = [];
  private state: EmailProcessorState;
  private stateFilePath: string;
  private messagesInProgress: Set<string> = new Set(); // Track messages currently being processed
  private senderQueues: Map<string, Promise<void>> = new Map(); // Per-sender processing queues

  constructor(
    accountId: string,
    config: EmailConfig,
    handler: (
      from: string,
      fromEmail: string,
      subject: string,
      body: string,
      messageId: string,
      uid: number,
      attachments: EmailAttachment[],
    ) => Promise<void>,
  ) {
    this.accountId = accountId;
    this.config = config;
    this.messageHandler = handler;
    this.stateFilePath = getStateFilePath(accountId);
    this.state = {
      lastProcessedTimestamp: new Date(0).toISOString(),
      processedMessageIds: [],
      failedAttempts: {},
    };
    this.allowedSenders = (config.allowedSenders || []).map((email) => email.trim().toLowerCase());
  }

  // Load state from file
  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, "utf-8");
        this.state = JSON.parse(data);
        console.log(
          `[EMAIL PLUGIN] [${this.accountId}] Loaded state: lastProcessed=${this.state.lastProcessedTimestamp}, processedCount=${this.state.processedMessageIds.length}`,
        );
      } else {
        console.log(`[EMAIL PLUGIN] [${this.accountId}] No existing state file, starting fresh`);
      }
    } catch (error) {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] Error loading state file:`, error);
      console.log(`[EMAIL PLUGIN] [${this.accountId}] Starting with empty state`);
    }
  }

  // Save state to file
  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] Error saving state file:`, error);
    }
  }

  // Check if a message has been processed
  private isMessageProcessed(messageId: string): boolean {
    return this.state.processedMessageIds.includes(messageId);
  }

  // Check if message has exceeded retry limit
  private hasExceededRetryLimit(messageId: string): boolean {
    const attempts = this.state.failedAttempts[messageId] || 0;
    return attempts >= MAX_RETRY_ATTEMPTS;
  }

  // Mark a message as being retried
  private incrementRetryCount(messageId: string): void {
    this.state.failedAttempts[messageId] = (this.state.failedAttempts[messageId] || 0) + 1;
    this.saveState();
  }

  // Mark a message ID as processed (without updating timestamp)
  private markMessageIdAsProcessed(messageId: string): void {
    if (!this.state.processedMessageIds.includes(messageId)) {
      this.state.processedMessageIds.push(messageId);
      // Clear retry count on successful processing
      delete this.state.failedAttempts[messageId];
      this.saveState();
    }
  }

  // Mark a message as processed and update timestamp
  private markMessageAsProcessed(messageId: string): void {
    // Always update timestamp when processing completes
    this.state.lastProcessedTimestamp = new Date().toISOString();
    if (!this.state.processedMessageIds.includes(messageId)) {
      this.state.processedMessageIds.push(messageId);
    }
    // Clear retry count on successful processing
    delete this.state.failedAttempts[messageId];
    this.saveState();
  }

  // Clean up old Message-IDs (keep only last 1000 to prevent file from growing too large)
  private cleanupOldMessageIds(): void {
    if (this.state.processedMessageIds.length > 1000) {
      this.state.processedMessageIds = this.state.processedMessageIds.slice(-1000);
      // Also cleanup old retry attempts
      const recentIds = new Set(this.state.processedMessageIds);
      for (const messageId of Object.keys(this.state.failedAttempts)) {
        if (!recentIds.has(messageId)) {
          delete this.state.failedAttempts[messageId];
        }
      }
      this.saveState();
    }
  }

  private extractEmail(from: string): string {
    // Extract email from "Name <email>" format
    const emailMatch = from.match(/<([^>]+)>/);
    return emailMatch ? emailMatch[1].trim().toLowerCase() : from.trim().toLowerCase();
  }

  /**
   * Check if sender is in the allowed list.
   *
   * SECURITY WARNING: This checks the "From" email address from the email headers,
   * which can be forged by attackers. This provides basic filtering but NOT security.
   *
   * For production security, ensure your IMAP server:
   * - Verifies DKIM signatures
   * - Checks SPF records
   * - Enforces DMARC policies
   * - Rejects unauthenticated emails
   */
  private isSenderAllowed(fromEmail: string): boolean {
    if (!this.allowedSenders || this.allowedSenders.length === 0) {
      return true; // No restrictions
    }
    return this.allowedSenders.some((allowed) => fromEmail === allowed.toLowerCase());
  }

  private createImapConnection(): Imap {
    return new Imap({
      user: this.config.imap.user,
      password: this.config.imap.password,
      host: this.config.imap.host,
      port: this.config.imap.port,
      tls: this.config.imap.secure,
    });
  }

  private createSmtpTransporter(): nodemailer.Transporter {
    const transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.password,
      },
    } as any);

    // Set timeout via socket option
    return transporter;
  }

  private openInbox(cb: (err: Error | null, box?: any) => void): void {
    if (!this.imapConnection) {
      cb(new Error("IMAP connection not initialized"));
      return;
    }
    this.imapConnection.openBox("INBOX", (err, box) => {
      if (!err) {
        this.isInboxOpen = true;
      }
      cb(err, box);
    });
  }

  // Process email with per-sender queueing
  // Emails from different senders are processed in parallel
  // Emails from the same sender are processed sequentially
  private async processEmailWithSenderQueue(
    fromEmail: string,
    processor: () => Promise<void>,
  ): Promise<void> {
    // Get or create the promise chain for this sender
    const currentQueue = this.senderQueues.get(fromEmail) || Promise.resolve();

    // Chain this email's processing to the sender's queue
    const newQueue = currentQueue.then(processor).catch((error) => {
      // Log error but don't break the chain for other emails from same sender
      console.error(
        `[EMAIL PLUGIN] [${this.accountId}] Error in sender queue for ${fromEmail}:`,
        error,
      );
    });

    this.senderQueues.set(fromEmail, newQueue);

    // Clean up completed queues periodically
    newQueue.finally(() => {
      // Only clean up if this is still the current queue for this sender
      if (this.senderQueues.get(fromEmail) === newQueue) {
        // Keep the resolved promise in the map for a short time
        // to handle rapid successive emails
        setTimeout(() => {
          if (this.senderQueues.get(fromEmail) === newQueue) {
            this.senderQueues.delete(fromEmail);
          }
        }, 5000);
      }
    });

    return newQueue;
  }

  private formatDateForImap(date: Date): string {
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

  private checkEmail(): void {
    if (!this.imapConnection) return;

    // Check if inbox is open before searching
    if (!this.isInboxOpen) {
      console.log(`[EMAIL PLUGIN] [${this.accountId}] Inbox not open, skipping check`);
      return;
    }

    // Search for emails SINCE the last processed timestamp
    // Add a small buffer (1 minute) to catch any edge cases
    const lastProcessedDate = new Date(this.state.lastProcessedTimestamp);
    const searchDate = new Date(lastProcessedDate.getTime() - 60000); // 1 minute buffer
    const dateStr = this.formatDateForImap(searchDate);

    console.log(
      `[EMAIL PLUGIN] [${this.accountId}] Searching for emails since ${dateStr} (last processed: ${this.state.lastProcessedTimestamp})`,
    );

    this.imapConnection.search([["SINCE", dateStr]], (err: Error | null, results: number[]) => {
      if (err) {
        console.error(`[EMAIL PLUGIN] [${this.accountId}] Email search error:`, err);
        return;
      }

      if (!results || results.length === 0) {
        console.log(`[EMAIL PLUGIN] [${this.accountId}] No new emails found`);
        return;
      }

      console.log(
        `[EMAIL PLUGIN] [${this.accountId}] Found ${results.length} email(s) since ${dateStr}`,
      );

      const fetch = this.imapConnection!.fetch(results, { bodies: "", markSeen: false });

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
            const fromEmail = this.extractEmail(from);
            const subject = parsed.subject || "";
            const body = parsed.text || parsed.html || "";
            const messageId = parsed.messageId || "";

            // Extract attachments
            const attachments: EmailAttachment[] = [];
            if (parsed.attachments && parsed.attachments.length > 0) {
              for (const att of parsed.attachments) {
                attachments.push({
                  filename: att.filename || "unknown",
                  contentType: att.contentType,
                  size: att.content.length,
                  content: att.content,
                  contentId: (att as any).contentId, // Type cast as mailparser types may not include this
                });
              }
            }

            // Skip if already processed
            if (this.isMessageProcessed(messageId)) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] Skipping already processed: ${messageId}`,
              );
              return;
            }

            // Skip if currently being processed (in-memory check)
            if (this.messagesInProgress.has(messageId)) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] Skipping message currently being processed: ${messageId}`,
              );
              return;
            }

            // Skip if exceeded retry limit
            if (this.hasExceededRetryLimit(messageId)) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] Skipping message that exceeded retry limit: ${messageId}`,
              );
              this.markMessageIdAsProcessed(messageId);
              return;
            }

            console.log(
              `[EMAIL PLUGIN] [${this.accountId}] Checking: from=${fromEmail}, subject="${subject}"`,
            );

            // Check if sender is allowed
            if (!this.isSenderAllowed(fromEmail)) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] ✗ Ignoring email from unauthorized sender: ${fromEmail}`,
              );
              if (this.allowedSenders.length > 0) {
                console.log(
                  `[EMAIL PLUGIN] [${this.accountId}] Allowed senders: ${this.allowedSenders.join(", ")}`,
                );
              }
              return;
            }

            console.log(`[EMAIL PLUGIN] [${this.accountId}] ✓ ACCEPTED email from: ${fromEmail}`);
            console.log(`[EMAIL PLUGIN] [${this.accountId}] Subject: ${subject}`);
            console.log(`[EMAIL PLUGIN] [${this.accountId}] Message-ID: ${messageId}`);
            console.log(`[EMAIL PLUGIN] [${this.accountId}] UID: ${uid}`);
            console.log(`[EMAIL PLUGIN] [${this.accountId}] Date: ${parsed.date?.toISOString()}`);
            console.log(`[EMAIL PLUGIN] [${this.accountId}] Attachments: ${attachments.length}`);

            // Check attachment sizes
            const maxAttachmentSize = this.config.maxAttachmentSize || 10 * 1024 * 1024; // Default: 10MB
            const oversizedAttachments = attachments.filter((att) => att.size > maxAttachmentSize);

            if (oversizedAttachments.length > 0) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] ⚠️  Oversized attachments detected: ${oversizedAttachments.map((a) => `${a.filename} (${(a.size / 1024 / 1024).toFixed(2)}MB)`).join(", ")}`,
              );

              // Mark as in-progress to prevent duplicate processing
              this.messagesInProgress.add(messageId);

              // Process through sender queue to send rejection message
              if (uid !== null) {
                const messageUid = uid;
                this.processEmailWithSenderQueue(fromEmail, async () => {
                  try {
                    // Send rejection email
                    const rejectionMessage = `Your email contains attachments that exceed the size limit.\n\nOversized attachment(s):\n${oversizedAttachments.map((a) => `- ${a.filename} (${(a.size / 1024 / 1024).toFixed(2)}MB, limit: ${(maxAttachmentSize / 1024 / 1024).toFixed(2)}MB)`).join("\n")}\n\nPlease resend your email with smaller attachments or use a file sharing service.\n\nYour request has not been processed.`;

                    await this.sendRejectionEmail(fromEmail, subject, rejectionMessage);

                    // Mark as processed after sending rejection
                    this.markMessageAsProcessed(messageId);

                    // Mark email as \Seen
                    this.imapConnection!.addFlags(messageUid, ["\\Seen"], (err: Error | null) => {
                      if (err) {
                        console.error(
                          `[EMAIL PLUGIN] [${this.accountId}] Failed to mark email as seen:`,
                          err,
                        );
                      } else {
                        console.log(
                          `[EMAIL PLUGIN] [${this.accountId}] ✓ Marked UID ${messageUid} as seen (oversized attachment)`,
                        );
                      }
                    });
                  } catch (error) {
                    console.error(
                      `[EMAIL PLUGIN] [${this.accountId}] Error sending rejection email:`,
                      error,
                    );
                  } finally {
                    this.messagesInProgress.delete(messageId);
                  }
                });
              }
              return; // Skip normal processing
            }

            // Log attachments info if present
            if (attachments.length > 0) {
              console.log(
                `[EMAIL PLUGIN] [${this.accountId}] Attachment details: ${attachments.map((a) => `${a.filename} (${(a.size / 1024).toFixed(2)}KB, ${a.contentType})`).join(", ")}`,
              );
            }

            // Mark as in-progress to prevent duplicate processing during handler execution
            this.messagesInProgress.add(messageId);

            // Process email through per-sender queue
            // This ensures emails from the same sender are processed sequentially
            // while emails from different senders are processed in parallel
            if (uid !== null) {
              const messageUid = uid; // Capture uid to ensure it's not null in closure
              this.processEmailWithSenderQueue(fromEmail, async () => {
                try {
                  await this.messageHandler(
                    from,
                    fromEmail,
                    subject,
                    body,
                    messageId,
                    messageUid,
                    attachments,
                  );

                  // Mark as processed only after successful handler completion
                  this.markMessageAsProcessed(messageId);

                  // Mark email as \Seen after successful processing
                  if (this.imapConnection) {
                    this.imapConnection.addFlags(messageUid, ["\\Seen"], (err: Error | null) => {
                      if (err) {
                        console.error(
                          `[EMAIL PLUGIN] [${this.accountId}] Failed to mark email as seen:`,
                          err,
                        );
                      } else {
                        console.log(
                          `[EMAIL PLUGIN] [${this.accountId}] ✓ Marked UID ${messageUid} as seen`,
                        );
                      }
                    });
                  }

                  // Clean up old Message-IDs periodically
                  this.cleanupOldMessageIds();
                } catch (error) {
                  console.error(
                    `[EMAIL PLUGIN] [${this.accountId}] ✗ Error processing email from ${fromEmail}:`,
                    error,
                  );
                  // Increment retry count instead of removing from processed list
                  this.incrementRetryCount(messageId);
                } finally {
                  // Always remove from in-progress set
                  this.messagesInProgress.delete(messageId);
                }
              }).catch((err) => {
                // This should not happen as errors are caught inside the processor
                console.error(
                  `[EMAIL PLUGIN] [${this.accountId}] Unexpected error in sender queue:`,
                  err,
                );
              });
            }
          } catch (err) {
            console.error(`[EMAIL PLUGIN] [${this.accountId}] Email parse error:`, err);
          }
        });
      });

      fetch.on("error", (err: Error) => {
        console.error(`[EMAIL PLUGIN] [${this.accountId}] Email fetch error:`, err);
      });

      fetch.on("end", () => {
        console.log(`[EMAIL PLUGIN] [${this.accountId}] Email check complete`);
      });
    });
  }

  public start(): void {
    console.error(`[EMAIL PLUGIN] [${this.accountId}] startEmail called!`);

    // Reset state flags in case this is a restart
    this.isInboxOpen = false;

    // Load persistent state
    this.loadState();

    // Log allowed senders configuration
    if (this.allowedSenders.length > 0) {
      console.error(
        `[EMAIL PLUGIN] [${this.accountId}] Restricting to ${this.allowedSenders.length} allowed sender(s): ${this.allowedSenders.join(", ")}`,
      );
    } else {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] Accepting emails from all senders`);
    }

    this.imapConnection = this.createImapConnection();
    this.smtpTransporter = this.createSmtpTransporter();

    console.error(
      `[EMAIL PLUGIN] [${this.accountId}] Connecting to IMAP server ${this.config.imap.host}:${this.config.imap.port}`,
    );

    this.imapConnection.once("ready", () => {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] IMAP connection ready!`);
      this.openInbox((err) => {
        if (err) {
          console.error(`[EMAIL PLUGIN] [${this.accountId}] Error opening inbox:`, err);
          return;
        }

        // Initial check
        this.checkEmail();

        // Set up interval to check for new emails
        const interval = (this.config.checkInterval || 30) * 1000;
        this.checkTimer = setInterval(() => this.checkEmail(), interval);
      });
    });

    this.imapConnection.once("error", (err) => {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] IMAP connection error:`, err);
    });

    this.imapConnection.connect();
  }

  public async sendEmail(
    to: string,
    subject: string,
    body: string,
    inReplyTo?: string,
    attachments?: Array<{ path: string; filename?: string; contentType?: string }>,
  ): Promise<boolean> {
    if (!this.smtpTransporter) {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] SMTP transporter not initialized`);
      return false;
    }

    try {
      const mailOptions: nodemailer.MailOptions = {
        from: this.config.smtp.user,
        to: to,
        subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
        text: body,
      };

      if (inReplyTo) {
        mailOptions.inReplyTo = inReplyTo;
        mailOptions.references = inReplyTo;
      }

      // Add attachments if provided
      if (attachments && attachments.length > 0) {
        (mailOptions as any).attachments = attachments.map((att) => ({
          path: att.path,
          filename: att.filename || att.path.split("/").pop() || "attachment",
          contentType: att.contentType,
        }));
        console.log(
          `[EMAIL PLUGIN] [${this.accountId}] Sending email with ${attachments.length} attachment(s)`,
        );
      }

      await this.smtpTransporter.sendMail(mailOptions);
      console.log(`[EMAIL PLUGIN] [${this.accountId}] Email sent to ${to}`);
      return true;
    } catch (error) {
      console.error(`[EMAIL PLUGIN] [${this.accountId}] Error sending email:`, error);
      return false;
    }
  }

  private async sendRejectionEmail(to: string, subject: string, body: string): Promise<void> {
    console.log(
      `[EMAIL PLUGIN] [${this.accountId}] Sending rejection email to ${to} for oversized attachments`,
    );
    const success = await this.sendEmail(to, subject, body);
    if (!success) {
      throw new Error("Failed to send rejection email");
    }
  }

  public stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.imapConnection) {
      this.imapConnection.end();
      this.imapConnection = null;
    }

    if (this.smtpTransporter) {
      this.smtpTransporter.close();
      this.smtpTransporter = null;
    }

    this.isInboxOpen = false;
    this.senderQueues.clear(); // Clear all sender queues
    this.messagesInProgress.clear(); // Clear in-progress messages
  }

  public getAllowedSenders(): string[] {
    return [...this.allowedSenders];
  }

  public getState(): EmailProcessorState {
    return { ...this.state };
  }
}

// Export a manager that can handle multiple accounts
const accountRuntimes = new Map<string, EmailAccountRuntime>();

export function startEmail(
  accountId: string,
  config: EmailConfig,
  handler: (
    from: string,
    fromEmail: string,
    subject: string,
    body: string,
    messageId: string,
    uid: number,
    attachments: EmailAttachment[],
  ) => Promise<void>,
): void {
  // Stop existing runtime if any
  if (accountRuntimes.has(accountId)) {
    accountRuntimes.get(accountId)?.stop();
  }

  // Create and start new runtime
  const runtime = new EmailAccountRuntime(accountId, config, handler);
  accountRuntimes.set(accountId, runtime);
  runtime.start();
}

export async function sendEmail(
  accountId: string,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
  attachments?: Array<{ path: string; filename?: string; contentType?: string }>,
): Promise<boolean> {
  const runtime = accountRuntimes.get(accountId);
  if (!runtime) {
    console.error(`[EMAIL PLUGIN] No runtime found for account: ${accountId}`);
    return false;
  }
  return runtime.sendEmail(to, subject, body, inReplyTo, attachments);
}

export function stopEmail(accountId: string): void {
  const runtime = accountRuntimes.get(accountId);
  if (runtime) {
    runtime.stop();
    accountRuntimes.delete(accountId);
  }
}

export function getAllowedSenders(accountId: string): string[] {
  const runtime = accountRuntimes.get(accountId);
  return runtime ? runtime.getAllowedSenders() : [];
}

export function getState(accountId: string): EmailProcessorState | null {
  const runtime = accountRuntimes.get(accountId);
  return runtime ? runtime.getState() : null;
}
