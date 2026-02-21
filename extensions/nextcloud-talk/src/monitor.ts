import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type RuntimeEnv,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type {
  CoreConfig,
  NextcloudTalkInboundMessage,
  NextcloudTalkWebhookPayload,
  NextcloudTalkWebhookServerOptions,
} from "./types.js";

const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/healthz";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function parseWebhookPayload(body: string): NextcloudTalkWebhookPayload | null {
  try {
    const data = JSON.parse(body);
    if (
      !data.type ||
      !data.actor?.type ||
      !data.actor?.id ||
      !data.object?.type ||
      !data.object?.id ||
      !data.target?.type ||
      !data.target?.id
    ) {
      return null;
    }
    return data as NextcloudTalkWebhookPayload;
  } catch {
    return null;
  }
}

function payloadToInboundMessage(
  payload: NextcloudTalkWebhookPayload,
): NextcloudTalkInboundMessage {
  // Payload doesn't indicate DM vs room; mark as group and let inbound handler refine.
  const isGroupChat = true;

  return {
    messageId: String(payload.object.id),
    roomToken: payload.target.id,
    roomName: payload.target.name,
    senderId: payload.actor.id,
    senderName: payload.actor.name ?? "",
    text: payload.object.content || payload.object.name || "",
    mediaType: payload.object.mediaType || "text/plain",
    timestamp: Date.now(),
    isGroupChat,
  };
}

export function readNextcloudTalkWebhookBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes: maxBodyBytes,
    timeoutMs: DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  });
}

export function createNextcloudTalkWebhookServer(opts: NextcloudTalkWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => void;
} {
  const { port, host, path, secret, onMessage, onError, abortSignal } = opts;
  const maxBodyBytes =
    typeof opts.maxBodyBytes === "number" &&
    Number.isFinite(opts.maxBodyBytes) &&
    opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : DEFAULT_WEBHOOK_MAX_BODY_BYTES;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await readNextcloudTalkWebhookBody(req, maxBodyBytes);

      const headers = extractNextcloudTalkHeaders(
        req.headers as Record<string, string | string[] | undefined>,
      );
      if (!headers) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing signature headers" }));
        return;
      }

      const isValid = verifyNextcloudTalkSignature({
        signature: headers.signature,
        random: headers.random,
        body,
        secret,
      });

      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const payload = parseWebhookPayload(body);
      if (!payload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload format" }));
        return;
      }

      if (payload.type !== "Create") {
        res.writeHead(200);
        res.end();
        return;
      }

      const message = payloadToInboundMessage(payload);

      res.writeHead(200);
      res.end();

      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
        }
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        if (!res.headersSent) {
          res.writeHead(408, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
        }
        return;
      }
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });
  };

  const stop = () => {
    server.close();
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stop, { once: true });
  }

  return { server, start, stop };
}

export type NextcloudTalkMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  onMessage?: (message: NextcloudTalkInboundMessage) => void | Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorNextcloudTalkProvider(
  opts: NextcloudTalkMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getNextcloudTalkRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args: unknown[]) => core.logging.getChildLogger().info(args.map(String).join(" ")),
    error: (...args: unknown[]) => core.logging.getChildLogger().error(args.map(String).join(" ")),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  if (!account.secret) {
    throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);
  }

  const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;

  const logger = core.logging.getChildLogger({
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });

  const { start, stop } = createNextcloudTalkWebhookServer({
    port,
    host,
    path,
    secret: account.secret,
    onMessage: async (message) => {
      core.channel.activity.record({
        channel: "nextcloud-talk",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      if (opts.onMessage) {
        await opts.onMessage(message);
        return;
      }
      await handleNextcloudTalkInbound({
        message,
        account,
        config: cfg,
        runtime,
        statusSink: opts.statusSink,
      });
    },
    onError: (error) => {
      logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
    },
    abortSignal: opts.abortSignal,
  });

  await start();

  const publicUrl =
    account.config.webhookPublicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  logger.info(`[nextcloud-talk:${account.accountId}] webhook listening on ${publicUrl}`);

  return { stop };
}
