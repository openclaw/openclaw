/**
 * Email Listener Skill - Inbox Manager Module
 *
 * Provides inbox management functions for the agent including:
 * - Inbox status verification
 * - Cleanliness target tracking
 * - Agent instructions for inbox management
 *
 * This module implements the "runbook" for AI agents managing email inboxes.
 */

import type { EmailListenerConfig, ParsedEmail } from "./types.js";
import { logger } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Inbox status information
 */
export interface InboxStatus {
	/** Number of unread emails */
	unreadCount: number;
	/** Number of flagged emails */
	flaggedCount: number;
	/** Total emails in inbox */
	totalCount: number;
	/** Timestamp of status check */
	timestamp: Date;
}

/**
 * Cleanliness target configuration
 */
export interface InboxCleanlinessTarget {
	/** Maximum allowed unread emails (excluding human-required) */
	maxUnread: number;
	/** Maximum allowed total emails in inbox */
	maxTotal: number;
	/** Whether to enforce strict rules */
	strictMode: boolean;
}

/**
 * Verification result
 */
export interface VerificationResult {
	/** Whether inbox is clean */
	isClean: boolean;
	/** Current status */
	status: InboxStatus;
	/** Issues found */
	issues: string[];
	/** Overall message */
	message: string;
}

/**
 * Inbox classification categories
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
 * Processing action based on classification
 */
export interface ProcessingAction {
	/** Category of the email */
	category: InboxCategory;
	/** Action to take */
	action: "execute_command" | "create_task" | "archive" | "flag_and_keep" | "move_to_spam" | "move_to_review";
	/** Destination folder (if applicable) */
	destinationFolder?: string;
	/** Priority level */
	priority: "high" | "medium" | "low";
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default cleanliness targets
 */
export const DEFAULT_CLEANLINESS_TARGET: InboxCleanlinessTarget = {
	maxUnread: 0,
	maxTotal: 3,
	strictMode: true,
};

/**
 * Command prefixes that trigger command processing
 */
export const COMMAND_PREFIXES = ["TIM:", "CHEWIE:", "FRANKOS:"];

/**
 * Folder names for email organization
 */
export const FOLDER_STRUCTURE = {
	INBOX: "INBOX",
	COMMANDS: "Commands",
	TASKS: "Tasks",
	ARCHIVE: "Archive",
	NOTIFICATIONS: "Notifications",
	SPAM: "Spam",
	REVIEW: "REVIEW",
} as const;

// ============================================================================
// Agent Instructions - The Runbook
// ============================================================================

/**
 * Get the agent instructions for inbox management
 * This is the "runbook" that defines how the agent should manage the inbox
 */
export function getAgentInstructions(): string {
	return `You are responsible for maintaining a clean inbox.

## Definition of Clean Inbox

An inbox is considered clean when:
- No unread emails remain (except human-required)
- Every email is processed and categorized
- Emails are either: archived, replied to, converted into tasks, filed into folders, marked as spam, or deleted
- The inbox contains ONLY items requiring immediate human attention

## Inbox Hygiene Rules

1. NEVER leave processed mail in the inbox
2. Archive aggressively - if it doesn't need immediate action, archive it
3. ONLY leave items requiring human attention in the inbox
4. No unread messages allowed (except flagged human-required)
5. Inbox target: 0-3 emails maximum

## Processing Workflow

1. Check inbox for unread messages
2. For each message:
   a. Read the message
   b. Determine classification
   c. Execute the correct action
3. Verify inbox state
4. Repeat on schedule

## Classification Categories

| Category | Description | Action |
|----------|-------------|--------|
| Command | Email contains TIM:/CHEWIE:/FRANKOS: prefix | Execute command, send response, archive |
| Task | Something requiring work or follow-up | Create task entry, archive |
| Informational | Newsletters, notifications, reports | Archive immediately |
| Human Required | Needs a human response | Flag, keep unread, leave in inbox |
| Spam | Unwanted email | Move to spam folder |
| Junk System Mail | Receipts, automated confirmations | Archive |

## Folder Structure

Maintain this folder structure:
- INBOX: Temporary holding area
- Commands: Processed command emails
- Tasks: Task items extracted from emails
- Archive: Processed informational emails
- Notifications: System notifications
- Spam: Unwanted emails
- REVIEW: Unclassifiable emails

## Verification Step

After processing, verify inbox status:

Inbox Status Check
==================
Unread emails: 0
Flagged emails: 1
Inbox count: 1

Status: CLEAN

If inbox > threshold:
Status: NEEDS PROCESSING

## Simple Mental Model

The inbox is NOT storage.
The inbox is a TEMPORARY QUEUE of unprocessed work.

Once processed, the email MUST leave the inbox.`;
}

/**
 * Get a concise version of agent instructions for embedding
 */
export function getConciseInstructions(): string {
	return `Inbox Management Rules:
- Target: 0-3 emails in inbox
- Process: Read → Classify → Action → Verify
- Categories: Command (execute), Task (create task), Informational (archive), Human Required (flag/keep), Spam (move), Junk (archive)
- NEVER leave processed mail in inbox
- Archive aggressively
- Verify after each cycle`;
}

// ============================================================================
// Inbox Status Functions
// ============================================================================

/**
 * Get current inbox status
 * This would connect to IMAP to get real counts
 */
export async function getInboxStatus(config: EmailListenerConfig): Promise<InboxStatus> {
	// This is a placeholder - actual implementation would query IMAP
	// The actual implementation should use the poll_inbox module
	logger.debug("Getting inbox status");

	return {
		unreadCount: 0,
		flaggedCount: 0,
		totalCount: 0,
		timestamp: new Date(),
	};
}

/**
 * Verify if inbox meets cleanliness criteria
 */
export function verifyInboxClean(
	status: InboxStatus,
	target: InboxCleanlinessTarget = DEFAULT_CLEANLINESS_TARGET
): VerificationResult {
	const issues: string[] = [];

	// Check unread count
	if (status.unreadCount > target.maxUnread) {
		issues.push(
			`Too many unread emails: ${status.unreadCount} (max: ${target.maxUnread})`
		);
	}

	// Check total count
	if (status.totalCount > target.maxTotal) {
		issues.push(
			`Inbox overflow: ${status.totalCount} emails (max: ${target.maxTotal})`
		);
	}

	const isClean = issues.length === 0;

	const message = isClean
		? `Status: CLEAN (${status.totalCount} emails, ${status.flaggedCount} flagged)`
		: `Status: NEEDS PROCESSING - ${issues.join(", ")}`;

	return {
		isClean,
		status,
		issues,
		message,
	};
}

/**
 * Format inbox status for display
 */
export function formatInboxStatus(status: InboxStatus): string {
	return `Inbox Status Check
==================
Unread emails: ${status.unreadCount}
Flagged emails: ${status.flaggedCount}
Inbox count: ${status.totalCount}

Timestamp: ${status.timestamp.toISOString()}`;
}

// ============================================================================
// Classification and Action Mapping
// ============================================================================

/**
 * Determine the category of an email
 */
export function classifyForInbox(email: ParsedEmail): InboxCategory {
	const subject = email.subject.toUpperCase();
	const body = email.body.toLowerCase();
	const sender = email.sender.toLowerCase();

	// Check for command prefix
	for (const prefix of COMMAND_PREFIXES) {
		if (subject.startsWith(prefix) || body.startsWith(prefix.toLowerCase())) {
			return "command";
		}
	}

	// Check for spam indicators
	const spamKeywords = ["spam", "unsubscribe", "click here to win", "free money"];
	const isSpam = spamKeywords.some((keyword) => body.includes(keyword));
	if (isSpam) {
		return "spam";
	}

	// Check for system mail / junk
	const systemPatterns = [
		"noreply@",
		"no-reply@",
		"notification@",
		"alert@",
		"receipt@",
		"confirmation@",
	];
	const isSystemMail = systemPatterns.some((pattern) => sender.includes(pattern));
	if (isSystemMail && (body.includes("receipt") || body.includes("confirmation") || body.length < 200)) {
		return "junk_system_mail";
	}

	// Check for task indicators
	const taskKeywords = [
		"please review",
		"action required",
		"follow up",
		"todo",
		"task",
		"deadline",
		"urgent",
	];
	const hasTaskKeyword = taskKeywords.some((keyword) => body.includes(keyword));
	if (hasTaskKeyword) {
		return "task";
	}

	// Check for personal / human required
	const personalPatterns = [
		"personal",
		"confidential",
		"private",
		"urgent",
		"help",
		"question",
	];
	const isPersonal = personalPatterns.some(
		(pattern) => subject.toLowerCase().includes(pattern) || body.includes(pattern)
	);
	if (isPersonal) {
		return "human_required";
	}

	// Default to informational
	return "informational";
}

/**
 * Get the processing action for a category
 */
export function getActionForCategory(category: InboxCategory): ProcessingAction {
	switch (category) {
		case "command":
			return {
				category,
				action: "execute_command",
				destinationFolder: FOLDER_STRUCTURE.COMMANDS,
				priority: "high",
			};

		case "task":
			return {
				category,
				action: "create_task",
				destinationFolder: FOLDER_STRUCTURE.TASKS,
				priority: "medium",
			};

		case "informational":
			return {
				category,
				action: "archive",
				destinationFolder: FOLDER_STRUCTURE.ARCHIVE,
				priority: "low",
			};

		case "human_required":
			return {
				category,
				action: "flag_and_keep",
				destinationFolder: FOLDER_STRUCTURE.INBOX,
				priority: "high",
			};

		case "spam":
			return {
				category,
				action: "move_to_spam",
				destinationFolder: FOLDER_STRUCTURE.SPAM,
				priority: "low",
			};

		case "junk_system_mail":
			return {
				category,
				action: "archive",
				destinationFolder: FOLDER_STRUCTURE.ARCHIVE,
				priority: "low",
			};

		case "unclassifiable":
		default:
			return {
				category,
				action: "move_to_review",
				destinationFolder: FOLDER_STRUCTURE.REVIEW,
				priority: "medium",
			};
	}
}

/**
 * Get human-readable name for category
 */
export function getCategoryName(category: InboxCategory): string {
	const names: Record<InboxCategory, string> = {
		command: "Command",
		task: "Task",
		informational: "Informational",
		human_required: "Human Required",
		spam: "Spam",
		junk_system_mail: "Junk System Mail",
		unclassifiable: "Unclassifiable",
	};
	return names[category];
}

/**
 * Get all available categories
 */
export function getAllCategories(): InboxCategory[] {
	return [
		"command",
		"task",
		"informational",
		"human_required",
		"spam",
		"junk_system_mail",
		"unclassifiable",
	];
}

// ============================================================================
// Processing Loop
// ============================================================================

/**
 * Process a single email through the inbox management workflow
 */
export async function processEmailForInbox(
	email: ParsedEmail
): Promise<{ category: InboxCategory; action: ProcessingAction }> {
	// Classify the email
	const category = classifyForInbox(email);
	logger.info("Email classified", {
		subject: email.subject,
		category,
		sender: email.sender,
	});

	// Get the action
	const action = getActionForCategory(category);

	logger.info("Action determined", {
		category,
		action: action.action,
		destinationFolder: action.destinationFolder,
	});

	return { category, action };
}

/**
 * Run the complete inbox processing verification
 */
export async function runInboxVerification(
	config: EmailListenerConfig,
	target: InboxCleanlinessTarget = DEFAULT_CLEANLINESS_TARGET
): Promise<VerificationResult> {
	logger.info("Running inbox verification");

	// Get current status
	const status = await getInboxStatus(config);

	// Verify cleanliness
	const result = verifyInboxClean(status, target);

	logger.info("Inbox verification complete", {
		isClean: result.isClean,
		message: result.message,
		issues: result.issues,
	});

	return result;
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Handle unclassifiable emails
 */
export function handleUnclassifiable(email: ParsedEmail): ProcessingAction {
	logger.warn("Email could not be classified", {
		subject: email.subject,
		sender: email.sender,
	});

	return {
		category: "unclassifiable",
		action: "move_to_review",
		destinationFolder: FOLDER_STRUCTURE.REVIEW,
		priority: "medium",
	};
}

/**
 * Notify user about inbox issues
 */
export function createInboxNotification(result: VerificationResult): string {
	if (result.isClean) {
		return `Inbox is clean: ${result.status.totalCount} emails`;
	}

	return `Inbox needs attention:
${result.issues.map((issue) => `- ${issue}`).join("\n")}

Current status:
- Unread: ${result.status.unreadCount}
- Flagged: ${result.status.flaggedCount}
- Total: ${result.status.totalCount}`;
}
