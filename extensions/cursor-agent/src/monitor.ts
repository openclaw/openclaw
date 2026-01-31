/**
 * Cursor Agent monitor - processes webhook events from Cursor Agent.
 *
 * This monitor handles webhook events from Cursor's Background Agents API
 * and routes agent completion results back to OpenClaw sessions.
 */

import { registerPluginHttpRoute, normalizePluginHttpPath } from "openclaw/plugin-sdk";
import type { CursorAgentAccountConfig, CursorAgentWebhookPayload } from "./types.js";
import { getCursorAgentRuntime } from "./runtime.js";
import { verifyWebhookSignature, parseWebhookHeaders } from "./api.js";
import { getTask, updateTask } from "./task-store.js";

export type CursorAgentRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type CursorAgentMonitorOptions = {
  account: CursorAgentAccountConfig;
  accountId: string;
  config: unknown; // OpenClawConfig
  runtime: CursorAgentRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

/**
 * Monitor Cursor Agent webhook events.
 *
 * Sets up a webhook endpoint to receive status updates from Cursor Agent
 * and routes results back to OpenClaw sessions.
 */
export async function monitorCursorAgentProvider(
  options: CursorAgentMonitorOptions,
): Promise<void> {
  const { account, accountId, runtime, abortSignal, statusSink } = options;

  runtime.log?.(`Starting Cursor Agent monitor for account ${accountId}`);

  // Register webhook endpoint with the Gateway
  const webhookPath = normalizePluginHttpPath(`/cursor-agent/${accountId}/webhook`);

  try {
    registerPluginHttpRoute({
      method: "POST",
      path: webhookPath,
      handler: async (req, res) => {
        try {
          const rawBody = await getRawBody(req);
          const headers = parseWebhookHeaders(req.headers as Record<string, string>);

          // Verify webhook signature if secret is configured
          if (account.webhookSecret) {
            if (!headers.signature) {
              res.statusCode = 401;
              res.end(JSON.stringify({ error: "Missing signature" }));
              return;
            }

            if (!verifyWebhookSignature(rawBody, headers.signature, account.webhookSecret)) {
              res.statusCode = 401;
              res.end(JSON.stringify({ error: "Invalid signature" }));
              return;
            }
          }

          // Validate event type
          if (headers.event && headers.event !== "statusChange") {
            res.statusCode = 200;
            res.end(JSON.stringify({ message: "Event type not handled" }));
            return;
          }

          // Parse and process the webhook
          const payload = JSON.parse(rawBody) as CursorAgentWebhookPayload;
          await processWebhookPayload(payload, accountId, runtime, statusSink);

          res.statusCode = 200;
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          runtime.error?.(`Webhook error: ${String(error)}`);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Internal error" }));
        }
      },
    });

    runtime.log?.(`Webhook endpoint registered: ${webhookPath}`);
  } catch (error) {
    runtime.error?.(`Failed to register webhook endpoint: ${String(error)}`);
  }

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => {
      runtime.log?.("Stopping Cursor Agent monitor");
      resolve();
    });
  });
}

/**
 * Process a webhook payload from Cursor.
 */
async function processWebhookPayload(
  payload: CursorAgentWebhookPayload,
  accountId: string,
  runtime: CursorAgentRuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number }) => void,
): Promise<void> {
  const { id: taskId, status, summary, target, error } = payload;

  runtime.log?.(`Received webhook for task ${taskId}: status=${status}`);

  // Update status sink
  statusSink?.({ lastInboundAt: Date.now() });

  // Update task in store
  const task = getTask(taskId);
  if (task) {
    updateTask(taskId, {
      status,
      summary,
      prUrl: target?.prUrl,
      error,
    });
  }

  // Route result back to OpenClaw session
  if (status === "FINISHED" || status === "ERROR") {
    await routeResultToSession(taskId, payload, accountId, runtime);
  }
}

/**
 * Route agent result back to the original OpenClaw session.
 */
async function routeResultToSession(
  taskId: string,
  payload: CursorAgentWebhookPayload,
  accountId: string,
  runtime: CursorAgentRuntimeEnv,
): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    runtime.log?.(`No session found for task ${taskId}, skipping routing`);
    return;
  }

  const core = getCursorAgentRuntime();

  // Build response message
  let responseBody: string;
  if (payload.status === "FINISHED") {
    responseBody = formatSuccessResponse(payload);
  } else if (payload.status === "ERROR") {
    responseBody = formatErrorResponse(payload);
  } else {
    return; // Don't route intermediate statuses
  }

  runtime.log?.(`Routing result for task ${taskId} to session ${task.sessionKey}`);

  // Use the core runtime to send reply back to session
  try {
    // This will vary based on OpenClaw's actual reply API
    // For now, emit an event that can be handled by the gateway
    if ((core as any).channel?.reply?.sendReply) {
      await (core as any).channel.reply.sendReply({
        sessionKey: task.sessionKey,
        body: responseBody,
        provider: "cursor-agent",
      });
    } else {
      runtime.log?.(`Reply routing not available, logging result:\n${responseBody}`);
    }
  } catch (error) {
    runtime.error?.(`Failed to route result: ${String(error)}`);
  }
}

/**
 * Format a success response message.
 */
function formatSuccessResponse(payload: CursorAgentWebhookPayload): string {
  const lines: string[] = ["✅ **Cursor Agent Task Completed**"];

  if (payload.summary) {
    lines.push("", `**Summary:** ${payload.summary}`);
  }

  if (payload.target?.prUrl) {
    lines.push("", `**Pull Request:** ${payload.target.prUrl}`);
  }

  if (payload.target?.branchName) {
    lines.push(`**Branch:** ${payload.target.branchName}`);
  }

  if (payload.target?.url) {
    lines.push("", `[View in Cursor](${payload.target.url})`);
  }

  return lines.join("\n");
}

/**
 * Format an error response message.
 */
function formatErrorResponse(payload: CursorAgentWebhookPayload): string {
  const lines: string[] = ["❌ **Cursor Agent Task Failed**"];

  if (payload.error) {
    lines.push("", `**Error:** ${payload.error}`);
  }

  if (payload.target?.url) {
    lines.push("", `[View Details](${payload.target.url})`);
  }

  return lines.join("\n");
}

/**
 * Helper to get raw request body.
 */
async function getRawBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Standalone function to process a webhook event (for testing/manual use).
 */
export async function processWebhookEvent(
  payload: unknown,
  signature: string | null,
  secret: string,
): Promise<CursorAgentWebhookPayload | null> {
  // Get payload as string for signature verification
  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);

  // Verify webhook signature if both are provided
  if (signature && secret) {
    if (!verifyWebhookSignature(payloadString, signature, secret)) {
      throw new Error("Invalid webhook signature");
    }
  }

  // Parse payload if it's a string
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;

  return parsed as CursorAgentWebhookPayload;
}
