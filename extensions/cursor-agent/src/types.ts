/**
 * Type definitions for Cursor Agent integration.
 *
 * Based on Cursor Background Agents API documentation:
 * https://cursor.com/docs/background-agent/api/
 */

// Re-export plugin types
export type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelPlugin,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelToolSend,
} from "openclaw/plugin-sdk";

/**
 * Account configuration for Cursor Agent channel.
 */
export interface CursorAgentAccountConfig {
  enabled?: boolean;
  /** Cursor API key from dashboard */
  apiKey: string;
  /** Default GitHub repository URL */
  repository?: string;
  /** Default branch (e.g., "main") */
  branch?: string;
  /** Webhook URL for receiving agent status updates */
  webhookUrl?: string;
  /** Webhook secret for signature verification */
  webhookSecret?: string;
  /** Default AI model to use */
  defaultModel?: string;
  /** Default instructions prefix */
  defaultInstructions?: string;
}

/**
 * Image attachment for visual context.
 */
export interface CursorAgentImage {
  /** Base64 encoded image data */
  data: string;
  /** Image dimensions */
  dimension: {
    width: number;
    height: number;
  };
}

/**
 * Request payload for launching an agent.
 */
export interface CursorAgentLaunchRequest {
  prompt: {
    text: string;
    images?: CursorAgentImage[];
  };
  source: {
    repository: string;
    ref: string;
  };
  webhookUrl?: string;
}

/**
 * Response from launching an agent.
 */
export interface CursorAgentLaunchResponse {
  id: string;
  status: CursorAgentStatus;
  url?: string;
}

/**
 * Agent status values.
 */
export type CursorAgentStatus = "PENDING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED";

/**
 * Webhook payload for status change events.
 */
export interface CursorAgentWebhookPayload {
  event: "statusChange";
  timestamp: string;
  id: string;
  status: CursorAgentStatus;
  source: {
    repository: string;
    ref: string;
  };
  target?: {
    url?: string;
    branchName?: string;
    prUrl?: string;
  };
  summary?: string;
  error?: string;
}

/**
 * Agent task tracking for session correlation.
 */
export interface CursorAgentTask {
  id: string;
  sessionKey: string;
  accountId: string;
  instructions: string;
  repository: string;
  branch: string;
  status: CursorAgentStatus;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  prUrl?: string;
  error?: string;
}

/**
 * Webhook headers from Cursor.
 */
export interface CursorWebhookHeaders {
  "x-webhook-signature"?: string;
  "x-webhook-id"?: string;
  "x-webhook-event"?: string;
  "user-agent"?: string;
}
