// Authored by: cc (Claude Code) | 2026-03-18
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseQs } from "node:querystring";
import { isAllowlistedSender, normalizePhoneNumber } from "./allowlist.js";
import type { SmsConfig } from "./config.js";

// Twilio SMS payloads are small; 64 KB is a generous upper bound.
const MAX_BODY_BYTES = 64 * 1024;

export type SmsMessage = {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  receivedAt: number;
};

/**
 * Compute the Twilio HMAC-SHA1 signature for webhook validation.
 * Algorithm: HMAC-SHA1(authToken, publicUrl + sorted(key + value pairs)) → base64.
 * See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifySmsSignature(
  authToken: string,
  publicUrl: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const sortedStr = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), publicUrl);

  const computed = crypto.createHmac("sha1", authToken).update(sortedStr, "utf8").digest("base64");

  // Constant-time compare prevents timing-based signature oracle attacks.
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    // Buffers differ in length — signatures can never match.
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy(new Error("Request body too large"));
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export type HandleSmsRequestOptions = {
  config: SmsConfig;
  /** Called after the 200 response is sent; errors must be handled by caller. */
  onMessage: (msg: SmsMessage) => void;
};

/** Handle one inbound Twilio SMS POST. Responds immediately; dispatch is fire-and-forget. */
export async function handleSmsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleSmsRequestOptions,
): Promise<void> {
  const { config, onMessage } = opts;

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
    return;
  }

  const params = parseQs(rawBody) as Record<string, string>;

  // Signature verification — skipped only in dev/test with explicit opt-in.
  if (!config.skipSignatureVerification) {
    const signature = (req.headers["x-twilio-signature"] as string | undefined) ?? "";
    const publicUrl = config.publicUrl ?? "";
    const authToken = config.twilio?.authToken ?? "";

    if (!publicUrl || !authToken) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server misconfigured: publicUrl and twilio.authToken are required");
      return;
    }

    if (!verifySmsSignature(authToken, publicUrl, params, signature)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
  }

  const from = params["From"] ?? "";
  const to = params["To"] ?? "";

  // Reject messages not addressed to the configured Twilio number.
  if (config.fromNumber && normalizePhoneNumber(to) !== normalizePhoneNumber(config.fromNumber)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // Allowlist gate — applied after sig verify so spoofed numbers don't leak policy info.
  if (config.inboundPolicy === "allowlist") {
    if (!isAllowlistedSender(normalizePhoneNumber(from), config.allowFrom)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
  }

  const msg: SmsMessage = {
    from,
    to,
    body: params["Body"] ?? "",
    messageSid: params["MessageSid"] ?? "",
    receivedAt: Date.now(),
  };

  // Respond before dispatching — Twilio expects a fast acknowledgement.
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end("<Response/>");

  onMessage(msg);
}
