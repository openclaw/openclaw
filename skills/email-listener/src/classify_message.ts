/**
 * Email Listener Skill - Message Classification Module
 *
 * Classifies incoming emails as command, normal, unauthorized, or confirmation.
 * Also provides inbox management classification (Task, Informational, Human Required, Spam, etc.)
 */

import type { ParsedEmail, ClassifiedMessage, MessageType, EmailListenerConfig } from "./types.js";
import { logger } from "./logger.js";

const COMMAND_PREFIX = "TIM:";

// ============================================================================
// Inbox Management Classification Types
// ============================================================================

/**
 * Inbox category classification for inbox management protocol
 */
export type InboxCategory =
	| "command"
	| "task"
	| "informational"
	| "human_required"
	| "spam"
	| "junk_system_mail"
	| "unclassifiable";

/**
 * Inbox classification result
 */
export interface InboxClassification {
	/** The category this email belongs to */
	category: InboxCategory;
	/** Confidence score 0-1 */
	confidence: number;
	/** Reason for classification */
	reason: string;
	/** Suggested action */
	suggestedAction: InboxAction;
}

/**
 * Action to take based on classification
 */
export type InboxAction =
	| "execute_command"
	| "create_task"
	| "archive"
	| "flag_for_human"
	| "move_to_spam"
	| "move_to_review"
	| "delete";

// ============================================================================
// Command Prefix Support (TIM, CHEWIE, FRANKOS)
// ============================================================================

/**
 * Supported agent command prefixes
 */
const AGENT_PREFIXES = ["TIM:", "CHEWIE:", "FRANKOS:"];

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

// ============================================================================
// Inbox Management Classification
// ============================================================================

/**
 * Classify an email for inbox management purposes
 * Uses the Agent Email Inbox Management Protocol categories
 */
export function classifyForInbox(email: ParsedEmail): InboxClassification {
	// 1. Check for agent command prefixes (TIM:, CHEWIE:, FRANKOS:)
	const agentCommand = extractAgentCommand(email);
	if (agentCommand) {
		return {
			category: "command",
			confidence: 0.95,
			reason: `Agent command detected: ${agentCommand.name}`,
			suggestedAction: "execute_command",
		};
	}

	// 2. Check for task-like content
	if (isTaskEmail(email)) {
		return {
			category: "task",
			confidence: 0.8,
			reason: "Email contains task-related keywords or action items",
			suggestedAction: "create_task",
		};
	}

	// 3. Check for spam indicators
	if (isSpam(email)) {
		return {
			category: "spam",
			confidence: 0.9,
			reason: "Email matches known spam patterns",
			suggestedAction: "move_to_spam",
		};
	}

	// 4. Check for junk/system mail
	if (isJunkSystemMail(email)) {
		return {
			category: "junk_system_mail",
			confidence: 0.85,
			reason: "Automated system notification or receipt",
			suggestedAction: "archive",
		};
	}

	// 5. Check for personal/human required
	if (isHumanRequired(email)) {
		return {
			category: "human_required",
			confidence: 0.7,
			reason: "Personal email requiring human response",
			suggestedAction: "flag_for_human",
		};
	}

	// 6. Check for informational (newsletters, notifications)
	if (isInformational(email)) {
		return {
			category: "informational",
			confidence: 0.75,
			reason: "Newsletter, notification, or informational content",
			suggestedAction: "archive",
		};
	}

	// 7. Default to unclassifiable
	return {
		category: "unclassifiable",
		confidence: 0.5,
		reason: "Could not determine category",
		suggestedAction: "move_to_review",
	};
}

/**
 * Extract agent command from email (supports TIM:, CHEWIE:, FRANKOS:)
 */
function extractAgentCommand(
	email: ParsedEmail
): { name: string; args: string[] } | null {
	const subjectCommand = parseAgentCommand(email.subject);
	if (subjectCommand) return subjectCommand;

	const bodyCommand = parseAgentCommand(email.body);
	if (bodyCommand) return bodyCommand;

	return null;
}

/**
 * Parse agent command from text
 */
function parseAgentCommand(
	text: string
): { name: string; args: string[] } | null {
	if (!text) return null;

	const trimmed = text.trim();

	for (const prefix of AGENT_PREFIXES) {
		if (trimmed.toUpperCase().startsWith(prefix)) {
			const commandPart = trimmed.substring(prefix.length).trim();

			if (!commandPart) return null;

			const parts = commandPart.split(/\s+/);
			const commandName = parts[0].toUpperCase();
			const args = parts.slice(1);

			return {
				name: commandName,
				args,
			};
		}
	}

	return null;
}

/**
 * Check if email contains task-like content
 */
function isTaskEmail(email: ParsedEmail): boolean {
	const taskKeywords = [
		"please",
		"need to",
		"should",
		"must",
		"action required",
		"todo",
		"task:",
		"follow up",
		"deadline",
		"due:",
		"complete",
		"review",
		"investigate",
		"update me",
	];

	const content = `${email.subject} ${email.body}`.toLowerCase();

	return taskKeywords.some((keyword) => content.includes(keyword));
}

/**
 * Check if email is spam
 */
function isSpam(email: ParsedEmail): boolean {
	const spamIndicators = [
		"you have won",
		"congratulations",
		"click here",
		"free money",
		"lottery",
		"nigerian prince",
		"verify your account",
		"suspend.*account",
		"urgent.*action",
		"act now",
	];

	const content = `${email.subject} ${email.body}`.toLowerCase();

	// Check sender patterns
	const senderLower = email.sender.toLowerCase();
	const suspiciousSenders = ["noreply@", "no-reply@", "support@"];
	const hasSuspiciousSender = suspiciousSenders.some((s) => senderLower.includes(s));

	// Check for spam patterns
	const hasSpamPattern = spamIndicators.some((pattern) => {
		const regex = new RegExp(pattern, "i");
		return regex.test(content);
	});

	return hasSpamPattern || (hasSuspiciousSender && content.includes("click"));
}

/**
 * Check if email is junk/system mail (receipts, confirmations, etc.)
 */
function isJunkSystemMail(email: ParsedEmail): boolean {
	const systemMailIndicators = [
		/^order\s*confirmation/i,
		/^receipt/i,
		/^shipping\s*notification/i,
		/^delivery\s*update/i,
		/^password\s*reset/i,
		/^verification\s*code/i,
		/^welcome\s*to/i,
		/^your\s*account/i,
		/receipt/i,
		/invoice/i,
		/order.*#\d+/
	];

	const senderLower = email.sender.toLowerCase();
	const systemSenders = [
		"no-reply@",
		"noreply@",
		"notifications@",
		"automated@",
		"system@",
		"donotreply@",
	];

	const hasSystemSender = systemSenders.some((s) => senderLower.includes(s));
	const hasSystemSubject = systemMailIndicators.some((pattern) => {
		if (typeof pattern === "string") {
			return email.subject.toLowerCase().includes(pattern.toLowerCase());
		}
		return pattern.test(email.subject);
	});

	return hasSystemSender || hasSystemSubject;
}

/**
 * Check if email requires human attention
 */
function isHumanRequired(email: ParsedEmail): boolean {
	const personalIndicators = [
		/^re:/i,
		/^fw:/i,
	];

	// Check for personal email patterns
	const senderLower = email.sender.toLowerCase();
	const notSystem = !["no-reply@", "noreply@", "notifications@", "automated@"].some(
		(s) => senderLower.includes(s)
	);

	const isReply = personalIndicators.some((pattern) => pattern.test(email.subject));

	const content = `${email.subject} ${email.body}`.toLowerCase();
	const hasPersonalContent = [
		"what do you think",
		"let me know",
		"your opinion",
		"when you get a chance",
		"thanks",
	].some((phrase) => content.includes(phrase));

	return notSystem && (isReply || hasPersonalContent);
}

/**
 * Check if email is informational (newsletters, notifications)
 */
function isInformational(email: ParsedEmail): boolean {
	const newsletterPatterns = [
		/newsletter/i,
		/weekly\s+update/i,
		/daily\s+digest/i,
		/monthly\s+report/i,
		/notification/i,
	];

	const senderLower = email.sender.toLowerCase();
	const knownNewsletterSenders = [
		"newsletter@",
		"updates@",
		"digest@",
		"notifications@",
	];

	const hasNewsletterSender = knownNewsletterSenders.some((s) => senderLower.includes(s));
	const hasNewsletterPattern = newsletterPatterns.some((pattern) => pattern.test(email.subject));

	return hasNewsletterSender || hasNewsletterPattern;
}

/**
 * Get display name for inbox category
 */
export function getInboxCategoryName(category: InboxCategory): string {
	const names: Record<InboxCategory, string> = {
		command: "Command",
		task: "Task",
		informational: "Informational",
		human_required: "Human Required",
		spam: "Spam",
		junk_system_mail: "Junk/System Mail",
		unclassifiable: "Unclassifiable",
	};

	return names[category];
}

/**
 * Get action description for inbox action
 */
export function getInboxActionDescription(action: InboxAction): string {
	const descriptions: Record<InboxAction, string> = {
		execute_command: "Execute the agent command",
		create_task: "Create a task from this email",
		archive: "Archive this email",
		flag_for_human: "Flag for human attention",
		move_to_spam: "Move to spam folder",
		move_to_review: "Move to REVIEW folder",
		delete: "Delete this email",
	};

	return descriptions[action];
}
