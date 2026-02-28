import type { Server } from "node:http";
import { createServer } from "node:http";
import type {
  CoreConfig,
  SynologyChatInboundMessage,
  SynologyChatWebhookPayload,
  SynologyChatWebhookServerOptions,
} from "./types.js";

/**
 * Creates an HTTP server to receive webhooks from Synology Chat.
 */
export function createSynologyChatWebhookServer(options: SynologyChatWebhookServerOptions): Server {
  const { port, host, path, token, onMessage, onError, abortSignal } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Only handle configured path
    if (url.pathname !== path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf-8");

      // Parse webhook payload
      let payload: SynologyChatWebhookPayload;

      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        payload = JSON.parse(body) as SynologyChatWebhookPayload;
      } else {
        // Form-urlencoded format: payload={"text":"..."}
        const params = new URLSearchParams(body);
        const payloadStr = params.get("payload");
        if (payloadStr) {
          payload = JSON.parse(payloadStr) as SynologyChatWebhookPayload;
        } else {
          // Direct form fields
          payload = {
            token: params.get("token") ?? "",
            text: params.get("text") ?? "",
            user_id: params.get("user_id") ?? undefined,
            post_id: params.get("post_id") ?? undefined,
          };
        }
      }

      // Validate token
      if (payload.token && payload.token !== token) {
        res.statusCode = 403;
        res.end("Invalid token");
        return;
      }

      // Extract message information
      const message = parseWebhookPayload(payload);
      if (!message) {
        res.statusCode = 400;
        res.end("Invalid payload");
        return;
      }

      // Respond quickly
      res.statusCode = 200;
      res.end("OK");

      // Process message asynchronously
      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      res.statusCode = 400;
      res.end(error.message);
    }
  });

  // Handle abort signal
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      server.close();
    });
  }

  server.listen(port, host, () => {
    console.log(`[synology-chat] Webhook server listening on http://${host}:${port}${path}`);
  });

  server.on("error", (err) => {
    onError?.(err);
  });

  return server;
}

/**
 * Parses a Synology Chat webhook payload into a normalized message.
 */
function parseWebhookPayload(
  payload: SynologyChatWebhookPayload,
): SynologyChatInboundMessage | null {
  // Extract text
  let text: string;
  if (payload.message?.text) {
    text = payload.message.text;
  } else if (payload.text) {
    text = payload.text;
  } else {
    return null;
  }

  // Extract sender info
  let senderId: string;
  let senderName: string;
  if (payload.user) {
    senderId = String(payload.user.user_id);
    senderName = payload.user.username ?? senderId;
  } else if (payload.user_id) {
    senderId = payload.user_id;
    senderName = senderId;
  } else {
    return null;
  }

  // Extract message ID
  const messageId = payload.post_id ?? payload.message?.post_id ?? `${Date.now()}`;

  // Extract timestamp
  const timestamp = payload.timestamp ?? payload.message?.timestamp ?? Date.now();

  // Synology Chat doesn't clearly distinguish DMs from channels in webhooks
  // We'll treat all messages as DMs for simplicity
  return {
    messageId,
    channelId: "default",
    senderId,
    senderName,
    text,
    timestamp,
    isDirectMessage: true,
    threadId: payload.message?.thread_id,
  };
}

/**
 * Provider status monitoring for Synology Chat.
 */
export function startSynologyChatProviderMonitor(params: {
  cfg: CoreConfig;
  accountId: string;
  onError?: (error: Error) => void;
  abortSignal?: AbortSignal;
}): void {
  // Synology Chat uses webhook push model, no polling needed
  // This is a no-op for webhook-based channels
  console.log(
    `[synology-chat] Provider monitor started for account ${params.accountId} (webhook mode)`,
  );
}
