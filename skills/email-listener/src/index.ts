/**
 * Email Listener Skill - Main Entry Point
 *
 * Provides email-based command interface for Tim (Guardian Agent).
 */

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { spawn } from "child_process";
import { pollAgentMailInbox, healthCheckAgentMail } from "./agentmail-polling.js";
import { initializeTracker, isProcessed, markAsProcessed } from "./processed-tracker.js";
import { addResult, getBatchedResponse } from "./response-batcher.js";

// IMAP modules are optional - lazy loaded only when needed
let imapModules: any = null;

async function ensureImapModules() {
  if (imapModules) return imapModules;

  try {
    imapModules = await import("./poll_inbox.js");
    return imapModules;
  } catch (error) {
    logger.error(
      "Could not load IMAP modules (imap-simple not installed). Use AgentMail by setting AGENTMAIL_API_KEY instead.",
      { error: String(error) }
    );
    throw new Error(
      "IMAP unavailable and AgentMail not configured. Set AGENTMAIL_API_KEY or install imap-simple."
    );
  }
}

// Wrapper functions for lazy IMAP loading
const connect = async (cfg: any) => (await ensureImapModules()).connect(cfg);
const disconnect = async () => {
  if (!imapModules) return;
  return (await ensureImapModules()).disconnect();
};
const pollInbox = async (cfg: any) => (await ensureImapModules()).pollInbox(cfg);
const resetPollingState = async () => (await ensureImapModules()).resetPollingState();
const moveToTrash = async (u: any) => (await ensureImapModules()).moveToTrash(u);
const deleteEmails = async (u: any) => (await ensureImapModules()).deleteEmails(u);
const getProcessedEmailUids = async () => (await ensureImapModules()).getProcessedEmailUids();
import { classifyMessage, classifyForInbox, getInboxCategoryName, type InboxCategory, type InboxClassification, type InboxAction } from "./classify_message.js";
import {
  initializeCommands,
  executeCommand,
  getAllCommands,
} from "./execute_command.js";
import { parseIntent } from "./intent-parser.js";
import type { ParsedIntent } from "./types.js";
import {
  sendCommandResult,
  sendUnauthorizedResponse,
  sendConfirmationRequest,
  initializeTransporter,
  closeTransporter,
} from "./send_response.js";

// Inbox Management Module imports
import {
  getAgentInstructions,
  getConciseInstructions,
  getInboxStatus,
  verifyInboxClean,
  getActionForCategory,
  type InboxStatus,
  type VerificationResult,
  type ProcessingAction,
} from "./inbox-manager.js";

// Folder Management Module imports
import {
  ensureFolderStructure,
  listFolders,
  moveToFolder,
  archiveEmail,
  moveToSpam,
  moveToReview,
  moveToCommands,
  moveToTasks,
  moveToNotifications,
  getFolderStats,
  getDestinationFolder,
  REQUIRED_FOLDERS,
  type FolderInfo,
  type FolderStats,
} from "./folder-manager.js";

// Task Creator Module imports
import {
  createTask,
  extractTaskFromEmail,
  getAllTasks,
  getPendingTasks,
  getTaskStats,
  exportTasksToObsidian,
  loadTasks,
  initTaskCreator,
  isTaskCreatorEnabled,
  type EmailTask,
  type CreateTaskOptions,
  type TaskPriority,
  type TaskStatus,
} from "./task-creator.js";

import type { EmailListenerConfig, ParsedEmail, ClassifiedMessage } from "./types.js";

let config: EmailListenerConfig | null = null;
let isRunning = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cleanup scheduler
 */
function startCleanupScheduler(): void {
  if (!config?.cleanup.enabled) {
    logger.info("Cleanup scheduler is disabled");
    return;
  }

  // Run initial cleanup
  runCleanup();

  // Set up cleanup interval
  cleanupInterval = setInterval(runCleanup, config.cleanup.intervalMs);

  logger.info("Cleanup scheduler started", {
    intervalMs: config.cleanup.intervalMs,
    retentionPeriodMs: config.cleanup.retentionPeriodMs,
    action: config.cleanup.action,
  });
}

/**
 * Run cleanup process
 */
async function runCleanup(): Promise<void> {
  if (!config?.cleanup.enabled) return;

  try {
    logger.debug("Running email cleanup");

    // Get all processed (seen) emails
    const uids = await getProcessedEmailUids();

    if (uids.length === 0) {
      logger.debug("No processed emails to clean up");
      return;
    }

    // For now, clean up all seen emails (simpler approach)
    // In production, you might want to track when emails were marked seen
    const { action } = config.cleanup;

    let cleanedCount = 0;
    if (action === "trash") {
      cleanedCount = await moveToTrash(uids);
    } else {
      cleanedCount = await deleteEmails(uids);
    }

    logger.info("Email cleanup completed", { cleanedCount });
  } catch (error) {
    logger.error("Email cleanup failed", { error: String(error) });
  }
}

/**
 * Initialize the email listener skill
 */
export async function initialize(customConfigPath?: string): Promise<void> {
  logger.info("Initializing email listener skill");

  // Initialize processed message tracker
  await initializeTracker();

  // Load configuration
  config = await loadConfig(customConfigPath);

  // Initialize commands
  initializeCommands();

  // Check if using AgentMail or IMAP
  if (process.env.AGENTMAIL_API_KEY) {
    logger.info("AgentMail configured, performing health check");
    try {
      const health = await healthCheckAgentMail();
      logger.info("AgentMail health check", health);
    } catch (error) {
      logger.warn("AgentMail health check failed", { error: String(error) });
    }
  } else {
    // Use traditional IMAP setup
    logger.info("AgentMail not configured, using IMAP");

    // Connect to IMAP
    await connect(config.imap);

    // Initialize SMTP transporter
    await initializeTransporter(config.imap);
  }

  logger.info("Email listener skill initialized");
}

/**
 * Start the email listener
 */
export function start(): void {
  if (!config) {
    throw new Error("Email listener not initialized");
  }

  if (isRunning) {
    logger.warn("Email listener already running");
    return;
  }

  if (!config.polling.enabled) {
    logger.info("Polling is disabled");
    return;
  }

  isRunning = true;

  // Run initial poll
  poll();

  // Set up polling interval
  pollInterval = setInterval(poll, config.polling.intervalMs);

  // Start cleanup scheduler
  startCleanupScheduler();

  logger.info("Email listener started", { intervalMs: config.polling.intervalMs });
}

/**
 * Stop the email listener
 */
export function stop(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  isRunning = false;

  // Clean up
  disconnect();
  closeTransporter();

  logger.info("Email listener stopped");
}

/**
 * Poll for new emails (AgentMail or IMAP)
 */
async function poll(): Promise<void> {
  if (!config) return;

  try {
    logger.debug("Polling for emails");

    let emails;

    // Try AgentMail first if API key is configured
    if (process.env.AGENTMAIL_API_KEY) {
      try {
        logger.debug("Using AgentMail for inbox polling");
        emails = await pollAgentMailInbox();
      } catch (error) {
        logger.warn("AgentMail polling failed, falling back to IMAP", {
          error: String(error),
        });
        emails = await pollInbox(config.imap);
      }
    } else {
      // Use IMAP if AgentMail not configured
      emails = await pollInbox(config.imap);
    }

    for (const email of emails) {
      await processEmail(email);
    }

    logger.debug("Poll complete", { emailsProcessed: emails.length });
  } catch (error) {
    logger.error("Poll failed", { error: String(error) });
  }
}

/**
 * Process a single email
 */
async function processEmail(email: ParsedEmail): Promise<void> {
  if (!config) return;

  // Check if this email has already been processed
  if (isProcessed(email.messageId)) {
    logger.debug("Email already processed, skipping", {
      messageId: email.messageId,
      subject: email.subject,
    });
    return;
  }

  // Skip emails with X-AgentMail-Response header (self-generated feedback loop prevention)
  if (email.headers?.["x-agentmail-response"] === "true") {
    logger.debug("Skipping self-generated email (has X-AgentMail-Response header)", {
      messageId: email.messageId,
      subject: email.subject,
    });
    return;
  }

  try {
    logger.info("Processing email", {
      from: email.sender,
      subject: email.subject,
      messageId: email.messageId,
    });

    // Classify the message
    const classified = classifyMessage(email, config);

    // Handle based on type
    switch (classified.type) {
      case "command":
        await handleCommand(email, classified);
        break;

      case "unauthorized":
        await handleUnauthorized(email);
        break;

      case "confirmation":
        await handleConfirmation(email);
        break;

      case "normal":
        logger.info("Normal email - no action needed");
        break;

      case "freeform":
        await handleFreeform(email);
        break;
    }

    // Mark as processed after successful handling
    await markAsProcessed(email.messageId);
  } catch (error) {
    logger.error("Failed to process email", {
      error: String(error),
      messageId: email.messageId,
    });
  }
}

/**
 * Handle a command email
 */
async function handleCommand(
  email: ParsedEmail,
  classified: ClassifiedMessage
): Promise<void> {
  if (!config || !classified.command) return;

  const requiresConfirmation = config.security.requireConfirmation.includes(classified.command);

  if (requiresConfirmation) {
    // Send confirmation request
    await sendConfirmationRequest(
      config.imap,
      { sender: email.sender, messageId: email.messageId, subject: email.subject },
      classified.command,
      classified.args || []
    );
    logger.info("Confirmation requested", { command: classified.command });
  } else {
    // Execute command directly
    const result = await executeCommand(
      classified.command,
      classified.args || [],
      email,
      config
    );

    // Send result
    await sendCommandResult(
      config.imap,
      { sender: email.sender, messageId: email.messageId, subject: email.subject },
      result
    );
  }
}

/**
 * Handle an unauthorized email
 */
async function handleUnauthorized(email: ParsedEmail): Promise<void> {
  if (!config) return;

  await sendUnauthorizedResponse(
    config.imap,
    email.sender,
    email.subject
  );
}

/**
 * Dispatch an intent to appropriate command
 */
async function dispatchIntent(
  intent: ParsedIntent,
  email: ParsedEmail,
  cfg: EmailListenerConfig
): Promise<CommandResult> {
  switch (intent.action) {
    case "CREATE_TASK":
      return executeCommand(
        "CREATE_TASK",
        [
          intent.params.taskTitle ?? email.subject,
          intent.params.taskPriority ?? "medium",
          ...(intent.params.taskDescription ? [intent.params.taskDescription] : []),
        ],
        email,
        cfg
      );
    case "STATUS":
      return executeCommand("STATUS", [], email, cfg);
    case "PING":
      return executeCommand("PING", [], email, cfg);
    case "AGENT_STATUS":
      return executeCommand("AGENT_STATUS", [], email, cfg);
    case "MOVE_EMAIL":
      return {
        success: true,
        message: `Noted move request to "${intent.params.targetFolder ?? "unknown"}". Full folder management via natural language is coming soon.`,
      };
    default:
      return {
        success: false,
        message:
          "I understood your message but could not determine a specific action. Use TIM: prefix for precise commands.",
      };
  }
}

/**
 * Handle a freeform email - try intent parser first, then fallback to agent
 */
async function handleFreeform(email: ParsedEmail): Promise<void> {
  if (!config) return;

  const { agentName, messageTimeoutMs, intentParserEnabled, intentParserModel, intentConfidenceThreshold } =
    config.agent;

  // Try intent parser if enabled
  if (intentParserEnabled) {
    logger.debug("Attempting to parse intent from email");

    const intent = await parseIntent(email.subject, email.body, intentParserModel);

    if (
      intent &&
      intent.confidence >= intentConfidenceThreshold &&
      intent.action !== "UNKNOWN"
    ) {
      logger.info("Intent parsed with sufficient confidence", {
        action: intent.action,
        confidence: intent.confidence,
      });

      // Execute the intent
      const result = await dispatchIntent(intent, email, config);

      // Send response
      await sendCommandResult(
        config.imap,
        { sender: email.sender, messageId: email.messageId, subject: email.subject },
        result
      );

      return;
    }

    if (intent && intent.action === "UNKNOWN") {
      logger.debug("Intent parser returned UNKNOWN action", {
        confidence: intent.confidence,
      });
    } else if (intent) {
      logger.debug("Intent confidence below threshold", {
        confidence: intent.confidence,
        threshold: intentConfidenceThreshold,
      });
    } else {
      logger.debug("Intent parsing failed or returned null");
    }
  }

  // Fallback to subprocess
  const message = `${email.subject}\n\n${email.body}`.trim();

  logger.info("Forwarding freeform email to agent subprocess", {
    agent: agentName,
    from: email.sender,
    preview: message.substring(0, 100),
  });

  try {
    // Call openclaw agent --message
    const agentProcess = spawn(
      "openclaw",
      ["agent", "--message", message, "--agent", agentName],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    agentProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    agentProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle spawn errors (e.g., command not found)
    agentProcess.on("error", (error) => {
      logger.warn("Failed to spawn agent subprocess", {
        agent: agentName,
        error: String(error),
      });
      // Add error result to batcher instead of sending immediately
      addResult(email.messageId, email.sender, email.subject, {
        command: "AGENT_SUBPROCESS",
        success: false,
        message: `Agent subprocess failed: ${String(error)}`,
      });
    });

    // Wait for completion with timeout
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve) => {
        const timeout = setTimeout(() => {
          agentProcess.kill("SIGTERM");
          resolve({ exitCode: -1, stdout, stderr: "Timeout" });
        }, messageTimeoutMs);

        agentProcess.on("close", (code) => {
          clearTimeout(timeout);
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });
      }
    );

    if (result.exitCode === 0) {
      logger.info("Agent processed freeform email", { agent: agentName });
      addResult(email.messageId, email.sender, email.subject, {
        command: "AGENT_SUBPROCESS",
        success: true,
        message: "Agent subprocess processed message successfully",
      });
    } else {
      logger.error("Agent failed to process freeform email", {
        agent: agentName,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      addResult(email.messageId, email.sender, email.subject, {
        command: "AGENT_SUBPROCESS",
        success: false,
        message: `Agent subprocess failed with exit code ${result.exitCode}`,
      });
    }
  } catch (error) {
    logger.warn("Exception spawning agent subprocess", {
      agent: agentName,
      error: String(error),
    });
    addResult(email.messageId, email.sender, email.subject, {
      command: "AGENT_SUBPROCESS",
      success: false,
      message: `Exception spawning agent: ${String(error)}`,
    });
  }
}
async function handleConfirmation(email: ParsedEmail): Promise<void> {
  // Look up pending confirmation by sender and process
  // This would involve checking a pending confirmations map
  logger.info("Confirmation response received", { from: email.sender });
}

/**
 * Get skill status
 */
export function getStatus(): {
  running: boolean;
  config: EmailListenerConfig | null;
  commands: number;
} {
  return {
    running: isRunning,
    config,
    commands: getAllCommands().length,
  };
}

/**
 * Get available commands
 */
export function getCommands() {
  return getAllCommands();
}

// Export Inbox Management functions
export {
  getAgentInstructions,
  getConciseInstructions,
  getInboxStatus,
  verifyInboxClean,
  getActionForCategory,
  type InboxStatus,
  type VerificationResult,
  type ProcessingAction,
};

// Export Folder Management functions
export {
  ensureFolderStructure,
  listFolders,
  moveToFolder,
  archiveEmail,
  moveToSpam,
  moveToReview,
  moveToCommands,
  moveToTasks,
  moveToNotifications,
  getFolderStats,
  getDestinationFolder,
  REQUIRED_FOLDERS,
  type FolderInfo,
  type FolderStats,
};

// Export Task Creator functions
export {
  createTask,
  extractTaskFromEmail,
  getAllTasks,
  getPendingTasks,
  getTaskStats,
  exportTasksToObsidian,
  loadTasks,
  initTaskCreator,
  isTaskCreatorEnabled,
  type EmailTask,
  type CreateTaskOptions,
  type TaskPriority,
  type TaskStatus,
};

// Export Classification functions
export {
  classifyForInbox,
  getInboxCategoryName,
  type InboxCategory,
  type InboxClassification,
  type InboxAction,
};

// Export for testing
export { resetPollingState, config };

// Main entry point - always run when executed directly
// Check if this file is the main module (works with tsx, node, bun)
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return true; // No argv[1] means executed directly
  
  // Check if argv[1] contains index.ts
  return argv1.includes("index.ts") || argv1.includes("index.js");
}

if (isMainModule()) {
  // Run as standalone
  initialize()
    .then(() => {
      start();
      logger.info("Email listener running...");
    })
    .catch((error) => {
      logger.error("Failed to start email listener", { error: String(error) });
      process.exit(1);
    });

  // Handle shutdown
  process.on("SIGINT", () => {
    logger.info("Shutting down...");
    stop();
    process.exit(0);
  });
}
