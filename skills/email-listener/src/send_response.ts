/**
 * Email Listener Skill - Send Response Module
 *
 * Sends email responses back to the sender.
 * Supports both SMTP (traditional) and AgentMail API.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailResponse, CommandResult, EmailListenerConfig, ConsolidationConfig } from "./types.js";
import { logger } from "./logger.js";
import { sendEmailViaAgentMail } from "./agentmail-polling.js";
import { ResponseQueue } from "./response-queue.js";

let transporter: Transporter | null = null;
let responseQueue: ResponseQueue | null = null;
let consolidationConfig: ConsolidationConfig | null = null;

/**
 * Initialize the SMTP transporter
 */
export async function initializeTransporter(
  config: EmailListenerConfig["imap"]
): Promise<Transporter> {
  logger.info("Initializing SMTP transporter", { host: config.host });

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });

  // Verify connection
  try {
    await transporter.verify();
    logger.info("SMTP transporter verified");
  } catch (error) {
    logger.error("SMTP transporter verification failed", { error: String(error) });
    throw error;
  }

  return transporter;
}

/**
 * Get the transporter instance
 */
export function getTransporter(): Transporter | null {
  return transporter;
}

/**
 * Initialize the response queue for consolidation
 */
export function initializeResponseQueue(
  config: ConsolidationConfig,
  sendFn: (responses: EmailResponse[]) => Promise<void>
): ResponseQueue {
  logger.info("Initializing response queue", {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    maxBatchSize: config.maxBatchSize,
  });

  consolidationConfig = config;
  responseQueue = new ResponseQueue(config);
  responseQueue.start(sendFn);

  return responseQueue;
}

/**
 * Get the response queue instance
 */
export function getResponseQueue(): ResponseQueue | null {
  return responseQueue;
}

/**
 * Send an email response (direct send, bypassing queue)
 */
export async function sendResponseDirect(
  config: EmailListenerConfig["imap"],
  response: EmailResponse
): Promise<boolean> {
  // Initialize transporter if needed
  if (!transporter) {
    await initializeTransporter(config);
  }

  if (!transporter) {
    logger.error("Transporter not initialized");
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: config.user,
      to: response.to,
      subject: response.subject,
      text: response.body,
      inReplyTo: response.inReplyTo,
      references: response.inReplyTo,
      // Add custom header to identify self-generated emails (feedback loop prevention)
      headers: {
        "X-AgentMail-Response": "true",
      },
    });

    logger.info("Email response sent", {
      messageId: info.messageId,
      to: response.to,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send email response", { error: String(error) });
    return false;
  }
}

/**
 * Queue an email response for consolidation
 * Uses the response queue if enabled, otherwise sends directly
 */
export async function queueResponse(
  config: EmailListenerConfig["imap"],
  response: EmailResponse
): Promise<boolean> {
  // If queue is not initialized or disabled, send directly
  if (!responseQueue || !consolidationConfig?.enabled) {
    return sendResponseDirect(config, response);
  }

  // Add to queue
  responseQueue.add(response);
  logger.debug("Response queued for consolidation", {
    to: response.to,
    subject: response.subject,
  });

  return true;
}

/**
 * Send an email response (chooses queue or direct based on config)
 */
export async function sendResponse(
  config: EmailListenerConfig["imap"],
  email: { to: string; subject: string; body: string }
): Promise<boolean> {
  return sendViaAgentMailOrSmtp(email.to, email.subject, email.body, config);
}

/**
 * Try to send email via AgentMail, with SMTP fallback
 * Includes retry logic with exponential backoff for rate limiting
 */
async function sendViaAgentMailOrSmtp(
  to: string,
  subject: string,
  body: string,
  config: EmailListenerConfig["imap"],
  maxRetries: number = 3,
  isUnauthorizedResponse: boolean = false
): Promise<boolean> {
  // For unauthorized responses, don't retry more than once (not critical to notify)
  const effectiveMaxRetries = isUnauthorizedResponse ? 1 : maxRetries;
  
  // Try AgentMail first if configured
  if (process.env.AGENTMAIL_API_KEY) {
    for (let attempt = 0; attempt < effectiveMaxRetries; attempt++) {
      try {
        await sendEmailViaAgentMail(to, subject, body);
        return true;
      } catch (error) {
        const errorStr = String(error);
        const isRateLimit = errorStr.includes("429") || errorStr.includes("Too Many Requests");
        
        // Only retry on rate limit errors, and only if we have retries left
        if (isRateLimit && attempt < effectiveMaxRetries - 1) {
          const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          logger.warn(`AgentMail rate limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${effectiveMaxRetries})`, {
            to,
            subject,
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          logger.warn("AgentMail send failed, falling back to SMTP", {
            error: errorStr,
            to,
            subject,
          });
          break; // Fall through to SMTP
        }
      }
    }
  }

  // Fall back to SMTP with similar retry logic
  for (let attempt = 0; attempt < effectiveMaxRetries; attempt++) {
    try {
      return await sendResponseDirect(config, {
        to,
        subject,
        body,
      });
    } catch (error) {
      const errorStr = String(error);
      const isRateLimit = errorStr.includes("429") || errorStr.includes("Too Many Requests");
      
      if (isRateLimit && attempt < effectiveMaxRetries - 1) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        logger.warn(`SMTP rate limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${effectiveMaxRetries})`, {
          to,
          subject,
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } else {
        logger.error("Failed to send email via SMTP", {
          error: errorStr,
          to,
          subject,
        });
        return false;
      }
    }
  }
  
  return false;
}

/**
 * Send a command result response
 */
export async function sendCommandResult(
  config: EmailListenerConfig["imap"],
  originalEmail: { sender: string; messageId: string; subject: string },
  result: CommandResult
): Promise<boolean> {
  const subject = result.success
    ? `Re: ${originalEmail.subject}`
    : `Error: ${originalEmail.subject}`;

  const body = formatCommandResult(result);

  // Use AgentMail if configured, otherwise fall back to SMTP
  return sendViaAgentMailOrSmtp(originalEmail.sender, subject, body, config);
}

/**
 * Send an authorization error response
 */
export async function sendUnauthorizedResponse(
  config: EmailListenerConfig["imap"],
  sender: string,
  originalSubject: string
): Promise<boolean> {
  // Use AgentMail if configured, otherwise fall back to SMTP
  // For unauthorized responses, limit retries since it's not critical to notify
  if (process.env.AGENTMAIL_API_KEY) {
    try {
      await sendEmailViaAgentMail(
        sender,
        `Unauthorized: ${originalSubject}`,
        `Your email was not processed because the sender is not authorized.\n\nIf you believe this is an error, please contact the administrator.`
      );
      return true;
    } catch (error) {
      logger.warn("Failed to send unauthorized response via AgentMail", {
        error: String(error),
        sender,
      });
      // Don't retry unauthorized responses - just log and move on
      // It's not critical to notify unauthorized senders
    }
  }
  
  // Try SMTP as final fallback, but don't retry on failure
  try {
    return await sendResponseDirect(config, {
      to: sender,
      subject: `Unauthorized: ${originalSubject}`,
      body: `Your email was not processed because the sender is not authorized.\n\nIf you believe this is an error, please contact the administrator.`,
    });
  } catch (error) {
    logger.warn("Failed to send unauthorized response via SMTP", {
      error: String(error),
      sender,
    });
    return false;
  }
}

/**
 * Send a confirmation request
 */
export async function sendConfirmationRequest(
  config: EmailListenerConfig["imap"],
  originalEmail: { sender: string; messageId: string; subject: string },
  command: string,
  args: string[]
): Promise<boolean> {
  const body = `A command you sent requires confirmation before execution:

Command: ${command}
Arguments: ${args.join(" ") || "(none)"}

To confirm and execute this command, reply to this email with:
- Subject: CONFIRM
- Body: yes

To cancel, simply ignore this email.

This confirmation request will expire in 5 minutes.`;

  return sendResponse(config, {
    to: originalEmail.sender,
    subject: `Confirmation Required: ${originalEmail.subject}`,
    body,
    inReplyTo: originalEmail.messageId,
  });
}

/**
 * Format command result for email
 */
function formatCommandResult(result: CommandResult): string {
  let output = result.success ? "Success" : "Failed";
  output += `\n\n${result.message}`;

  if (result.data) {
    output += "\n\nAdditional Information:\n";
    output += formatData(result.data);
  }

  return output;
}

/**
 * Format data object for email
 */
function formatData(data: Record<string, unknown>, indent: string = ""): string {
  let output = "";

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null) {
      output += `${indent}${key}:\n`;
      output += formatData(value as Record<string, unknown>, indent + "  ");
    } else {
      output += `${indent}${key}: ${value}\n`;
    }
  }

  return output;
}

/**
 * Close the transporter
 */
export async function closeTransporter(): Promise<void> {
  // Stop and flush the response queue first
  if (responseQueue) {
    try {
      await responseQueue.flush();
      responseQueue.stop();
      logger.info("Response queue stopped and flushed");
    } catch (error) {
      logger.warn("Error stopping response queue", { error: String(error) });
    } finally {
      responseQueue = null;
      consolidationConfig = null;
    }
  }

  if (transporter) {
    try {
      await transporter.close();
      logger.info("SMTP transporter closed");
    } catch (error) {
      logger.warn("Error closing transporter", { error: String(error) });
    } finally {
      transporter = null;
    }
  }
}
