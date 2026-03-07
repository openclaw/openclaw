/**
 * Email Listener Skill - Folder Manager Module
 *
 * Provides folder management functions for organizing email:
 * - Ensure folder structure exists
 * - Move emails to specific folders
 * - Get folder statistics
 * - Archive processed emails
 *
 * This module handles the folder organization part of the inbox management protocol.
 */

import Imap from "imap-simple";
import type { ImapSimple } from "imap-simple";
import type { EmailListenerConfig } from "./types.js";
import { logger } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Folder information
 */
export interface FolderInfo {
	/** Folder name */
	name: string;
	/** Path to the folder */
	path: string;
	/** Number of messages in folder */
	messageCount: number;
	/** Number of unread messages */
	unreadCount: number;
}

/**
 * Folder statistics for all folders
 */
export interface FolderStats {
	/** List of folders with their stats */
	folders: FolderInfo[];
	/** Total messages across all folders */
	totalMessages: number;
	/** Timestamp of stats */
	timestamp: Date;
}

/**
 * Required folder structure
 */
export const REQUIRED_FOLDERS = {
	COMMANDS: "Commands",
	TASKS: "Tasks",
	ARCHIVE: "Archive",
	NOTIFICATIONS: "Notifications",
	SPAM: "Spam",
	REVIEW: "REVIEW",
} as const;

/**
 * All folder names
 */
export type FolderName =
	| "INBOX"
	| "Commands"
	| "Tasks"
	| "Archive"
	| "Notifications"
	| "Spam"
	| "REVIEW"
	| "Trash";

// ============================================================================
// Folder Management
// ============================================================================

let imapConnection: ImapSimple | null = null;

/**
 * Set the IMAP connection for folder operations
 */
export function setImapConnection(connection: ImapSimple | null): void {
	imapConnection = connection;
}

/**
 * Get the current IMAP connection
 */
export function getImapConnection(): ImapSimple | null {
	return imapConnection;
}

/**
 * Ensure the required folder structure exists
 * Creates folders if they don't exist
 */
export async function ensureFolderStructure(
	config: EmailListenerConfig
): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
	// Get connection - either from parameter or use stored connection
	const connection = imapConnection;

	if (!connection) {
		throw new Error("IMAP connection not available");
	}

	const created: string[] = [];
	const existing: string[] = [];
	const errors: string[] = [];

	// Get list of existing folders
	const existingFolders = await listFolders(connection);

	logger.info("Ensuring folder structure", {
		existingFolders: existingFolders.length,
	});

	// Create each required folder if it doesn't exist
	for (const [, folderName] of Object.entries(REQUIRED_FOLDERS)) {
		try {
			const folderExists = existingFolders.some(
				(f) => f.name.toLowerCase() === folderName.toLowerCase()
			);

			if (folderExists) {
				existing.push(folderName);
				logger.debug("Folder already exists", { folder: folderName });
			} else {
				await connection.addBox(folderName);
				created.push(folderName);
				logger.info("Created folder", { folder: folderName });
			}
		} catch (error) {
			const errorMsg = `Failed to create folder ${folderName}: ${error}`;
			errors.push(errorMsg);
			logger.error("Failed to create folder", { folder: folderName, error: String(error) });
		}
	}

	logger.info("Folder structure ensured", {
		created: created.length,
		existing: existing.length,
		errors: errors.length,
	});

	return { created, existing, errors };
}

/**
 * List all available folders
 */
export async function listFolders(connection: ImapSimple): Promise<FolderInfo[]> {
	return new Promise((resolve, reject) => {
		connection.getBoxes((error, boxes) => {
			if (error) {
				logger.error("Failed to list folders", { error: String(error) });
				reject(error);
				return;
			}

			const folders: FolderInfo[] = [];

			// Recursively extract folder information
			function extractFolders(box: Record<string, unknown>, path = ""): void {
				for (const [name, info] of Object.entries(box)) {
					const fullPath = path ? `${path}${name}` : name;
					const boxInfo = info as Record<string, unknown>;

					folders.push({
						name,
						path: fullPath,
						messageCount: (boxInfo.attr?.["messages"] as number) || 0,
						unreadCount: (boxInfo.attr?.["unseen"] as number) || 0,
					});

					// Check for children
					if (boxInfo.children) {
						extractFolders(boxInfo.children as Record<string, unknown>, `${fullPath}/`);
					}
				}
			}

			extractFolders(boxes);
			logger.debug("Listed folders", { count: folders.length });
			resolve(folders);
		});
	});
}

/**
 * Move an email to a specific folder
 */
export async function moveToFolder(
	connection: ImapSimple,
	messageUid: number,
	targetFolder: string
): Promise<boolean> {
	try {
		await connection.moveMessages([messageUid], targetFolder);
		logger.info("Moved email to folder", {
			uid: messageUid,
			folder: targetFolder,
		});
		return true;
	} catch (error) {
		logger.error("Failed to move email to folder", {
			uid: messageUid,
			folder: targetFolder,
			error: String(error),
		});
		return false;
	}
}

/**
 * Move multiple emails to a specific folder
 */
export async function moveMultipleToFolder(
	connection: ImapSimple,
	messageUids: number[],
	targetFolder: string
): Promise<{ success: number; failed: number }> {
	if (messageUids.length === 0) {
		return { success: 0, failed: 0 };
	}

	let success = 0;
	let failed = 0;

	try {
		await connection.moveMessages(messageUids, targetFolder);
		success = messageUids.length;
		logger.info("Moved emails to folder", {
			count: messageUids.length,
			folder: targetFolder,
		});
	} catch (error) {
		failed = messageUids.length;
		logger.error("Failed to move emails to folder", {
			count: messageUids.length,
			folder: targetFolder,
			error: String(error),
		});
	}

	return { success, failed };
}

/**
 * Copy an email to a specific folder (keeps original)
 */
export async function copyToFolder(
	connection: ImapSimple,
	messageUid: number,
	targetFolder: string
): Promise<boolean> {
	try {
		await connection.copyMessages([messageUid], targetFolder);
		logger.info("Copied email to folder", {
			uid: messageUid,
			folder: targetFolder,
		});
		return true;
	} catch (error) {
		logger.error("Failed to copy email to folder", {
			uid: messageUid,
			folder: targetFolder,
			error: String(error),
		});
		return false;
	}
}

// ============================================================================
// Folder Statistics
// ============================================================================

/**
 * Get statistics for all folders
 */
export async function getFolderStats(connection: ImapSimple): Promise<FolderStats> {
	const folders = await listFolders(connection);

	const totalMessages = folders.reduce((sum, f) => sum + f.messageCount, 0);

	return {
		folders,
		totalMessages,
		timestamp: new Date(),
	};
}

/**
 * Get statistics for a specific folder
 */
export async function getFolderInfo(
	connection: ImapSimple,
	folderName: string
): Promise<FolderInfo | null> {
	const folders = await listFolders(connection);

	const folder = folders.find(
		(f) => f.name.toLowerCase() === folderName.toLowerCase()
	);

	return folder || null;
}

// ============================================================================
// Archive Operations
// ============================================================================

/**
 * Archive an email (move to Archive folder)
 */
export async function archiveEmail(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.ARCHIVE);
}

/**
 * Archive multiple emails
 */
export async function archiveMultipleEmails(
	connection: ImapSimple,
	messageUids: number[]
): Promise<{ success: number; failed: number }> {
	return moveMultipleToFolder(connection, messageUids, REQUIRED_FOLDERS.ARCHIVE);
}

/**
 * Move email to spam folder
 */
export async function moveToSpam(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.SPAM);
}

/**
 * Move email to REVIEW folder (for unclassifiable emails)
 */
export async function moveToReview(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.REVIEW);
}

/**
 * Move email to Commands folder
 */
export async function moveToCommands(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.COMMANDS);
}

/**
 * Move email to Tasks folder
 */
export async function moveToTasks(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.TASKS);
}

/**
 * Move email to Notifications folder
 */
export async function moveToNotifications(
	connection: ImapSimple,
	messageUid: number
): Promise<boolean> {
	return moveToFolder(connection, messageUid, REQUIRED_FOLDERS.NOTIFICATIONS);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the destination folder for a category
 */
export function getDestinationFolder(category: string): FolderName {
	switch (category) {
		case "command":
			return "Commands";
		case "task":
			return "Tasks";
		case "informational":
		case "junk_system_mail":
			return "Archive";
		case "human_required":
			return "INBOX";
		case "spam":
			return "Spam";
		case "unclassifiable":
			return "REVIEW";
		default:
			return "Archive";
	}
}

/**
 * Format folder statistics for display
 */
export function formatFolderStats(stats: FolderStats): string {
	const lines: string[] = ["Folder Statistics", "=================", ""];

	for (const folder of stats.folders) {
		lines.push(
			`${folder.name}: ${folder.messageCount} messages (${folder.unreadCount} unread)`
		);
	}

	lines.push("");
	lines.push(`Total: ${stats.totalMessages} messages`);
	lines.push(`Timestamp: ${stats.timestamp.toISOString()}`);

	return lines.join("\n");
}

/**
 * Get folder name from constants
 */
export function getFolderName(key: keyof typeof REQUIRED_FOLDERS): string {
	return REQUIRED_FOLDERS[key];
}
