/**
 * Email Listener Skill - Task Creator Module
 *
 * Provides task creation functionality for converting emails into tasks:
 * - Extract tasks from emails
 * - Create Obsidian tasks
 * - Add email metadata and references
 * - Support for various task formats
 *
 * This module handles the task creation part of the inbox management protocol.
 */

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { logger } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Task created from an email
 */
export interface EmailTask {
	/** Unique task identifier */
	id: string;
	/** Task title/description */
	title: string;
	/** Detailed task description */
	description: string;
	/** Source email reference */
	sourceEmail: EmailReference;
	/** Priority level */
	priority: TaskPriority;
	/** Task status */
	status: TaskStatus;
	/** Created timestamp */
	createdAt: Date;
	/** Due date if specified */
	dueDate?: Date;
	/** Tags associated with task */
	tags: string[];
	/** Additional metadata */
	metadata: Record<string, unknown>;
}

/**
 * Email reference information
 */
export interface EmailReference {
	/** Email subject */
	subject: string;
	/** Sender email address */
	from: string;
	/** Sender display name */
	fromName?: string;
	/** Email date */
	date: Date;
	/** Message ID for threading */
	messageId?: string;
	/** IMAP UID */
	uid?: number;
}

/**
 * Task priority levels
 */
export type TaskPriority = "low" | "medium" | "high" | "urgent";

/**
 * Task status
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * Task creation options
 */
export interface CreateTaskOptions {
	/** Task title */
	title: string;
	/** Detailed description */
	description?: string;
	/** Priority level */
	priority?: TaskPriority;
	/** Due date */
	dueDate?: Date;
	/** Custom tags */
	tags?: string[];
	/** Source email reference */
	sourceEmail: EmailReference;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Task storage backend
 */
export type TaskBackend = "obsidian" | "json" | "both";

/**
 * Task creator configuration
 */
export interface TaskCreatorConfig {
	/** Storage backend type */
	backend: TaskBackend;
	/** Obsidian vault path */
	obsidianVaultPath?: string;
	/** JSON file path for fallback */
	jsonFilePath?: string;
	/** Whether to enable task creation */
	enabled: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default task creator configuration
 */
export const DEFAULT_TASK_CONFIG: TaskCreatorConfig = {
	backend: "json",
	obsidianVaultPath: undefined,
	jsonFilePath: join(homedir(), "myVault", "00_FrankOS", "tasks", "email-tasks.json"),
	enabled: true,
};

let taskConfig: TaskCreatorConfig = { ...DEFAULT_TASK_CONFIG };
let taskStore: EmailTask[] = [];

const TASKS_FILE_VERSION = "1.0";

interface TasksFile {
	version: string;
	createdAt: string;
	updatedAt: string;
	tasks: EmailTask[];
}

// ============================================================================
// Configuration Functions
// ============================================================================

/**
 * Initialize task creator with configuration
 */
export function initTaskCreator(config: Partial<TaskCreatorConfig>): void {
	taskConfig = { ...DEFAULT_TASK_CONFIG, ...config };
	logger.info("Task creator initialized", { config: taskConfig });
}

/**
 * Get current task creator configuration
 */
export function getTaskCreatorConfig(): TaskCreatorConfig {
	return { ...taskConfig };
}

/**
 * Check if task creator is enabled
 */
export function isTaskCreatorEnabled(): boolean {
	return taskConfig.enabled;
}

// ============================================================================
// Task Extraction from Email
// ============================================================================

/**
 * Keywords that indicate a task in email content
 */
const TASK_KEYWORDS = [
	"please",
	"need to",
	"should",
	"must",
	"action required",
	"todo",
	"task",
	"follow up",
	"review",
	"deadline",
	"due",
	"complete",
	"finish",
	"update",
	"check",
	"verify",
	"investigate",
	"analyze",
];

/**
 * Priority keywords for task extraction
 */
const PRIORITY_KEYWORDS: Record<TaskPriority, string[]> = {
	urgent: ["urgent", "asap", "immediately", "critical", "emergency", "now"],
	high: ["important", "priority", "high", "soon", "eod", "end of day"],
	medium: ["when possible", "this week", "moderate"],
	low: ["when you have time", "eventually", "low priority", "someday"],
};

/**
 * Extract task content from email
 */
export function extractTaskFromEmail(
	subject: string,
	body: string,
	emailRef: EmailReference
): EmailTask | null {
	// Check if email contains task-like content
	const lowerSubject = subject.toLowerCase();
	const lowerBody = body.toLowerCase();

	const hasTaskKeyword = TASK_KEYWORDS.some(
		(kw) => lowerSubject.includes(kw) || lowerBody.includes(kw)
	);

	if (!hasTaskKeyword && !isExplicitTaskRequest(subject)) {
		logger.debug("No task content detected in email", { subject });
		return null;
	}

	// Extract title from subject
	const title = cleanTaskTitle(subject);

	// Determine priority
	const priority = extractPriority(subject, body);

	// Extract due date if mentioned
	const dueDate = extractDueDate(subject, body);

	// Build description from body
	const description = extractTaskDescription(body);

	// Create the task
	const task: EmailTask = {
		id: generateTaskId(emailRef),
		title,
		description,
		sourceEmail: emailRef,
		priority,
		status: "pending",
		createdAt: new Date(),
		dueDate,
		tags: ["email", "inbox"],
		metadata: {
			extractedFrom: "email",
			confidence: calculateTaskConfidence(subject, body),
		},
	};

	logger.info("Extracted task from email", {
		taskId: task.id,
		title: task.title,
		priority: task.priority,
	});

	return task;
}

/**
 * Check if subject explicitly requests a task
 */
function isExplicitTaskRequest(subject: string): boolean {
	const lowerSubject = subject.toLowerCase();
	const explicitPatterns = [
		"task:",
		"todo:",
		"action:",
		"request:",
		"please",
		"review",
		"follow up",
	];

	return explicitPatterns.some((pattern) => lowerSubject.includes(pattern));
}

/**
 * Clean task title from email subject
 */
function cleanTaskTitle(subject: string): string {
	// Remove common prefixes
	let title = subject
		.replace(/^(re:|fw:|fwd:)\s*/gi, "")
		.replace(/^(tim:|chewie:|frankos:)\s*/gi, "")
		.trim();

	// Limit length
	if (title.length > 100) {
		title = title.substring(0, 97) + "...";
	}

	return title;
}

/**
 * Extract priority from email content
 */
function extractPriority(subject: string, body: string): TaskPriority {
	const content = `${subject} ${body}`.toLowerCase();

	// Check urgent first
	if (PRIORITY_KEYWORDS.urgent.some((kw) => content.includes(kw))) {
		return "urgent";
	}

	// Check high
	if (PRIORITY_KEYWORDS.high.some((kw) => content.includes(kw))) {
		return "high";
	}

	// Check medium
	if (PRIORITY_KEYWORDS.medium.some((kw) => content.includes(kw))) {
		return "medium";
	}

	// Check low
	if (PRIORITY_KEYWORDS.low.some((kw) => content.includes(kw))) {
		return "low";
	}

	return "medium"; // Default priority
}

/**
 * Extract due date from email content
 */
function extractDueDate(subject: string, body: string): Date | undefined {
	const content = `${subject} ${body}`.toLowerCase();

	// Simple date patterns
	const datePatterns = [
		{ pattern: /by\s+(\d{1,2}\/\d{1,2})/i, format: "m/d" },
		{ pattern: /by\s+(\d{1,2}-\d{1,2})/i, format: "m-d" },
		{ pattern: /due\s+(\d{1,2}\/\d{1,2})/i, format: "m/d" },
		{ pattern: /deadline:\s*(\d{1,2}\/\d{1,2})/i, format: "m/d" },
	];

	const currentYear = new Date().getFullYear();

	for (const { pattern, format } of datePatterns) {
		const match = content.match(pattern);
		if (match) {
			try {
				const [month, day] = match[1].split(format === "m/d" ? "/" : "-").map(Number);
				const date = new Date(currentYear, month - 1, day);

				// Only return if in the future
				if (date > new Date()) {
					return date;
				}
			} catch {
				// Ignore parse errors
			}
		}
	}

	return undefined;
}

/**
 * Extract task description from body
 */
function extractTaskDescription(body: string): string {
	// Get first few sentences or lines
	const lines = body.split("\n").filter((line) => line.trim().length > 0);
	const relevantLines = lines.slice(0, 5);

	let description = relevantLines.join(" ").trim();

	// Limit length
	if (description.length > 500) {
		description = description.substring(0, 497) + "...";
	}

	return description;
}

/**
 * Calculate confidence that content is a task
 */
function calculateTaskConfidence(subject: string, body: string): number {
	let confidence = 0.5;

	const lowerSubject = subject.toLowerCase();
	const lowerBody = body.toLowerCase();

	// Strong indicators
	if (lowerSubject.includes("task:") || lowerSubject.includes("todo:")) {
		confidence += 0.3;
	}
	if (lowerSubject.includes("please") || lowerSubject.includes("action required")) {
		confidence += 0.2;
	}

	// Weak indicators
	TASK_KEYWORDS.forEach((kw) => {
		if (lowerSubject.includes(kw) || lowerBody.includes(kw)) {
			confidence += 0.05;
		}
	});

	return Math.min(confidence, 1.0);
}

/**
 * Generate unique task ID
 */
function generateTaskId(emailRef: EmailReference): string {
	const timestamp = Date.now();
	const shortHash = emailRef.messageId
		? emailRef.messageId.substring(0, 8)
		: Math.random().toString(36).substring(2, 10);

	return `email-task-${timestamp}-${shortHash}`;
}

// ============================================================================
// Task CRUD Operations
// ============================================================================

/**
 * Create a new task from email
 */
export async function createTask(options: CreateTaskOptions): Promise<EmailTask> {
	if (!taskConfig.enabled) {
		throw new Error("Task creator is not enabled");
	}

	const task: EmailTask = {
		id: options.sourceEmail.messageId
			? `email-task-${Date.now()}-${options.sourceEmail.messageId.substring(0, 8)}`
			: `email-task-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
		title: options.title,
		description: options.description || "",
		sourceEmail: options.sourceEmail,
		priority: options.priority || "medium",
		status: "pending",
		createdAt: new Date(),
		dueDate: options.dueDate,
		tags: options.tags || ["email", "inbox"],
		metadata: options.metadata || {},
	};

	// Add to in-memory store
	taskStore.push(task);

	// Persist to storage
	await persistTasks();

	logger.info("Created task from email", {
		taskId: task.id,
		title: task.title,
		priority: task.priority,
	});

	return task;
}

/**
 * Get all tasks
 */
export function getAllTasks(): EmailTask[] {
	return [...taskStore];
}

/**
 * Get pending tasks
 */
export function getPendingTasks(): EmailTask[] {
	return taskStore.filter((t) => t.status === "pending");
}

/**
 * Get task by ID
 */
export function getTaskById(id: string): EmailTask | undefined {
	return taskStore.find((t) => t.id === id);
}

/**
 * Update task status
 */
export async function updateTaskStatus(
	id: string,
	status: TaskStatus
): Promise<EmailTask | null> {
	const task = taskStore.find((t) => t.id === id);

	if (!task) {
		logger.warn("Task not found for update", { taskId: id });
		return null;
	}

	task.status = status;
	await persistTasks();

	logger.info("Updated task status", { taskId: id, status });
	return task;
}

/**
 * Delete a task
 */
export async function deleteTask(id: string): Promise<boolean> {
	const index = taskStore.findIndex((t) => t.id === id);

	if (index === -1) {
		logger.warn("Task not found for deletion", { taskId: id });
		return false;
	}

	taskStore.splice(index, 1);
	await persistTasks();

	logger.info("Deleted task", { taskId: id });
	return true;
}

// ============================================================================
// Obsidian Integration
// ============================================================================

/**
 * Create Obsidian-compatible task entry
 */
export function createObsidianTaskEntry(task: EmailTask): string {
	const lines: string[] = [];

	// Task checkbox
	lines.push(task.status === "completed" ? "- [x]" : "- [ ]");

	// Title
	lines.push(task.title);

	// Priority indicator
	const priorityEmoji: Record<TaskPriority, string> = {
		urgent: "🔴",
		high: "🟠",
		medium: "🟡",
		low: "🟢",
	};
	lines.push(`  priority:: ${priorityEmoji[task.priority]}`);

	// Created date
	lines.push(`  created:: ${task.createdAt.toISOString().split("T")[0]}`);

	// Due date if exists
	if (task.dueDate) {
		lines.push(`  due:: ${task.dueDate.toISOString().split("T")[0]}`);
	}

	// Source email
	lines.push(`  source:: email`);
	lines.push(`  from:: [[${task.sourceEmail.from}]]`);
	lines.push(`  subject:: "${task.sourceEmail.subject}"`);

	// Message link (if available)
	if (task.sourceEmail.messageId) {
		lines.push(`  message-id:: ${task.sourceEmail.messageId}`);
	}

	// Tags
	if (task.tags.length > 0) {
		lines.push(`  #email-task`);
		task.tags.forEach((tag) => {
			lines.push(`  #${tag.replace(/\s+/g, "-")}`);
		});
	}

	// Description if exists
	if (task.description) {
		lines.push("");
		lines.push(`  ${task.description}`);
	}

	return lines.join("\n");
}

/**
 * Export all tasks to Obsidian format
 */
export function exportTasksToObsidian(): string {
	const pendingTasks = getPendingTasks();

	if (pendingTasks.length === 0) {
		return "# Email Tasks\n\nNo pending tasks.\n";
	}

	const lines: string[] = ["# Email Tasks", "", "## Pending Tasks", ""];

	// Sort by priority
	const sortedTasks = [...pendingTasks].sort((a, b) => {
		const priorityOrder: Record<TaskPriority, number> = {
			urgent: 0,
			high: 1,
			medium: 2,
			low: 3,
		};
		return priorityOrder[a.priority] - priorityOrder[b.priority];
	});

	for (const task of sortedTasks) {
		lines.push(createObsidianTaskEntry(task));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Get Obsidian vault path
 */
export function getObsidianVaultPath(): string | undefined {
	return taskConfig.obsidianVaultPath;
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Get the tasks file path
 */
function getTasksFilePath(): string {
	return taskConfig.jsonFilePath || DEFAULT_TASK_CONFIG.jsonFilePath!;
}

/**
 * Load tasks from disk
 */
export async function loadTasks(): Promise<void> {
	const filePath = getTasksFilePath();

	try {
		const content = await fs.readFile(filePath, "utf-8");
		const data: TasksFile = JSON.parse(content);

		if (data.version && data.tasks) {
			taskStore = data.tasks.map((t) => ({
				...t,
				createdAt: new Date(t.createdAt),
				dueDate: t.dueDate ? new Date(t.dueDate) : undefined,
			}));
			logger.info("Loaded tasks from disk", { count: taskStore.length });
		}
	} catch (error) {
		// File doesn't exist or is invalid - start with empty store
		logger.debug("No existing tasks file, starting fresh");
		taskStore = [];
	}
}

/**
 * Persist tasks to disk
 */
async function persistTasks(): Promise<void> {
	const filePath = getTasksFilePath();

	const data: TasksFile = {
		version: TASKS_FILE_VERSION,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		tasks: taskStore,
	};

	// Ensure directory exists
	const dir = dirname(filePath);
	await fs.mkdir(dir, { recursive: true });

	await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
	logger.debug("Persisted tasks to disk", { count: taskStore.length });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get task statistics
 */
export function getTaskStats(): {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	byPriority: Record<TaskPriority, number>;
} {
	const stats = {
		total: taskStore.length,
		pending: 0,
		inProgress: 0,
		completed: 0,
		byPriority: {
			urgent: 0,
			high: 0,
			medium: 0,
			low: 0,
		} as Record<TaskPriority, number>,
	};

	for (const task of taskStore) {
		switch (task.status) {
			case "pending":
				stats.pending++;
				break;
			case "in_progress":
				stats.inProgress++;
				break;
			case "completed":
				stats.completed++;
				break;
		}
		stats.byPriority[task.priority]++;
	}

	return stats;
}

/**
 * Format task for display
 */
export function formatTask(task: EmailTask): string {
	const lines = [
		`Task: ${task.title}`,
		`ID: ${task.id}`,
		`Priority: ${task.priority.toUpperCase()}`,
		`Status: ${task.status}`,
		`Created: ${task.createdAt.toISOString()}`,
		`From: ${task.sourceEmail.from}`,
		`Subject: ${task.sourceEmail.subject}`,
	];

	if (task.dueDate) {
		lines.push(`Due: ${task.dueDate.toISOString().split("T")[0]}`);
	}

	if (task.tags.length > 0) {
		lines.push(`Tags: ${task.tags.join(", ")}`);
	}

	return lines.join("\n");
}

/**
 * Clear all tasks (for testing)
 */
export async function clearAllTasks(): Promise<void> {
	taskStore = [];
	await persistTasks();
	logger.info("Cleared all tasks");
}

/**
 * Get tasks by email message ID
 */
export function getTasksByMessageId(messageId: string): EmailTask[] {
	return taskStore.filter((t) => t.sourceEmail.messageId === messageId);
}
