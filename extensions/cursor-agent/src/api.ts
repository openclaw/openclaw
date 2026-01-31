/**
 * Cursor Background Agents API client.
 *
 * API Documentation: https://cursor.com/docs/background-agent/api/
 * Dashboard: https://cursor.com/dashboard?tab=background-agents
 */

import { createHmac } from "crypto";
import type {
  CursorAgentAccountConfig,
  CursorAgentLaunchRequest,
  CursorAgentLaunchResponse,
  CursorAgentImage,
  CursorAgentStatus,
} from "./types.js";

const CURSOR_API_BASE_URL = "https://api.cursor.com/v0";

export interface LaunchAgentOptions {
  /** The task instructions for the agent */
  instructions: string;
  /** GitHub repository URL */
  repository: string;
  /** Branch name (e.g., "main") */
  branch: string;
  /** Optional images for visual context */
  images?: CursorAgentImage[];
  /** Webhook URL for status updates */
  webhookUrl?: string;
}

/**
 * Launch a Cursor Background Agent.
 *
 * @example
 * ```ts
 * const response = await launchAgentTask(account, {
 *   instructions: "Fix the bug in src/utils.ts",
 *   repository: "https://github.com/user/repo",
 *   branch: "main",
 *   webhookUrl: "https://example.com/webhooks/cursor"
 * });
 * console.log(`Agent launched: ${response.id}`);
 * ```
 */
export async function launchAgentTask(
  account: CursorAgentAccountConfig,
  options: LaunchAgentOptions,
): Promise<CursorAgentLaunchResponse> {
  if (!account.apiKey) {
    throw new Error("Cursor API key is required");
  }

  const payload: CursorAgentLaunchRequest = {
    prompt: {
      text: options.instructions,
      images: options.images,
    },
    source: {
      repository: options.repository,
      ref: options.branch,
    },
    webhookUrl: options.webhookUrl,
  };

  const response = await fetch(`${CURSOR_API_BASE_URL}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Cursor API error (${response.status})`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message || errorJson.error || errorMessage;
    } catch {
      if (errorText) {
        errorMessage = errorText;
      }
    }
    throw new Error(errorMessage);
  }

  return response.json() as Promise<CursorAgentLaunchResponse>;
}

/**
 * List all background agents.
 */
export async function listAgents(
  account: CursorAgentAccountConfig,
): Promise<Array<{ id: string; status: CursorAgentStatus; createdAt: string }>> {
  if (!account.apiKey) {
    throw new Error("Cursor API key is required");
  }

  const response = await fetch(`${CURSOR_API_BASE_URL}/agents`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cursor API error: ${error}`);
  }

  return response.json();
}

/**
 * Get agent details by ID.
 */
export async function getAgentDetails(
  account: CursorAgentAccountConfig,
  agentId: string,
): Promise<{
  id: string;
  status: CursorAgentStatus;
  summary?: string;
  target?: { branchName?: string; prUrl?: string };
}> {
  if (!account.apiKey) {
    throw new Error("Cursor API key is required");
  }

  const response = await fetch(`${CURSOR_API_BASE_URL}/agents/${agentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cursor API error: ${error}`);
  }

  return response.json();
}

/**
 * Send a follow-up message to an agent.
 */
export async function sendFollowUp(
  account: CursorAgentAccountConfig,
  agentId: string,
  message: string,
): Promise<{ success: boolean }> {
  if (!account.apiKey) {
    throw new Error("Cursor API key is required");
  }

  const response = await fetch(`${CURSOR_API_BASE_URL}/agents/${agentId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: message }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cursor API error: ${error}`);
  }

  return response.json();
}

/**
 * Verify webhook signature from Cursor.
 *
 * Cursor uses HMAC-SHA256 with the format: sha256=<hex_digest>
 *
 * @param rawBody - The raw request body as a string
 * @param signature - The X-Webhook-Signature header value
 * @param secret - Your webhook secret
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expectedSignature = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Parse webhook headers.
 */
export function parseWebhookHeaders(headers: Record<string, string | undefined>): {
  signature: string | null;
  webhookId: string | null;
  event: string | null;
  userAgent: string | null;
} {
  return {
    signature: headers["x-webhook-signature"] || null,
    webhookId: headers["x-webhook-id"] || null,
    event: headers["x-webhook-event"] || null,
    userAgent: headers["user-agent"] || null,
  };
}
