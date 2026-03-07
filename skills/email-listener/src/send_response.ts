/**
 * Email Listener Skill - Send Response Module
 *
 * Sends email responses back to the sender.
 * Supports both SMTP (traditional) and AgentMail API.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailResponse, CommandResult, EmailListenerConfig } from "./types.js";
import { logger } from "./logger.js";
import { sendEmailViaAgentMail } from "./agentmail-polling.js";

let transporter: Transporter | null = null;

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
 * Send an email response
 */
export async function sendResponse(
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
 * Try to send email via AgentMail, with SMTP fallback
 */
async function sendViaAgentMailOrSmtp(
  to: string,
  subject: string,
  body: string,
  config: EmailListenerConfig["imap"]
): Promise<boolean> {
  // Try AgentMail first if configured
  if (process.env.AGENTMAIL_API_KEY) {
    try {
      await sendEmailViaAgentMail(to, subject, body);
      return true;
    } catch (error) {
      logger.warn("AgentMail send failed, falling back to SMTP", {
        error: String(error),
        to,
      });
      // Fall through to SMTP fallback
    }
  }

  // Fall back to SMTP
  return sendResponse(config, {
    to,
    subject,
    body,
  });
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
  return sendResponse(config, {
    to: sender,
    subject: `Unauthorized: ${originalSubject}`,
    body: `Your email was not processed because the sender is not authorized.\n\nIf you believe this is an error, please contact the administrator.`,
  });
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
