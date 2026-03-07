import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the HMAC-SHA256 signature of an incoming GHL webhook request.
 * GHL signs the raw body with the webhook secret.
 */
export function verifyGHLSignature(params: {
  signature: string;
  body: string;
  secret: string;
}): boolean {
  const { signature, body, secret } = params;
  if (!signature || !secret) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (signature.length !== expected.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
