/**
 * Email Listener Skill - Main Entry Point
 *
 * Provides email-based command interface for Tim (Guardian Agent).
 */

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { spawn } from "child_process";
import {
  connect,
  disconnect,
  pollInbox,
  resetPollingState,
  moveToTrash,
  deleteEmails,
  getProcessedEmailUids,
} from "./poll_inbox.js";
import { classifyMessage } from "./classify_message.js";
import {
  initializeCommands,
  executeCommand,
  getAllCommands,
} from "./execute_command.js";
import {
  sendCommandResult,
  sendUnauthorizedResponse,
  sendConfirmationRequest,
  initializeTransporter,
  closeTransporter,
} from "./send_response.js";
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

  // Load configuration
  config = await loadConfig(customConfigPath);

  // Initialize commands
  initializeCommands();

  // Connect to IMAP
  await connect(config.imap);

  // Initialize SMTP transporter
  await initializeTransporter(config.imap);

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
 * Poll for new emails
 */
async function poll(): Promise<void> {
  if (!config) return;

  try {
    logger.debug("Polling for emails");

    const emails = await pollInbox(config.imap);

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

  try {
    logger.info("Processing email", {
      from: email.sender,
      subject: email.subject,
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
 * Handle a freeform email - forward to agent
 */
async function handleFreeform(email: ParsedEmail): Promise<void> {
  if (!config) return;

  const { agentName, messageTimeoutMs } = config.agent;

  // Combine subject and body as the message
  const message = `${email.subject}\n\n${email.body}`.trim();

  logger.info("Forwarding freeform email to agent", {
    agent: agentName,
    from: email.sender,
    preview: message.substring(0, 100),
  });

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
  } else {
    logger.error("Agent failed to process freeform email", {
      agent: agentName,
      exitCode: result.exitCode,
      stderr: result.stderr,
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

// Export for testing
export { resetPollingState, config };

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
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
