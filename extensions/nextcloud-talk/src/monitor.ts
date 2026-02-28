import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import {
  createLoggerBackedRuntime,
  type RuntimeEnv,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type {
  CoreConfig,
  NextcloudTalkInboundMessage,
  NextcloudTalkWebhookHeaders,
  NextcloudTalkWebhookPayload,
  NextcloudTalkWebhookServerOptions,
} from "./types.js";

const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/healthz";
const WEBHOOK_ERRORS = {
  missingSignatureHeaders: "Missing signature headers",
  invalidBackend: "Invalid backend",
  invalidSignature: "Invalid signature",
  invalidPayloadFormat: "Invalid payload format",
  payloadTooLarge: "Payload too large",
  internalServerError: "Internal server error",
} as const;

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
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

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body?: Record<string, unknown>,
): void {
  if (body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(status);
  res.end();
}

function writeWebhookError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  writeJsonResponse(res, status, { error });
}

function validateWebhookHeaders(params: {
  req: IncomingMessage;
  res: ServerResponse;
  isBackendAllowed?: (backend: string) => boolean;
}): NextcloudTalkWebhookHeaders | null {
  const headers = extractNextcloudTalkHeaders(
    params.req.headers as Record<string, string | string[] | undefined>,
  );
  if (!headers) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
    return null;
  }
  if (params.isBackendAllowed && !params.isBackendAllowed(headers.backend)) {
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidBackend);
    return null;
  }
  return headers;
}

function verifyWebhookSignature(params: {
  headers: NextcloudTalkWebhookHeaders;
  body: string;
  secret: string;
  res: ServerResponse;
}): boolean {
  const isValid = verifyNextcloudTalkSignature({
    signature: params.headers.signature,
    random: params.headers.random,
    body: params.body,
    secret: params.secret,
  });
  if (!isValid) {
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
    return false;
  }
  return true;
}

function decodeWebhookCreateMessage(params: {
  body: string;
  res: ServerResponse;
}):
  | { kind: "message"; message: NextcloudTalkInboundMessage }
  | { kind: "ignore" }
  | { kind: "invalid" } {
  const payload = parseWebhookPayload(params.body);
  if (!payload) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
    return { kind: "invalid" };
  }
  if (payload.type !== "Create") {
    return { kind: "ignore" };
  }
  return { kind: "message", message: payloadToInboundMessage(payload) };
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
  const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
  const isBackendAllowed = opts.isBackendAllowed;
  const shouldProcessMessage = opts.shouldProcessMessage;

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
      const headers = validateWebhookHeaders({
        req,
        res,
        isBackendAllowed,
      });
      if (!headers) {
        return;
      }

      const body = await readBody(req, maxBodyBytes);

      const hasValidSignature = verifyWebhookSignature({
        headers,
        body,
        secret,
        res,
      });
      if (!hasValidSignature) {
        return;
      }

      const decoded = decodeWebhookCreateMessage({
        body,
        res,
      });
      if (decoded.kind === "invalid") {
        return;
      }
      if (decoded.kind === "ignore") {
        writeJsonResponse(res, 200);
        return;
      }

      const message = decoded.message;
      if (shouldProcessMessage) {
        const shouldProcess = await shouldProcessMessage(message);
        if (!shouldProcess) {
          writeJsonResponse(res, 200);
          return;
        }
      }

      writeJsonResponse(res, 200);

      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        writeWebhookError(res, 413, WEBHOOK_ERRORS.payloadTooLarge);
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        writeWebhookError(res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
        return;
      }
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });
  };

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      server.close();
    } catch {
      // ignore close races while shutting down
    }
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      stop();
    } else {
      abortSignal.addEventListener("abort", stop, { once: true });
    }
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
  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

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
  const expectedBackendOrigin = normalizeOrigin(account.baseUrl);
  const replayGuard = createNextcloudTalkReplayGuard({
    stateDir: core.state.resolveStateDir(process.env, os.homedir),
    onDiskError: (error) => {
      logger.warn(
        `[nextcloud-talk:${account.accountId}] replay guard disk error: ${String(error)}`,
      );
    },
  });

  const { start, stop } = createNextcloudTalkWebhookServer({
    port,
    host,
    path,
    secret: account.secret,
    isBackendAllowed: (backend) => {
      if (!expectedBackendOrigin) {
        return true;
      }
      const backendOrigin = normalizeOrigin(backend);
      return backendOrigin === expectedBackendOrigin;
    },
    shouldProcessMessage: async (message) => {
      const shouldProcess = await replayGuard.shouldProcessMessage({
        accountId: account.accountId,
        roomToken: message.roomToken,
        messageId: message.messageId,
      });
      if (!shouldProcess) {
        logger.warn(
          `[nextcloud-talk:${account.accountId}] replayed webhook ignored room=${message.roomToken} messageId=${message.messageId}`,
        );
      }
      return shouldProcess;
    },
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

  if (opts.abortSignal?.aborted) {
    return { stop };
  }
  await start();
  if (opts.abortSignal?.aborted) {
    stop();
    return { stop };
  }

  const publicUrl =
    account.config.webhookPublicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  logger.info(`[nextcloud-talk:${account.accountId}] webhook listening on ${publicUrl}`);

  return { stop };
}
