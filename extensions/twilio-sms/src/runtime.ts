// Authored by: cc (Claude Code) | 2026-03-19
import http from "node:http";
import { normalizePhoneNumber } from "./allowlist.js";
import type { SmsConfig } from "./config.js";
import { handleSmsRequest, type SmsMessage } from "./webhook.js";

const INBOX_MAX = 50;

// Matches PluginRuntime["subagent"] from src/plugins/runtime/types.ts (v2026.3.13).
type SubagentRuntime = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    lane?: string;
    deliver?: boolean;
    idempotencyKey?: string;
  }) => Promise<{ runId: string }>;
};

type RuntimeLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type SmsRuntime = {
  stop: () => Promise<void>;
  getInbox: () => SmsMessage[];
};

export async function createSmsRuntime(
  config: SmsConfig,
  subagent: SubagentRuntime,
  logger: RuntimeLogger,
): Promise<SmsRuntime> {
  if (!config.skipSignatureVerification && (!config.publicUrl || !config.twilio?.authToken)) {
    throw new Error(
      "twilio-sms requires publicUrl and twilio.authToken when signature verification is enabled",
    );
  }

  const inbox: SmsMessage[] = [];

  const onMessage = (msg: SmsMessage): void => {
    // Ring-buffer: keep only the most recent INBOX_MAX messages.
    inbox.push(msg);
    if (inbox.length > INBOX_MAX) {
      inbox.shift();
    }

    const sessionKey = `sms:${normalizePhoneNumber(msg.from)}`;
    logger.info(`[twilio-sms] dispatching message to agent (session=${sessionKey})`);

    // Fire-and-forget — TwiML response already sent; errors are logged only.
    subagent
      .run({
        sessionKey,
        message: `SMS from ${msg.from}: ${msg.body}`,
        extraSystemPrompt:
          "You are receiving an SMS message. " +
          `The sender's phone number is ${msg.from}. ` +
          "Respond helpfully and concisely.",
        lane: "sms",
        deliver: false,
        idempotencyKey: `sms:${msg.messageSid}`,
      })
      .then(({ runId }) => {
        logger.info(`[twilio-sms] agent run dispatched (session=${sessionKey}, runId=${runId})`);
      })
      .catch((err: unknown) => {
        logger.error(`[twilio-sms] agent dispatch failed: ${String(err)}`);
      });
  };

  const server = http.createServer((req, res) => {
    // Only route requests that match the configured webhook path.
    const urlPath = req.url?.split("?")[0] ?? "";
    if (urlPath !== config.serve.path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    handleSmsRequest(req, res, { config, onMessage }).catch((err: unknown) => {
      logger.error(`[twilio-sms] webhook handler error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.serve.port, config.serve.bind, resolve);
    server.on("error", reject);
  });

  logger.info(
    `[twilio-sms] webhook server listening on ${config.serve.bind}:${config.serve.port}${config.serve.path}`,
  );

  return {
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    // Return a snapshot so callers can't mutate the internal buffer.
    getInbox: () => [...inbox],
  };
}
