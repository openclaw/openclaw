/**
 * Email Listener Skill - Type Definitions
 *
 * Type definitions for the Tim Email Listener skill that provides
 * email-based remote command interface for FrankOS.
 */

import type { ImapSimple } from "imap-simple";

/**
 * Agent configuration for freeform messaging
 */
export interface AgentConfig {
  /** Name of the agent to forward messages to (e.g., "tim") */
  agentName: string;
  /** Whether freeform messaging is enabled */
  enableFreeform: boolean;
  /** Timeout for agent response in milliseconds */
  messageTimeoutMs: number;
  /** Whether intent parser is enabled */
  intentParserEnabled: boolean;
  /** Model to use for intent parsing */
  intentParserModel: string;
  /** Confidence threshold for intent parser (0.0 to 1.0) */
  intentConfidenceThreshold: number;
}

/**
 * Configuration for the email listener
 */
export interface EmailListenerConfig {
  /** IMAP connection settings */
  imap: ImapConfig;
  /** Security settings */
  security: SecurityConfig;
  /** Polling configuration */
  polling: PollingConfig;
  /** Command configuration */
  commands: CommandConfig;
  /** Agent configuration for freeform messaging */
  agent: AgentConfig;
  /** Cleanup configuration */
  cleanup: CleanupConfig;
  /** Response consolidation configuration */
  consolidation: ConsolidationConfig;
}

/**
 * IMAP server configuration
 */
export interface ImapConfig {
  /** IMAP host */
  host: string;
  /** IMAP port */
  port: number;
  /** Use TLS/SSL */
  secure: boolean;
  /** Username/email for authentication */
  user: string;
  /** Password or reference to secret */
  password: string;
}

/**
 * Security configuration
 */
export interface SecurityConfig {
  /** List of allowed sender email addresses */
  allowedSenders: string[];
  /** Commands that require explicit confirmation */
  requireConfirmation: string[];
  /** Confirmation timeout in milliseconds */
  confirmationTimeout: number;
}

/**
 * Polling configuration
 */
export interface PollingConfig {
  /** Polling interval in milliseconds */
  intervalMs: number;
  /** Whether polling is enabled */
  enabled: boolean;
}

/**
 * Command configuration
 */
export interface CommandConfig {
  /** List of enabled commands */
  enabled: string[];
  /** List of disabled commands */
  disabled: string[];
}

/**
 * Parsed email message
 */
export interface ParsedEmail {
  /** Unique message ID */
  messageId: string;
  /** Sender email address */
  sender: string;
  /** Sender display name */
  senderName: string;
  /** Email subject */
  subject: string;
  /** Email body (plain text) */
  body: string;
  /** Timestamp when email was received */
  timestamp: Date;
  /** Email headers (optional, for custom headers like X-AgentMail-Response) */
  headers?: Record<string, string>;
}

/**
 * Message classification types
 */
export type MessageType = "command" | "normal" | "unauthorized" | "confirmation" | "freeform";

/**
 * Classified message result
 */
export interface ClassifiedMessage {
  /** Type of message */
  type: MessageType;
  /** Parsed email data */
  email: ParsedEmail;
  /** Command name if applicable */
  command?: string;
  /** Command arguments if applicable */
  args?: string[];
}

/**
 * Risk levels for commands
 */
export type RiskLevel = "safe" | "medium" | "high";

/**
 * Command definition
 */
export interface CommandDefinition {
  /** Command name */
  name: string;
  /** Command description */
  description: string;
  /** Risk level */
  risk: RiskLevel;
  /** Handler function */
  handler: CommandHandler;
}

/**
 * Command handler function type
 */
export type CommandHandler = (
  args: string[],
  email: ParsedEmail
) => Promise<CommandResult>;

/**
 * Command execution result
 */
export interface CommandResult {
  /** Whether command succeeded */
  success: boolean;
  /** Result message */
  message: string;
  /** Optional data to include in response */
  data?: Record<string, unknown>;
}

/**
 * Intent action types that Claude can extract
 */
export type IntentAction =
  | "CREATE_TASK" | "STATUS" | "PING" | "AGENT_STATUS" | "MOVE_EMAIL" | "UNKNOWN";

/**
 * Parameters extracted for an intent action
 */
export interface IntentParams {
  taskTitle?: string;
  taskDescription?: string;
  taskPriority?: "low" | "medium" | "high" | "urgent";
  taskDueDate?: string;       // ISO date string if mentioned
  targetFolder?: string;      // for MOVE_EMAIL
  rawArgs?: string[];
}

/**
 * Parsed intent from natural language
 */
export interface ParsedIntent {
  action: IntentAction;
  confidence: number;         // 0.0 to 1.0
  reasoning: string;
  params: IntentParams;
}

/**
 * Email response
 */
export interface EmailResponse {
  /** Recipient email address */
  to: string;
  /** Email subject */
  subject: string;
  /** Response body */
  body: string;
  /** Reference to original message ID */
  inReplyTo?: string;
}

/**
 * Pending confirmation state
 */
export interface PendingConfirmation {
  /** Original command that needs confirmation */
  command: string;
  /** Original arguments */
  args: string[];
  /** Sender who needs to confirm */
  sender: string;
  /** Timestamp when confirmation was requested */
  requestedAt: Date;
  /** Message ID of the confirmation request */
  messageId: string;
}

/**
 * Email listener state
 */
export interface EmailListenerState {
  /** Whether listener is running */
  isRunning: boolean;
  /** Last poll timestamp */
  lastPoll: Date | null;
  /** Pending confirmations */
  pendingConfirmations: Map<string, PendingConfirmation>;
}

/**
 * Logger interface
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Cleanup action type
 */
export type CleanupAction = "trash" | "delete";

/**
 * Cleanup configuration
 */
export interface CleanupConfig {
  /** Whether cleanup is enabled */
  enabled: boolean;
  /** Cleanup interval in milliseconds */
  intervalMs: number;
  /** Retention period in milliseconds - emails older than this will be cleaned */
  retentionPeriodMs: number;
  /** Action to perform: move to trash or delete permanently */
  action: CleanupAction;
}

/**
 * Response consolidation configuration
 */
export interface ConsolidationConfig {
  /** Whether response consolidation is enabled */
  enabled: boolean;
  /** Interval in milliseconds between sending consolidated emails */
  intervalMs: number;
  /** Maximum number of responses to batch before forcing send */
  maxBatchSize: number;
  /** Subject prefix for consolidated emails */
  subjectPrefix: string;
}

/**
 * Processed email tracking for cleanup
 */
export interface ProcessedEmail {
  /** Message UID */
  uid: number;
  /** When email was processed */
  processedAt: Date;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Partial<EmailListenerConfig> = {
  polling: {
    intervalMs: 300000, // 5 minutes
    enabled: true,
  },
  security: {
    allowedSenders: [],
    requireConfirmation: ["DELETE", "RESTART", "SHUTDOWN"],
    confirmationTimeout: 300000, // 5 minutes
  },
  commands: {
    enabled: ["STATUS", "SECURITY_AUDIT", "CHECK_UPDATES", "MEMORY_COMPACT", "AGENT_STATUS", "CREATE_TASK"],
    disabled: [],
  },
  agent: {
    agentName: "tim",
    enableFreeform: true,
    messageTimeoutMs: 120000, // 2 minutes
    intentParserEnabled: true,
    intentParserModel: "claude-haiku-4-5-20251001",
    intentConfidenceThreshold: 0.7,
  },
  cleanup: {
    enabled: true,
    intervalMs: 3600000, // 1 hour
    retentionPeriodMs: 86400000, // 24 hours
    action: "trash",
  },
  consolidation: {
    enabled: false,
    intervalMs: 300000, // 5 minutes
    maxBatchSize: 10,
    subjectPrefix: "[Consolidated Responses]",
  },
};
