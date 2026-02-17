import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_DRIFT_S = 5 * 60; // 5 minutes

export function verifySlackSignature(params: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = params;

  if (!signature || !timestamp) {
    return false;
  }

  const ts = Number(timestamp);
  if (Number.isNaN(ts)) {
    return false;
  }

  // Replay protection
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_TIMESTAMP_DRIFT_S) {
    return false;
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(basestring).digest("hex");

  if (expected.length !== signature.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
