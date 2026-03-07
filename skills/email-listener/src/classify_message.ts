/**
 * Email Listener Skill - Message Classification Module
 *
 * Classifies incoming emails as command, normal, unauthorized, or confirmation.
 */

import type { ParsedEmail, ClassifiedMessage, MessageType, EmailListenerConfig } from "./types.js";
import { logger } from "./logger.js";

const COMMAND_PREFIX = "TIM:";

/**
 * Classify an email message
 */
export function classifyMessage(
  email: ParsedEmail,
  config: EmailListenerConfig
): ClassifiedMessage {
  // Check if sender is authorized
  const isAuthorized = isAuthorizedSender(email.sender, config.security.allowedSenders);

  if (!isAuthorized) {
    logger.warn("Unauthorized sender", { sender: email.sender });
    return {
      type: "unauthorized",
      email,
    };
  }

  // Check if this is a confirmation response
  if (isConfirmationResponse(email, config)) {
    return {
      type: "confirmation",
      email,
    };
  }

  // Check if this is a command
  const command = extractCommand(email);

  if (command) {
    // Check if command requires confirmation
    const requiresConfirmation = config.security.requireConfirmation.includes(command.name);

    if (requiresConfirmation) {
      logger.info("Command requires confirmation", { command: command.name, sender: email.sender });
      return {
        type: "command",
        email,
        command: command.name,
        args: command.args,
      };
    }

    return {
      type: "command",
      email,
      command: command.name,
      args: command.args,
    };
  }

  // Not a command - check if freeform mode is enabled
  if (config.agent.enableFreeform) {
    logger.info("Freeform message - forwarding to agent", { sender: email.sender });
    return {
      type: "freeform",
      email,
    };
  }

  // Not a command - normal email
  return {
    type: "normal",
    email,
  };
}

/**
 * Check if sender is in the allowed list
 */
function isAuthorizedSender(sender: string, allowedSenders: string[]): boolean {
  if (allowedSenders.length === 0) {
    // No allowlist configured - allow all (for development)
    return true;
  }

  const senderLower = sender.toLowerCase();
  return allowedSenders.some((allowed) => senderLower === allowed.toLowerCase());
}

/**
 * Extract command from email
 */
function extractCommand(
  email: ParsedEmail
): { name: string; args: string[] } | null {
  // Check subject first
  const subjectCommand = parseCommandFromText(email.subject);
  if (subjectCommand) {
    return subjectCommand;
  }

  // Check body
  const bodyCommand = parseCommandFromText(email.body);
  if (bodyCommand) {
    return bodyCommand;
  }

  return null;
}

/**
 * Parse command from text (subject or body)
 */
function parseCommandFromText(text: string): { name: string; args: string[] } | null {
  if (!text) return null;

  // Look for TIM: prefix
  const trimmed = text.trim();

  if (!trimmed.toUpperCase().startsWith(COMMAND_PREFIX)) {
    return null;
  }

  // Extract command
  const commandPart = trimmed.substring(COMMAND_PREFIX.length).trim();

  if (!commandPart) {
    return null;
  }

  // Parse command name and arguments
  const parts = commandPart.split(/\s+/);
  const commandName = parts[0].toUpperCase();
  const args = parts.slice(1);

  // Validate command name
  if (!isValidCommandName(commandName)) {
    logger.warn("Invalid command name", { commandName });
    return null;
  }

  return {
    name: commandName,
    args,
  };
}

/**
 * Validate command name
 */
function isValidCommandName(name: string): boolean {
  // Only allow alphanumeric commands
  return /^[A-Z0-9_]+$/.test(name);
}

/**
 * Check if this is a confirmation response
 */
function isConfirmationResponse(email: ParsedEmail, config: EmailListenerConfig): boolean {
  // Check subject for confirmation keywords
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase();

  // Look for confirmation keywords
  const confirmKeywords = ["confirm", "yes", "approve", "execute", "proceed"];

  const hasConfirmKeyword = confirmKeywords.some(
    (keyword) => subject.includes(keyword) || body.includes(keyword)
  );

  if (!hasConfirmKeyword) {
    return false;
  }

  // Check if there's a pending confirmation for this sender
  // This is handled by the main listener - we just check the keyword

  return true;
}

/**
 * Get risk level for a command
 */
export function getCommandRisk(command: string): "safe" | "medium" | "high" {
  const highRisk = ["DELETE", "RESTART", "SHUTDOWN", "REBOOT", "DROP", "TRUNCATE", "RM_RF"];
  const mediumRisk = ["UPDATE", "UPGRADE", "INSTALL", "CREATE", "MODIFY", "WRITE"];

  const commandUpper = command.toUpperCase();

  if (highRisk.includes(commandUpper)) {
    return "high";
  }

  if (mediumRisk.includes(commandUpper)) {
    return "medium";
  }

  return "safe";
}

/**
 * Get display name for message type
 */
export function getMessageTypeName(type: MessageType): string {
  const names: Record<MessageType, string> = {
    command: "Command",
    normal: "Normal",
    unauthorized: "Unauthorized",
    confirmation: "Confirmation",
    freeform: "Freeform",
  };

  return names[type];
}
